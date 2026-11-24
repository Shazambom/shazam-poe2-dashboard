"""Route search and ranking — simple cycles starting and ending at a currency the user holds.

We size routes by the user's capital (× max_start_fraction), path liquidity and the per-step
fill-time limit, simulate the fills step by step with whole-unit rounding, then score:
  margin        = units gained in the start currency
  margin_ref    = that gain valued in the reference currency
  value_ref     = total value that passes through the loop
  gold          = modelled exchange fees (recipes are free)
  margin/1k gold= gold efficiency
Results are served either whole (find_routes) or streamed (stream_routes) through one cache.
"""

from __future__ import annotations

import json
import logging
import math
import time

from .. import cache, centrality, db, devtelemetry, digest, orderbook, pairscore
from .. import settings as settings_mod
from ..currencies import registry
from ..settings import get_settings
from . import deepscan, graph
from .graph import INF, Edge, Graph, cycle_unit, route_cap, simulate

_route_cache: dict = {}  # search key -> (ts, orderbook version, result); see _cache_get/_cache_put
ROUTE_CACHE_MAX = 32

# What arbitrage may trade from (owner, 2026-10-03): the default cash plus the market's most liquid
# currencies — a wider set of hubs than the Board's ⬢, never fewer. Other holdings stay in the Stash
# total; they just aren't capital a loop may start from.
CASH = ("chaos", "exalted", "divine")
ARBITRAGE_HUBS = 10


def arbitrage_currencies(g: Graph, ref_value: dict[str, float]) -> set[str]:
    """Arbitrage's currencies: CASH plus the top hubs by PageRank (centrality.hubs)."""
    n = max(ARBITRAGE_HUBS, settings_mod.hub_count(g.s))
    return set(CASH) | centrality.hubs(g, ref_value, n)


def _switches() -> dict:
    """The user's Stash switches as saved now (not the graph's copy of the settings), with the default."""
    s = settings_mod.get_settings()
    return {
        "choices": {
            c: v for c, v in (s.get("stash_counted") or {}).items() if v is not None
        },
        "default": settings_mod.STASH_COUNTED_BY_DEFAULT,
    }


def loop_currencies(
    g: Graph, ref_value: dict[str, float], base: set[str] | None = None
) -> set[str]:
    """THE rule for what a loop may start from (the route search and the Stash/Arbitrage ⬢ both use it):
    `base` (arbitrage's currencies by default), keeping only holdings the user counts as liquid on Stash."""
    s = {"stash_counted": _switches()["choices"]}
    return {
        c
        for c in (arbitrage_currencies(g, ref_value) if base is None else base)
        if settings_mod.stash_counted(s, c)
    }


def _edge_list_id(edges: list[Edge]) -> str:
    """Stable id for an ordered edge list (loop or open path): 'a>b|b>c', recipe hops ':r'."""
    return "|".join(
        f"{e.src}>{e.dst}" + (":r" if e.kind == "recipe" else "") for e in edges
    )


def route_pairs(route_id: str) -> list[tuple[str, str]]:
    """Exchange pairs behind a route id like 'chaos>exalted|exalted>divine|divine>chaos'."""
    pairs = []
    for hop in route_id.split("|"):
        if hop.endswith(":r") or ">" not in hop:
            continue  # recipe hops cost no request
        a, b = hop.split(">", 1)
        pairs.append((a, b))
    return pairs


def _cache_key(filters: dict | None, start_currencies: list[str] | None) -> str:
    # the Stash switches decide which loops may start: a result is only good for the switches it ran with
    return json.dumps([filters or {}, start_currencies, _switches()], sort_keys=True)


def _cache_ver():
    return (orderbook.state["version"], digest.state["last_hour"])


def _cache_get(key: str, s: dict) -> dict | None:
    """A fresh cached search result (same order-book/digest version, within routes_cache_s), or None."""
    hit = cache.get(_route_cache, key, s["routes_cache_s"], version=_cache_ver())
    return None if hit is cache.MISS else hit


def _cache_put(key: str, result: dict) -> None:
    cache.put(
        _route_cache, key, result, version=_cache_ver(), max_entries=ROUTE_CACHE_MAX
    )


def _graph_summary(g: Graph) -> dict:
    return {"nodes": len(g.adj), "edges": g.sources, "fee_table_size": len(g.fee_table)}


