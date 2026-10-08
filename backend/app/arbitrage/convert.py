"""Cheapest A->B conversion — an open path (not a cycle) over the same graph + fill model."""
from __future__ import annotations

import math
from .. import centrality, db
from .. import settings as settings_mod
from ..currencies import registry
from . import graph
from .graph import Edge, Graph, cycle_unit, route_cap, simulate
from .routes import MAX_CANDIDATES, _edge_list_id

# Default price of gold for net-value ranking (Convert): Divine per 1000 gold. Gold's real
# worth shifts across a league, so this is user-tunable via a slider (settings.gold_value_per_1k);
# this constant is only the fallback. 0.01 divine/1k gold == a Divine is "worth" ~100k gold.
GOLD_VALUE_DIVINE_PER_1K = settings_mod.GOLD_VALUE_DIVINE_PER_1K


def _convert_path(g: Graph, path: list[Edge], amount: float, ref_value: dict[str, float],
                  have: str, want: str) -> dict | None:
    """Size one open path by `amount` capped by its liquidity (reusing route_cap/cycle_unit),
    simulate the real fills, and shape it like a route dict so the UI renderer is reused.
    `out` = whole units of `want` produced; loss is vs the committed value in the reference."""
    unit = cycle_unit(path)
    committed = (math.floor(route_cap(path, amount) / unit) * unit) if unit > 0 else 0
    if committed < 1:
        return None
    sim = simulate(g, path, committed, ref_value)
    value_in = committed * ref_value.get(have, 0.0)
    # Loss is measured against what `have` is worth in `want` — a ratio of the one value table,
    # which for a traded pair IS the market that prices it: "8 chaos for a divine when the market
    # pays 8.4" is a 4.5% loss, whatever a thin exalted market says about either of them.
    hv, wv = ref_value.get(have), ref_value.get(want)
    market = (hv / wv) if (hv and wv) else None              # want per have
    got = (sim["end_amount"] / committed) if committed else 0.0
    loss_pct = ((1.0 - got / market) * 100.0) if market else 0.0
    loss_ref = value_in * loss_pct / 100.0
    # The internal sanity cap stays on the reference cross (independent of the pair's own
    # quotes): a path whose reference value GROWS beyond tolerance is a digest inconsistency.
    value_out = sim["end_amount"] * ref_value.get(want, 0.0)
    # A recipe's gain is real (3 Aug from 1 Greater Aug), not a quote inconsistency, but only when the
    # conversion starts by using it on what you hold: the gain of those leading recipe steps is
    # divided out of the cap. A recipe met later in a path (chaos -> Greater Transmutation ->
    # disenchant -> divine) is arbitrage dressed as a conversion; it stays capped (the Arbitrage tab).
    recipe_gain = 1.0
    for e in path:
        if e.kind != "recipe":
            break
        if ref_value.get(e.src) and ref_value.get(e.dst):
            recipe_gain *= e.rate * ref_value[e.dst] / ref_value[e.src]
    gain_cross_pct = ((value_out / recipe_gain - value_in) / value_in * 100.0) if value_in else 0.0
    out = int(sim["end_amount"])
    gold = sim["gold"]
    return {
        "id": _edge_list_id(path),
        "path": [have] + [e.dst for e in path],
        "path_names": [registry.name(have)] + [registry.name(e.dst) for e in path],
        "kinds": [e.kind for e in path],
        "steps": sim["steps"],
        "in": committed, "out": out, "end_amount": sim["end_amount"],
        "hops": len(path), "full_fill": committed >= amount - 1e-9,
        "loss_ref": loss_ref, "loss_pct": loss_pct, "gain_cross_pct": gain_cross_pct,
        "gold": gold, "gold_free": gold <= 0,
        # velocity analog: output delivered per 1k gold (gold is a real, precious cost). None
        # when gold-free (ranked in its own tier above paid routes). Also gold-per-output for UI.
        "out_per_1k_gold": (out / gold * 1000) if gold > 0 else None,
        "gold_per_out": (gold / out) if out > 0 and gold > 0 else None,
        "value_ref": sim["value_ref"], "all_live": sim["all_live"], "max_age_s": sim["max_age_s"],
        "liquidity_ref": sim["liquidity_ref"], "volume_ref_per_h": sim["volume_ref_per_h"],
        "fill_hours": sim["fill_hours"],
        "uses_recipe": any(e.kind == "recipe" for e in path),
    }


