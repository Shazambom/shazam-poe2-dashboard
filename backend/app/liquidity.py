"""Ghost Wealth — realizable-vs-paper value ("can I actually cash this out?").

A price site shows what one unit is *worth*; it does not tell you whether the market will
absorb your whole stack. `realizable()` answers honestly by SELLING the full held quantity
into the exchange along the best cash-out path (into the reference currency), net of gold,
and reporting the resulting slippage, fill time, and confidence. The gap between paper and
realizable value is the **ghost**: wealth you can see but can't (currently) get.

This is almost pure reuse of the Convert machinery: cashing out X is just the best conversion
of the full stack `X -> reference`. So it rides `arbitrage._best_conversions` /`simulate()` /
`Edge.fill` — the same tested ladder walk — rather than re-deriving fills or gold.

`ref_value` is THE value table (`Graph.values()`) — the same one the Board, cards and wealth use,
so a holding's paper value is the price shown everywhere else. Pure over (graph, ref_value): no
DB, no network, no sidecar. `liquidity` imports `arbitrage`;
`arbitrage` never imports `liquidity` (no cycle).
"""
from __future__ import annotations

import math

from . import arbitrage, centrality, settings
from .currencies import registry


# Two real hub markets of one holding disagree by a few % (a cranium's Chaos and Divine markets,
# VWAP hours, spreads), so an honest one-hop sale can read as a small "gain" against the holding's
# price. The convert ranker's 2% phantom-gain cap would throw those sales out; cash-out tolerates
# this much instead, caps every sale at paper, and only ever passes through CASH markets — a
# detour through a thin non-cash market (the stale "gains" this cap exists for) is arbitrage.
CROSS_TOLERANCE_PCT = 10.0


def cash_set(g: "arbitrage.Graph", ref_value: dict[str, float]) -> set[str]:
    """The liquid, cash-like currencies: the market's HUBS — the same top-`hub_count` currencies
    by executed value that the Board lights with a ⬢ (centrality.hubs). These ARE realizable
    wealth (a player doesn't "cash out" a hub, they already hold liquid value), so they realize
    at paper. Derived, not hardcoded — it tracks the `hub_count` setting and the live market,
    so as the economy shifts (or the user retunes the threshold) the cash set follows."""
    return centrality.hubs(g, ref_value, settings.hub_count(g.s))


def _whole_units_out(cand: dict) -> int:
    """What a path delivers when every hop pays out WHOLE units (you can't receive 15.71 Divine
    for a cranium — you get 15, and sell those). The convert simulation floors only the end, so a
    detour through a fractional middle leg can look like it beats the direct sale."""
    amt = float(cand["in"])                     # the committed stack (a thin book strands the rest)
    for st in cand["steps"]:
        amt = math.floor(amt * st["out"] / st["in"] + 1e-9) if st["in"] else 0
    return int(amt)


def _liquid(g: "arbitrage.Graph", cand: dict) -> bool:
    """Whether a cash-out path goes through markets that actually trade: every leg clears the
    route filters' minimum traded value per hour and the stack fills within their maximum hours
    (the same guards Arbitrage applies; unset = no guard). Liquid paths are PREFERRED over
    illiquid ones rather than the only ones allowed — a holding too big for its market still has
    an honest answer (a long fill time and a ghost), and reporting "no market data" for it was
    wrong: there is market data."""
    f = g.s.get("filters") or {}
    min_vol, max_fill = f.get("min_volume_ref_per_h") or 0.0, f.get("max_fill_hours") or 0.0
    if min_vol and (cand["volume_ref_per_h"] or 0.0) < min_vol:
        return False
    if max_fill and (cand["fill_hours"] is None or cand["fill_hours"] > max_fill):
        return False
    return True


def _source(kinds: list[str]) -> str:
    """Confidence label for a cash-out path from its edge kinds: a live book is trustworthy;
    a path leaning on a digest (historical) rate is lower-confidence."""
    if all(k == "live" for k in kinds):
        return "live"
    if any(k == "digest" for k in kinds):
        return "digest"
    return "mixed"