def _result(
    g: Graph,
    s: dict,
    f: dict,
    ref_value: dict,
    capital: dict,
    notional: bool,
    routes: list[dict],
    kept: list[dict],
    limit: int,
    deep: dict | None = None,
) -> dict:
    """The one search-result shape (served by /api/routes*, cached, and replayed by the stream)."""
    return {
        "routes": kept[:limit],
        "total_candidates": len(routes),
        "total_after_filters": len(kept),
        "graph": _graph_summary(g),
        "reference": s["reference"],
        "ref_values": ref_value,
        "capital": capital,
        "notional": notional,
        "filters": f,
        "deep_scan": deep or {},  # {loops, added, no_holding} — see deepscan.py
    }


def find_routes(
    filters: dict | None = None,
    start_currencies: list[str] | None = None,
    use_cache: bool = True,
) -> dict:
    key = _cache_key(filters, start_currencies)
    hit = _cache_get(key, get_settings()) if use_cache else None
    if hit is not None:
        return {**hit, "cached": True}
    result = _find_routes(filters, start_currencies)
    _cache_put(key, result)
    return {**result, "cached": False}


MAX_CANDIDATES = 20000  # hard ceiling on simulated cycles per search


def _velocity(
    margin_ref: float, fill_hours: float | None, gold: float, gold_price_ref: float
) -> float | None:
    """Velocity = geometric mean of net profit/hour and net profit/1k gold.

    Gold is valued at the user's slider price (`gold_price_ref` = reference value of 1 gold) and
    SUBTRACTED from the margin:
      net      = margin_ref - gold * gold_price_ref
      velocity = net / sqrt(fill_hours * gold / 1000)

    Unlike `net / fill_hours / gold` (which shrank as 1/scale when committing more capital,
    rewarding tiny trades over larger, higher-div/h loops), the geometric mean increases
    monotonically with trade size past step overhead while still rewarding both high profit/h
    and high profit/1k gold and scaling linearly in the reference currency. Gold-free loops rank
    best (INF); no turnover data -> None; a loop whose gold value exceeds its margin goes negative
    (net loss) and sinks."""
    if fill_hours is None or fill_hours <= 0:
        return None
    net = margin_ref - gold * gold_price_ref
    if gold <= 0:
        return INF if net > 0 else 0.0
    return net / math.sqrt(fill_hours * (gold / 1000.0))


def _too_slow(slowest_step_hours: float | None, max_step_minutes: float) -> bool:
    """A step past the per-step limit, or one whose market has no turnover (None: it cannot fill)."""
    return slowest_step_hours is None or slowest_step_hours * 60 > max_step_minutes


def _fits_caps(
    sim: dict,
    max_step_minutes: float,
    max_fill_hours: float,
    max_gold: float,
) -> bool:
    if max_step_minutes and _too_slow(sim["slowest_step_hours"], max_step_minutes):
        return False
    if max_fill_hours and (
        sim["fill_hours"] is None or sim["fill_hours"] > max_fill_hours
    ):
        return False
    return not (max_gold and sim["gold"] > max_gold)


def _step_cap_cycles(
    cyc: list[Edge], amount: float, unit: int, max_step_minutes: float
) -> int:
    """Analytic upper bound (with small integer-rounding cushion) on cycles that fit `max_step_minutes`."""
    scale = 1.0
    cap = amount
    for e in cyc:
        if e.kind != "recipe" and (e.vol_in_per_h or 0.0) > 0:
            cap = min(cap, (e.vol_in_per_h or 0.0) * (max_step_minutes / 60.0) / scale)
        scale *= e.rate
    return max(1, math.ceil(cap / unit) + 2)