def _best_conversions(g: Graph, ref_value: dict[str, float], have: str, want: str,
                      amount: float, max_steps: int | None = None,
                      max_gain_pct: float = 2.0,
                      gold_value_per_1k: float = GOLD_VALUE_DIVINE_PER_1K,
                      bridge: dict[str, float] | None = None, with_min_amount: bool = False) -> dict:
    """Rank open conversion paths have->want by NET value delivered: the value of the `want` you
    receive minus the gold spent, where gold is charged at `gold_value_per_1k` (Divine per 1k
    gold — a user-tunable price, since gold's worth shifts across a league). This makes gold a
    first-class, precious cost: a route delivering slightly more `want` for far more gold loses
    (the chaos->omen->divine '114 divine / 585k gold' path). Fully-converting routes rank above
    partial fills. Pure over (g, ref_value).

    A conversion CANNOT legitimately create value: any path implying a value GAIN beyond
    `max_gain_pct` is a cross-rate inconsistency / disguised arbitrage (belongs in the Arbitrage
    tab), so it is rejected here. Set a huge tolerance to disable (tests)."""
    if max_steps is None:
        max_steps = g.s.get("max_steps", 4)
    ref = g.s["reference"]
    gold_ref_per_1k = gold_value_per_1k * (ref_value.get("divine") or 1.0)   # Divine/1k -> ref/1k, at the one value table
    seen: dict[str, dict] = {}
    starved: list[list[Edge]] = []          # paths the amount was too small for (min_amount below)
    count = 0
    for path in g.iter_paths(have, want, max_steps):
        count += 1
        if count > MAX_CANDIDATES:
            break
        r = _convert_path(g, path, amount, ref_value, have, want)
        if with_min_amount and not _accepted(r, max_gain_pct) and len(starved) < MIN_AMOUNT_PATHS:
            starved.append(path)
        # out == 0: whole-unit rounding floored the path to nothing — not a conversion. (It also
        # costs 0 gold, so its net value of 0 used to outrank every real route that nets < 0.)
        if _accepted(r, max_gain_pct):   # + drop phantom-gain mirages
            # net value delivered = value of `want` received - gold charged at the user's price.
            r["net_ref"] = r["out"] * ref_value.get(want, 0.0) - r["gold"] / 1000.0 * gold_ref_per_1k
            seen[r["id"]] = r
    # Final tie-break: among routes that tie on fill, net value AND hop count, prefer the one
    # threading more central BRIDGE currencies (centrality.betweenness_lite) — it's likelier to
    # actually fill. Only ever decides genuine ties; net_ref/hops dominate. 0.0 when no signal.
    def _bridge_score(r: dict) -> float:
        mids = r["path"][1:-1]   # intermediate nodes (exclude have + want)
        return sum((bridge or {}).get(n, 0.0) for n in mids) / len(mids) if mids else 0.0
    ranked = sorted(seen.values(),
                    key=lambda r: (r["full_fill"], r["net_ref"], -r["hops"], _bridge_score(r)),
                    reverse=True)
    best = ranked[0] if ranked else None
    direct_edge = g.edges.get((have, want))
    if direct_edge is not None and direct_edge.kind == "recipe":
        direct_edge = direct_edge.market      # "direct" is the market; a recipe is a route
    direct = _convert_path(g, [direct_edge], amount, ref_value, have, want) if direct_edge else None
    alternatives = [r for r in ranked if best is None or r["id"] != best["id"]]
    min_amount = (_min_amount(g, starved, ref_value, have, want, max_gain_pct)
                  if with_min_amount and best is None else None)
    return {"have": have, "want": want, "amount": amount, "reference": g.s["reference"],
            "best": best, "direct": direct, "alternatives": alternatives, "min_amount": min_amount}