def realizable(g: "arbitrage.Graph", ref_value: dict[str, float], currency: str, qty: float,
               *, cash: set[str] | None = None, gold_value_per_1k: float = 0.0) -> dict:
    """What `qty` of `currency` would ACTUALLY realize if cashed out now, valued in the reference.

    Cash-like holdings (the market's hubs — see `cash_set` — plus the reference) are already
    liquid wealth: they realize at paper with no conversion and no ghost. Everything else is
    sold — whole stack — into whichever cash currency nets the most (full-stack model: any
    quantity the book can't absorb is stranded and shows up as ghost, with full_fill=False),
    net of gold charged at `gold_value_per_1k` (Divine per 1k gold — the user's gold price).

    `cash` is the hub set; callers valuing many holdings pass it once (it costs a PageRank to
    derive) — omitted, it's computed from the graph.

    Returns a dict with:
      paper_ref     — qty priced at the reference (best/quoted rate), or None if unpriced
      realizable_ref— net reference value you'd receive (None if there's no market path)
      ghost_ref     — paper - realizable (None when either is unknown)
      slippage_pct  — rate/depth loss on the FILLED portion (excludes gold); stranded qty
                      surfaces via full_fill, not here
      fill_hours    — estimated time to clear the stack at recent volume
      source        — cash | live | digest | mixed | none  (confidence)
      full_fill     — whether the whole stack cleared the book
      path          — the cash-out route as a list of currency ids (None if unrealizable)
    """
    ref = g.s["reference"]
    if cash is None:
        cash = cash_set(g, ref_value)
    px = 1.0 if currency == ref else ref_value.get(currency)
    paper = qty * px if px else None

    # Cash-like holdings are realizable wealth already — no conversion, no gold, no ghost. (If
    # somehow unpriced — an empty market — we can't claim a value, so realize to null not qty.)
    if currency in cash or currency == ref:
        if paper is None:
            return {"paper_ref": None, "realizable_ref": None, "ghost_ref": None,
                    "slippage_pct": None, "fill_hours": None, "source": "none",
                    "full_fill": False, "path": None}
        return {"paper_ref": paper, "realizable_ref": paper, "ghost_ref": 0.0,
                "slippage_pct": 0.0, "fill_hours": 0.0, "source": "cash",
                "full_fill": True, "path": [currency]}

    # Sell into whichever cash currency (or the reference) nets the most VALUE, through liquid
    # cash markets only, valued by the same table as paper (net of the gold the path charges).
    rv = ref_value
    best = best_value = best_key = None
    for target in dict.fromkeys((*sorted(cash), ref)):
        if target == currency:
            continue
        res = arbitrage._best_conversions(g, rv, currency, target, float(qty),
                                          max_gain_pct=CROSS_TOLERANCE_PCT,
                                          gold_value_per_1k=gold_value_per_1k)
        worth = 1.0 if target == ref else (ref_value.get(target) or 0.0)
        for cand in ([res["best"]] if res["best"] else []) + res["alternatives"]:
            if any(n not in cash and n != ref for n in cand["path"][1:-1]):
                continue                                   # a detour through a non-cash market is arbitrage
            gold_ref = cand["out"] * rv.get(target, 0.0) - cand["net_ref"]
            # Ranked on what it really delivers. Clamping to paper here first made every candidate
            # at or above paper tie, and hop count alone then chose the route we display.
            value = _whole_units_out(cand) * worth - gold_ref
            key = (_liquid(g, cand), cand["full_fill"], value, -cand["hops"])
            if best is None or key > best_key:
                best, best_value, best_key = cand, value, key
    if best is None:                                       # no exchange market to measure against
        return {"paper_ref": paper, "realizable_ref": None, "ghost_ref": None,
                "slippage_pct": None, "fill_hours": None, "source": "none",
                "full_fill": False, "path": None}

    realizable_ref = best_value                            # reference-denominated, net of gold
    # You can't realize MORE than paper by cashing out — any apparent surplus is a cross-rate
    # inconsistency (the convert ranker tolerates ±max_gain_pct of noise) i.e. disguised
    # arbitrage, which belongs in the Arbitrage tab, not a "what can I cash out" number. Cap at
    # paper so ghost is never negative.
    if paper is not None:
        realizable_ref = min(realizable_ref, paper)
    ghost = (paper - realizable_ref) if paper is not None else None
    return {"paper_ref": paper, "realizable_ref": realizable_ref, "ghost_ref": ghost,
            "slippage_pct": max(0.0, best["loss_pct"]), "fill_hours": best["fill_hours"],
            "source": _source(best["kinds"]), "full_fill": best["full_fill"],
            "path": best["path"]}


def capital_rows(caps: dict[str, float], g: "arbitrage.Graph", ref_value: dict[str, float]) -> dict:
    """The /api/capital payload: every holding priced at paper AND at what it would realize
    (Ghost Wealth), plus the totals. Pure over (caps, graph, ref_value)."""
    gv = settings.gold_value_per_1k(g.s)
    cash = cash_set(g, ref_value)          # hub currencies = cash-like; derived once (PageRank)
    rows = []
    for c, q in caps.items():
        px = 1.0 if c == g.s["reference"] else ref_value.get(c)
        row = {"currency": c, "name": registry.name(c), "qty": q, "ref_value": px,
               "value_ref": (q * px) if px else None}
        liq = realizable(g, ref_value, c, q, cash=cash, gold_value_per_1k=gv)
        row.update(realizable_ref=liq["realizable_ref"], slippage_pct=liq["slippage_pct"],
                   fill_hours=liq["fill_hours"], source=liq["source"], full_fill=liq["full_fill"],
                   cashout_path=liq["path"])
        rows.append(row)
    total = sum(r["value_ref"] for r in rows if r["value_ref"] is not None)
    realizable_total = sum(r["realizable_ref"] for r in rows if r["realizable_ref"] is not None)
    return {"rows": rows, "total_ref": total, "realizable_total_ref": realizable_total,
            "ghost_ref": total - realizable_total, "reference": g.s["reference"]}