def _route_from(
    g: Graph,
    cyc: list[Edge],
    start: str,
    held: float,
    budget: float,
    ref_value: dict[str, float],
    max_step_minutes: float = 0,
    max_fill_hours: float = 0,
    max_gold: float = 0,
) -> dict | None:
    # Size in whole tradable cycles: commit = (cycles) × (one-cycle unit), so the amount
    # always respects the trade ratios and never commits a partial lot.
    unit = cycle_unit(cyc)
    cycles = math.floor(route_cap(cyc, budget) / unit) if unit > 0 else 0
    amount = cycles * unit
    if amount < 1:
        return None
    sim = simulate(g, cyc, amount, ref_value)
    has_cap = bool(max_step_minutes or max_fill_hours or max_gold)
    can_shrink = not (max_step_minutes and sim["slowest_step_hours"] is None) and not (
        max_fill_hours and sim["fill_hours"] is None
    )
    if (
        has_cap
        and can_shrink
        and not _fits_caps(sim, max_step_minutes, max_fill_hours, max_gold)
    ):
        # Fills, turnover time and gold fees are nondecreasing in the commit, including after
        # whole-unit and recipe rounding. Find the largest whole-cycle size that fits every cap.
        lo, hi = 0, cycles
        if max_step_minutes:
            tight = min(cycles, _step_cap_cycles(cyc, amount, unit, max_step_minutes))
            if tight < cycles:
                trial_hi = simulate(g, cyc, tight * unit, ref_value)
                if _fits_caps(trial_hi, max_step_minutes, max_fill_hours, max_gold):
                    lo, sim = tight, trial_hi
                    hi = min(cycles, tight + 2)
                else:
                    hi = tight
        while hi - lo > 1:
            mid = (lo + hi) // 2
            trial = simulate(g, cyc, mid * unit, ref_value)
            if _fits_caps(trial, max_step_minutes, max_fill_hours, max_gold):
                lo, sim = mid, trial
            else:
                hi = mid
        if lo:
            cycles, amount = lo, lo * unit
    # Trim dead rounding waste: when whole-unit floor() on an expensive intermediate step leaves
    # excess start currency unused, shrink to the smallest whole-cycle commit that yields the
    # exact same `end_amount` (strictly better margin, gold, fill time, and capital monotonicity).
    if cycles > 1 and sim["end_amount"] > 0:
        target_end = sim["end_amount"]
        prev = simulate(g, cyc, (cycles - 1) * unit, ref_value)
        if prev["end_amount"] == target_end:
            lo, hi = 0, cycles - 1
            sim = prev
            while hi - lo > 1:
                mid = (lo + hi) // 2
                trial = simulate(g, cyc, mid * unit, ref_value)
                if trial["end_amount"] == target_end:
                    hi, sim = mid, trial
                else:
                    lo = mid
            cycles, amount = hi, hi * unit
    margin = sim["end_amount"] - amount
    margin_ref = margin * ref_value.get(start, 0.0)
    gold = sim["gold"]
    mp1k = (margin_ref / gold * 1000) if gold > 0 else (INF if margin_ref > 0 else 0.0)
    fh = sim["fill_hours"]
    # Gold priced by the user's slider (Divine per 1k gold -> reference per 1 gold).
    gold_price_ref = (
        settings_mod.gold_value_per_1k(g.s) * (ref_value.get("divine") or 1.0) / 1000.0
    )  # at the one value table
    velocity = _velocity(margin_ref, fh, gold, gold_price_ref)
    return {
        "id": _edge_list_id(cyc),
        "start": start,
        "start_name": registry.name(start),
        "path": [start] + [e.dst for e in cyc],
        "path_names": [registry.name(start)] + [registry.name(e.dst) for e in cyc],
        "kinds": [e.kind for e in cyc],
        "steps": sim["steps"],
        "start_amount": amount,
        "cycle_unit": unit,
        "cycles": cycles,
        "end_amount": sim["end_amount"],
        "margin": margin,
        "margin_pct": (margin / amount * 100) if amount else 0.0,
        "margin_ref": margin_ref,
        "value_ref": sim["value_ref"],
        "gold": gold,
        "margin_per_1k_gold": None if mp1k == INF else mp1k,
        "velocity": None
        if velocity == INF
        else velocity,  # margin_ref / (fill_hours × gold) × 1000
        "velocity_inf": velocity == INF,
        "profit_per_hour": (margin_ref / fh) if fh else None,
        "gold_free": gold == 0,
        "liquidity_ref": sim["liquidity_ref"],
        "volume_ref_per_h": sim[
            "volume_ref_per_h"
        ],  # slowest step's executed value/hour
        "fill_hours": sim["fill_hours"],  # sum of commit/turnover per step
        "slowest_step_hours": sim[
            "slowest_step_hours"
        ],  # worst single step: hours of ITS market's turnover
        "max_age_s": sim["max_age_s"],
        "all_live": sim["all_live"],
        "uses_recipe": any(e.kind == "recipe" for e in cyc),
        "capital_held": held,
        "pairs": [[e.src, e.dst] for e in cyc if e.kind != "recipe"],
    }


# Recommended per-step minimums, baked into the default filters (settings.py). These are
# the MIN across a route's steps, so filtering the route enforces the bar at every step.
# Users can lower them, but the UI warns them (routes below this are usually unfillable).
RECOMMENDED_MIN_LIQUIDITY_REF = 200.0
RECOMMENDED_MIN_VOLUME_REF_PER_H = 100.0