def _accepted(r: dict | None, max_gain_pct: float) -> bool:
    """The one rule for "this path is a conversion": it delivers a whole unit and is no phantom-gain mirage.
    The ranking and the minimum-amount search share it, so a named minimum always has a route."""
    return r is not None and r["out"] > 0 and r["gain_cross_pct"] <= max_gain_pct


MIN_AMOUNT_PATHS = 50      # how many starved paths are sized when naming the minimum
MIN_AMOUNT_DOUBLINGS = 24  # fills thin out as the amount grows; the estimate is verified and raised
MIN_AMOUNT_WALK = 8        # lots walked down past the bisection, where rounding makes acceptance bumpy


def _min_amount(g: Graph, paths: list[list[Edge]], ref_value: dict[str, float], have: str, want: str,
                max_gain_pct: float) -> int | None:
    """The smallest whole amount of `have` that buys at least one whole `want` through a route the ranking accepts
    (`_accepted`), on any of `paths`: the view says "Minimum N" instead of "No route" when the amount, not the
    market, is the problem. A path whose whole book holds less than one `want` is skipped at once (no amount
    rescues it). Each other path is sized from its quoted rates (fills only pay less), raised by doubling until it
    passes, then searched back down for the smallest passing multiple of its lot unit."""
    best: int | None = None
    for path in paths:
        unit = max(1, cycle_unit(path))
        ceiling = math.floor(route_cap(path, math.inf) / unit) * unit   # all the book can take
        if ceiling < unit or not _accepted(_convert_path(g, path, float(ceiling), ref_value, have, want), max_gain_pct):
            continue                                                 # liquidity-starved: never a conversion
        rate = 1.0                                   # top-of-ladder want per have: fills only pay less
        for e in path:
            rate *= e.rate
        if rate <= 0:
            continue
        ok = lambda a: _accepted(_convert_path(g, path, float(a), ref_value, have, want), max_gain_pct)
        amt = min(ceiling, unit * math.ceil(1.0 / (rate * unit)))
        lo = 0                                       # the largest amount known to fail
        for _ in range(MIN_AMOUNT_DOUBLINGS):
            if ok(amt):
                break
            lo, amt = amt, min(ceiling, amt * 2)
            if lo == ceiling:
                break
        else:
            continue
        if not ok(amt):
            continue
        while amt - lo > unit:                       # bisect, in lot units, down to the smallest passing amount
            mid = lo + ((amt - lo) // (2 * unit)) * unit
            if mid <= lo:
                break
            if ok(mid):
                amt = mid
            else:
                lo = mid
        # whole-unit rounding makes acceptance bumpy, so bisection can stop a lot or two high: walk the last steps
        for _ in range(MIN_AMOUNT_WALK):
            if amt - unit < unit or not ok(amt - unit):
                break
            amt -= unit
        if best is None or amt < best:
            best = amt
    return best


def convert(have: str, want: str, amount: float | None = None, max_steps: int | None = None) -> dict:
    """Cheapest way to turn `have` into `want` across the live exchange graph (open path, not a
    loop). `amount` defaults to the user's held `have`. Rides the cached graph — read-only."""
    g = graph.cached_graph()
    ref_value = g.values()
    if amount is None:
        amount = db.get_capital().get(have, 0.0) or 1.0
    gv = settings_mod.gold_value_per_1k(g.s)
    bridge = centrality.betweenness_lite(g, ref_value)
    return _best_conversions(g, ref_value, have, want, float(amount), max_steps,
                             gold_value_per_1k=gv, bridge=bridge, with_min_amount=True)
