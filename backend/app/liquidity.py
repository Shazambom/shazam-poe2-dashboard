"""Ghost Wealth — realizable-vs-paper value ("can I actually cash this out?").

A price site shows what one unit is *worth*; it does not tell you whether the market will
absorb your whole stack. `realizable()` answers honestly by SELLING the full held quantity
into the exchange along the best cash-out path (into the reference currency), net of gold,
and reporting the resulting slippage, fill time, and confidence. The gap between paper and
realizable value is the **ghost**: wealth you can see but can't (currently) get.

This is almost pure reuse of the Convert machinery: cashing out X is just the best conversion
of the full stack `X -> reference`. So it rides `arbitrage._best_conversions` /`simulate()` /
`Edge.fill` — the same tested ladder walk — rather than re-deriving fills or gold.

Pure over (graph, ref_value): no DB, no network, no sidecar. `liquidity` imports `arbitrage`;
`arbitrage` never imports `liquidity` (no cycle).
"""
from __future__ import annotations

from . import arbitrage, centrality, settings
from .currencies import registry


def cash_set(g: "arbitrage.Graph", ref_value: dict[str, float]) -> set[str]:
    """The liquid, cash-like currencies: the market's HUBS — the same top-`hub_count` currencies
    by executed value that the Board lights with a ⬢ (centrality.hubs). These ARE realizable
    wealth (a player doesn't "cash out" a hub, they already hold liquid value), so they realize
    at paper. Derived, not hardcoded — it tracks the `hub_count` setting and the live market,
    so as the economy shifts (or the user retunes the threshold) the cash set follows."""
    return centrality.hubs(g, ref_value, settings.hub_count(g.s))


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
    # Paper value through the holding's OWN market against the reference when it has one
    # (price_in), not a multi-hop cross — the cap below compares realizable against this, so a
    # cross-inflated paper would show fake ghost and a deflated one would truncate realizable.
    px = g.price_in(currency, ref, ref_value) if currency != ref else 1.0
    paper = qty * px if px else None
    if cash is None:
        cash = cash_set(g, ref_value)

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

    # Sell into whichever cash currency (or the reference) nets the most, valued in the reference.
    # net_ref is reference-denominated for every target, so comparing across targets is fair.
    best = None
    for target in dict.fromkeys((*sorted(cash), ref)):
        if target == currency:
            continue
        cand = arbitrage._best_conversions(g, ref_value, currency, target, float(qty),
                                           gold_value_per_1k=gold_value_per_1k)["best"]
        if cand is not None and (best is None or cand["net_ref"] > best["net_ref"]):
            best = cand
    if best is None:                                       # no exchange market to measure against
        return {"paper_ref": paper, "realizable_ref": None, "ghost_ref": None,
                "slippage_pct": None, "fill_hours": None, "source": "none",
                "full_fill": False, "path": None}

    realizable_ref = best["net_ref"]                       # already reference-denominated, net of gold
    # You can't realize MORE than paper by cashing out — any apparent surplus is a cross-rate
    # inconsistency (the convert ranker tolerates ±max_gain_pct of noise) i.e. disguised
    # arbitrage, which belongs in the Arbitrage tab, not a "what can I cash out" number. Cap at
    # paper so ghost is never negative.
    if paper is not None:
        realizable_ref = min(realizable_ref, paper)
    ghost = (paper - realizable_ref) if paper is not None else None
    return {"paper_ref": paper, "realizable_ref": realizable_ref, "ghost_ref": ghost,
            "slippage_pct": best["loss_pct"], "fill_hours": best["fill_hours"],
            "source": _source(best["kinds"]), "full_fill": best["full_fill"],
            "path": best["path"]}


def capital_rows(caps: dict[str, float], g: "arbitrage.Graph", ref_value: dict[str, float]) -> dict:
    """The /api/capital payload: every holding priced at paper AND at what it would realize
    (Ghost Wealth), plus the totals. Pure over (caps, graph, ref_value)."""
    gv = settings.gold_value_per_1k(g.s)
    cash = cash_set(g, ref_value)          # hub currencies = cash-like; derived once (PageRank)
    rows = []
    for c, q in caps.items():
        px = g.price_in(c, g.s["reference"], ref_value) if c != g.s["reference"] else 1.0
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