# The filters' currency amounts, written in exalted (settings.ARBITRAGE_UNIT) so a preset means the same for
# every reference currency; a route's figures are in the reference. Everything else is a ratio or a count.
CURRENCY_THRESHOLDS = (
    "min_margin_ref",
    "min_liquidity_ref",
    "min_volume_ref_per_h",
    "min_velocity",
    "min_margin_per_1k_gold",
)


def thresholds_in_reference(f: dict, ex_in_ref: float) -> dict:
    """`f` with its exalted amounts converted to the reference (1 exalted = `ex_in_ref` reference)."""
    return {
        k: (v * ex_in_ref if k in CURRENCY_THRESHOLDS and v else v)
        for k, v in f.items()
    }


# Under-the-hood AS-Hill commit-size margin scaling: larger commits need a smaller percentage
# margin to yield meaningful absolute profit, while volatile markets keep a higher floor.
MARGIN_SCALE_HALF_DIV = 200.0
MARGIN_SCALE_POWER = 0.65
MARGIN_SCALE_FLOOR_FRAC = 0.25
MARGIN_SCALE_VOL_COEFF = 20.0


def _effective_min_margin_pct(
    base_pct: float,
    commit_div: float,
    worst_range_24h: float = 1.0,
) -> float:
    """AS-Hill effective min_margin_pct for a loop committing `commit_div` Divines.

    Decays smoothly from `base_pct` toward `floor` via a Hill (log-logistic) curve bounded below
    by `max(0.25 * base_pct, 20 * ln(worst_range_24h))`. Small commits keep nearly the full
    `base_pct`; volatile loops hold a higher floor regardless of size.
    """
    if base_pct <= 0 or commit_div <= 0:
        return base_pct
    vol_floor = (
        MARGIN_SCALE_VOL_COEFF * math.log(worst_range_24h)
        if worst_range_24h > 1.0
        else 0.0
    )
    floor = min(base_pct, max(MARGIN_SCALE_FLOOR_FRAC * base_pct, vol_floor))
    return floor + (base_pct - floor) / (
        1.0 + (commit_div / MARGIN_SCALE_HALF_DIV) ** MARGIN_SCALE_POWER
    )


def _route_min_margin_pct(
    r: dict,
    base_pct: float,
    ref_value: dict[str, float] | None,
    range_24h: dict[tuple[str, str], float] | None,
) -> float:
    if base_pct <= 0 or not ref_value:
        return base_pct
    div_ref = ref_value.get("divine") or 0.0
    if div_ref <= 0:
        return base_pct
    commit_div = (
        (r.get("start_amount") or 0.0)
        * ref_value.get(r.get("start", ""), 0.0)
        / div_ref
    )
    if commit_div <= 0:
        return base_pct
    worst_r24 = 1.0
    if range_24h:
        for pair in r.get("pairs") or ():
            a, b = pair[0], pair[1]
            canon = (a, b) if a < b else (b, a)
            rng = range_24h.get(canon, 1.0)
            if rng > worst_r24:
                worst_r24 = rng
    return _effective_min_margin_pct(base_pct, commit_div, worst_r24)


def _route_filters(
    r: dict,
    f: dict,
    ref_value: dict[str, float] | None,
    range_24h: dict[tuple[str, str], float] | None,
) -> dict:
    """Per-route filter view with AS-Hill commit-size margin scaling applied under the hood."""
    base = f.get("min_margin_pct", -INF)
    eff = _route_min_margin_pct(r, base, ref_value, range_24h)
    return {**f, "min_margin_pct": eff} if eff != base else f


def _keep(r: dict, f: dict) -> bool:
    if r["margin_pct"] < f.get("min_margin_pct", -INF):
        return False
    if r["margin_ref"] < f.get("min_margin_ref", -INF):
        return False
    if f.get("max_gold") and r["gold"] > f["max_gold"]:
        return False
    if (
        f.get("min_margin_per_1k_gold")
        and not r["gold_free"]
        and (r["margin_per_1k_gold"] or 0) < f["min_margin_per_1k_gold"]
    ):
        return False
    if (
        f.get("min_liquidity_ref")
        and r["liquidity_ref"] is not None
        and r["liquidity_ref"] < f["min_liquidity_ref"]
    ):
        return False
    if f.get("live_only") and not r["all_live"]:
        return False
    if (
        f.get("min_volume_ref_per_h")
        and (r["volume_ref_per_h"] or 0) < f["min_volume_ref_per_h"]
    ):
        return False
    if f.get("max_fill_hours") and (
        r["fill_hours"] is None or r["fill_hours"] > f["max_fill_hours"]
    ):
        return False
    if f.get("max_step_minutes") and _too_slow(
        r.get("slowest_step_hours"), f["max_step_minutes"]
    ):
        return False
    if (
        f.get("min_velocity")
        and not r["velocity_inf"]
        and (r["velocity"] or 0) < f["min_velocity"]
    ):
        return False
    return not (f.get("exclude_recipes") and r["uses_recipe"])


def _sort_key(sort: str):
    def key(r: dict):
        if sort == "margin_per_1k_gold":
            return (
                INF
                if r["gold_free"] and r["margin_ref"] > 0
                else (r["margin_per_1k_gold"] or -INF)
            )
        if sort == "fill_hours":
            return -(r["fill_hours"] if r["fill_hours"] is not None else INF)
        if sort == "velocity":
            return (
                INF
                if r["velocity_inf"]
                else (r["velocity"] if r["velocity"] is not None else -INF)
            )
        return r.get(sort, 0) or 0

    return key


def _search_setup(filters: dict | None, start_currencies: list[str] | None):
    g = graph.cached_graph(
        volume_window_h=get_settings()["volume_window_h"]
    )  # the loop search's own window
    s = g.s
    ref_value = g.values()
    f = thresholds_in_reference(
        {**s["filters"], **(filters or {})},
        ref_value.get(settings_mod.ARBITRAGE_UNIT) or 1.0,
    )
    usable = loop_currencies(g, ref_value)
    capital = {c: q for c, q in db.get_capital().items() if c in usable}
    # A saved "Start from" arbitrage may no longer use (a hub that left the top) falls back to the holdings.
    starts = [c for c in (start_currencies or []) if c in usable] or [
        c for c, q in capital.items() if q > 0
    ]
    notional = not starts
    if notional:
        starts = [c for c in g.adj if c in usable]
    return g, s, f, ref_value, capital, starts, notional


def cycles_shortest_first(g: Graph, starts: list[str], max_steps: int, cap: int):
    """Up to `cap` simple cycles from `starts`: every 2-hop loop, then every 3-hop, … , the held currencies taking
    turns within a length. So the cap only ever cuts the longest loops, and fairly: depth-first from the first held
    currency let its 4–5-hop loops fill the whole cap, and raising max_steps SHRANK the list (QA, 2026-10-05)."""
    n = 0
    for length in range(2, max_steps + 1):
        gens = [
            (c for c in g.iter_cycles(start, length) if len(c) == length)
            for start in starts
        ]
        while gens:
            for gen in list(gens):
                cyc = next(gen, None)
                if cyc is None:
                    gens.remove(gen)
                    continue
                yield cyc
                n += 1
                if n >= cap:
                    return


def search_cycles(g: Graph, starts: list[str], max_steps: int, cap: int):
    """The cycles the loop search simulates. Under the cap (every preset: 3 steps) the original order, each held
    currency depth-first in turn, kept exactly, since the composite score ranks ties by it. Only a search the cap
    would cut (4–5 steps) switches to shortest-first, so the cap drops the longest loops, never the shorter ones."""
    original = []
    for start in starts:
        for cyc in g.iter_cycles(start, max_steps):
            original.append(cyc)
            if len(original) > cap:
                return cycles_shortest_first(g, starts, max_steps, cap)
    return iter(original)


# Skip stability/recency guards on fresh leagues or tiny fixtures
MIN_ACTIVITY_LEAGUE_HOURS = 12
MIN_ACTIVE_HOURS_24 = 6
MAX_ROUTE_EDGE_AGE_S = 3 * 3600


def _route_edge_overlay(
    g: Graph, s: dict
) -> tuple[
    dict[tuple[str, str], Edge],
    set[tuple[str, str]],
    dict[tuple[str, str], float],
]:
    """Route-only recent-flow volume floor and gentle 24h stability guard.

    Never mutates `g` or `Graph.values()` (Board, Hold, Market and Convert keep their exact graph).
    Returns `(edge_map, blocked, range_24h)` where `edge_map` holds lightweight cloned digest edges
    whose effective volume is capped at recent 6h flow when `volume_window_h > 6`, `blocked` holds
    sporadic/stale/wild-swing digest edges excluded from route search, and `range_24h` maps
    canonical pairs to their 24h price range. Fail-open when the league has fewer than
    MIN_ACTIVITY_LEAGUE_HOURS of digest history."""
    league = s.get("league") or ""
    if not league:
        return {}, set(), {}
    act = digest.pair_activity(league)
    league_hours = act.get("league_hours", 0)
    if league_hours < MIN_ACTIVITY_LEAGUE_HOURS:
        return {}, set(), {}
    vol_recent = act["vol_recent"]
    hrs_active = act["hours_active"]
    range_24h = act["range_24h"]
    use_recent_floor = (s.get("volume_window_h") or 0) > digest.ACTIVITY_RECENT_H
    min_hrs = min(MIN_ACTIVE_HOURS_24, league_hours // 2)
    wide = settings_mod.wide_spread(s)
    max_range = 2.0 * wide if wide > 0 else 0.0

    edge_map: dict[tuple[str, str], Edge] = {}
    blocked: set[tuple[str, str]] = set()
    for k, e in g.edges.items():
        if e.kind != "digest":
            continue
        a, b = k
        canon = (a, b) if a < b else (b, a)
        if (
            hrs_active.get(canon, 0) < min_hrs
            or e.age_s > MAX_ROUTE_EDGE_AGE_S
            or (max_range > 0 and range_24h.get(canon, 1.0) > max_range)
        ):
            blocked.add(k)
            continue
        if use_recent_floor:
            cur_v = e.vol_in_per_h or 0.0
            rec_v = vol_recent.get(k, 0.0)
            if rec_v < cur_v:
                edge_map[k] = Edge(
                    e.src,
                    e.dst,
                    e.kind,
                    e.rate,
                    e.ladder,
                    e.age_s,
                    e.lot,
                    rec_v,
                    e.meta,
                    e.market,
                )
    return edge_map, blocked, range_24h


def _iter_candidates(
    g: Graph,
    s: dict,
    ref_value: dict,
    capital: dict,
    starts: list[str],
    notional: bool,
    deep_stats: dict | None = None,
    cancelled=lambda: False,
    *,
    max_step_minutes: float = 0,
    max_fill_hours: float = 0,
    max_gold: float = 0,
    overlay: tuple[
        dict[tuple[str, str], Edge],
        set[tuple[str, str]],
        dict[tuple[str, str], float],
    ]
    | None = None,
):
    """Yield route dicts as the search finds them (shortest loops first, capped at MAX_CANDIDATES) — then whatever the
    whole-market deep scan adds (loops past `max_steps` or past the cap), tagged `deep`. Both go
    through `_route_from`, so a deep loop is sized, simulated, filtered and ranked like any other."""
    edge_map, blocked, _range_24h = (
        overlay if overlay is not None else _route_edge_overlay(g, s)
    )

    def size(raw_cyc: list[Edge]) -> dict | None:
        if blocked and any((e.src, e.dst) in blocked for e in raw_cyc):
            return None
        cyc = (
            [edge_map.get((e.src, e.dst), e) for e in raw_cyc] if edge_map else raw_cyc
        )
        start = cyc[0].src
        held = capital.get(start, 0.0)
        budget = (
            held * s["max_start_fraction"]
            if not notional
            else (1.0 / ref_value.get(start, 1.0) or 1.0) * 10
        )
        return _route_from(
            g,
            cyc,
            start,
            held,
            budget,
            ref_value,
            max_step_minutes,
            max_fill_hours,
            max_gold,
        )

    seen: set[str] = set()
    for cyc in search_cycles(g, starts, s["max_steps"], MAX_CANDIDATES):
        seen.add(_edge_list_id(cyc))
        r = size(cyc)
        if r is not None:
            yield r

    if cancelled():  # the page has moved on: don't start the whole-market scan
        return
    stats = {"loops": 0, "added": 0, "no_holding": 0}
    startable = set(starts)
    for loop in deepscan.deep_loops(g, ref_value):
        stats["loops"] += 1
        entries = [i for i, e in enumerate(loop) if e.src in startable]
        if not entries:
            stats["no_holding"] += 1  # profitable, but through nothing the user holds
        for i in entries:
            cyc = loop[i:] + loop[:i]  # the same loop, entered at the held currency
            if _edge_list_id(cyc) in seen:
                continue
            seen.add(_edge_list_id(cyc))
            r = size(cyc)
            if r is not None:
                r["deep"] = True
                stats["added"] += 1
                yield r
    if deep_stats is not None:
        deep_stats.update(stats)


def _canonical_cycle(r: dict) -> tuple[tuple[str, str, str], ...]:
    """Rotation-invariant identity of a directed cycle: keeps one best entry per trade."""
    steps = [(st["from"], st["to"], st["kind"]) for st in r.get("steps", ())]
    if not steps:
        return ((r.get("id", ""), "", ""),)
    return min(tuple(steps[i:] + steps[:i]) for i in range(len(steps)))


def _dedup_rotations(routes: list[dict]) -> list[dict]:
    """Keep only the highest-ranked entry rotation of each directed cycle."""
    seen: set[tuple[tuple[str, str, str], ...]] = set()
    out: list[dict] = []
    for r in routes:
        cid = _canonical_cycle(r)
        if cid in seen:
            continue
        seen.add(cid)
        out.append(r)
    return out


def _finish(
    routes: list[dict],
    f: dict,
    s: dict,
    ref_value: dict[str, float] | None = None,
    range_24h: dict[tuple[str, str], float] | None = None,
) -> tuple[list[dict], int]:
    if orderbook.BULK_EXCHANGE_ENABLED:
        pairscore.observe(routes)
    kept = [r for r in routes if _keep(r, _route_filters(r, f, ref_value, range_24h))]
    sort = f.get("sort", "score")
    weights = s.get("rank_weights", {})
    _composite_score(kept, weights)
    kept.sort(key=_sort_key(sort), reverse=True)
    deduped = _dedup_rotations(kept)
    if len(deduped) != len(kept):
        _composite_score(deduped, weights)
        deduped.sort(key=_sort_key(sort), reverse=True)
    return deduped, int(f.get("limit", 100))


def _diag(
    cached: bool,
    routes: int,
    after_filters: int,
    candidates: int,
    t0: float,
    notional: float,
    starts,
    g: Graph,
) -> None:
    """TEMPORARY DEV DIAGNOSTIC (beta channel only, through the one gate): what a route search
    returned and what it was sized from. Owner, 2026-09-23 (0.3.4-beta.2): the Arbitrage page
    "jumping between a few offerings and many"; not reproducible on a copy of the data, and
    stable is blind. Off the request thread; never raises."""
    try:
        quoted = sum(
            1 for _k, e in g.market_edges() if e.meta.get("quoted_by_volume_rule")
        )
        msg = (
            f"cached={cached} routes={routes} after_filters={after_filters} candidates={candidates} "
            f"ms={int((time.time() - t0) * 1000)} notional={bool(notional)} "
            f"starts={len(starts or ())} edges={len(g.edges)} quoted={quoted}"
        )
        devtelemetry.tlog("routes", msg)  # queues; never waits on the network
    except Exception:
        logging.getLogger(__name__).debug("route diagnostics failed", exc_info=True)


CANCEL_CHECK_EVERY = (
    50  # candidates between checks that the page still wants this search
)
PROGRESS_EVERY_S = 5.0  # a search with nothing new to send says it's alive this often (the page's idle watchdog)


def stream_routes(
    filters: dict | None = None,
    start_currencies: list[str] | None = None,
    cancelled=lambda: False,
):
    """Generator for the SSE endpoint: ('meta', …) once, ('route', r) for every route
    that passes the filters as it is discovered, then ('done', summary). The finished,
    scored result is also placed in the route cache so follow-up queries are instant.
    `cancelled()` turning true (the page closed the stream) ends it early, uncached. A search that has sent nothing
    for PROGRESS_EVERY_S yields ('progress', {}), so the page's idle watchdog never mistakes a slow search for a dead one."""
    t0 = time.time()
    g, s, f, ref_value, capital, starts, notional = _search_setup(
        filters, start_currencies
    )
    # Serve a fresh cached result as one burst instead of re-searching.
    key = _cache_key(filters, start_currencies)
    cached = _cache_get(key, s)
    if cached is not None:
        _diag(
            True,
            len(cached["routes"]),
            cached["total_after_filters"],
            cached["total_candidates"],
            t0,
            notional,
            starts,
            g,
        )
        yield (
            "meta",
            {
                "reference": cached["reference"],
                "capital": cached["capital"],
                "notional": cached["notional"],
                "graph": cached["graph"],
                "filters": cached["filters"],
            },
        )
        for r in cached["routes"]:
            yield "route", r
        yield (
            "done",
            {
                "total_candidates": cached["total_candidates"],
                "total_after_filters": cached["total_after_filters"],
                "truncated": False,
                "scores": {r["id"]: r.get("score") for r in cached["routes"]},
                "order": [r["id"] for r in cached["routes"]],
                "cached": True,
                "deep_scan": cached.get("deep_scan", {}),
            },
        )
        return
    yield (
        "meta",
        {
            "reference": s["reference"],
            "capital": capital,
            "notional": notional,
            "graph": _graph_summary(g),
            "filters": f,
        },
    )
    routes: list[dict] = []
    deep: dict = {}
    overlay = _route_edge_overlay(g, s)
    range_24h = overlay[2]
    last_sent = time.time()
    for n, r in enumerate(
        _iter_candidates(
            g,
            s,
            ref_value,
            capital,
            starts,
            notional,
            deep,
            cancelled,
            max_step_minutes=f.get("max_step_minutes", 0),
            max_fill_hours=f.get("max_fill_hours", 0),
            max_gold=f.get("max_gold", 0),
            overlay=overlay,
        ),
        1,
    ):
        if n % CANCEL_CHECK_EVERY == 0:
            if cancelled():
                return
            if time.time() - last_sent >= PROGRESS_EVERY_S:
                last_sent = time.time()
                yield "progress", {}
        routes.append(r)
        if _keep(r, _route_filters(r, f, ref_value, range_24h)):
            last_sent = time.time()
            yield "route", r
    kept, limit = _finish(routes, f, s, ref_value, range_24h)
    result = _result(g, s, f, ref_value, capital, notional, routes, kept, limit, deep)
    _cache_put(key, result)
    _diag(False, len(kept[:limit]), len(kept), len(routes), t0, notional, starts, g)
    yield (
        "done",
        {
            "total_candidates": len(routes),
            "total_after_filters": len(kept),
            "truncated": len(routes) >= MAX_CANDIDATES,
            "scores": {r["id"]: r["score"] for r in kept[:limit]},
            "order": [r["id"] for r in kept[:limit]],
            "deep_scan": deep,
        },
    )


def _find_routes(filters: dict | None, start_currencies: list[str] | None) -> dict:
    g, s, f, ref_value, capital, starts, notional = _search_setup(
        filters, start_currencies
    )
    deep: dict = {}
    overlay = _route_edge_overlay(g, s)
    range_24h = overlay[2]
    routes = list(
        _iter_candidates(
            g,
            s,
            ref_value,
            capital,
            starts,
            notional,
            deep,
            max_step_minutes=f.get("max_step_minutes", 0),
            max_fill_hours=f.get("max_fill_hours", 0),
            max_gold=f.get("max_gold", 0),
            overlay=overlay,
        )
    )
    kept, limit = _finish(routes, f, s, ref_value, range_24h)
    return _result(g, s, f, ref_value, capital, notional, routes, kept, limit, deep)


def _composite_score(routes: list[dict], weights: dict) -> None:
    """Rank-normalised weighted score in [0, 1]. Each metric contributes
    weight × (1 - rank/n), so the best on a metric gets the full weight."""
    if not routes:
        return
    n = len(routes)
    w_vel = weights.get("velocity", 0.5)
    w_eff = weights.get("margin_per_1k_gold", 0.2)
    w_val = weights.get("margin_ref", 0.2)
    w_vol = weights.get("volume", 0.1)
    total = (w_vel + w_eff + w_val + w_vol) or 1.0

    def ranks(key) -> dict[str, float]:
        order = sorted(routes, key=key, reverse=True)
        return {r["id"]: 1 - i / n for i, r in enumerate(order)}

    eff = ranks(
        lambda r: (
            INF
            if r["gold_free"] and r["margin_ref"] > 0
            else (r["margin_per_1k_gold"] or -INF)
        )
    )
    val = ranks(lambda r: r["margin_ref"])
    # Unknown volume ranks worst (−INF), consistent with the min_volume filter which
    # treats None as 0 — previously None ranked best (INF), contradicting the filter.
    vol = ranks(
        lambda r: r["volume_ref_per_h"] if r["volume_ref_per_h"] is not None else -INF
    )
    vel = ranks(
        lambda r: (
            INF
            if r["velocity_inf"]
            else (r["velocity"] if r["velocity"] is not None else -INF)
        )
    )
    for r in routes:
        r["score"] = round(
            (
                w_vel * vel[r["id"]]
                + w_eff * eff[r["id"]]
                + w_val * val[r["id"]]
                + w_vol * vol[r["id"]]
            )
            / total,
            4,
        )
        r["score_parts"] = {
            "velocity": round(vel[r["id"]], 3),
            "efficiency": round(eff[r["id"]], 3),
            "value": round(val[r["id"]], 3),
            "volume": round(vol[r["id"]], 3),
        }
