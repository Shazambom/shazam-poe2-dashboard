"""TDD for Phase 2 — Ghost Wealth / "can I cash out?".

Realizable-vs-paper value: a price site shows what 1 unit is *worth*, not whether the
market will absorb your whole stack. `liquidity.realizable()` answers the honest question.

Design (owner call): Divine / Chaos / Exalted are the liquid, cash-like currencies — they ARE
realizable wealth, so they realize at paper with no conversion and no gold. Anything else is
sold — whole stack — into whichever cash currency nets the most (valued in the reference), net
of gold. Selling into the best cash currency (not the cheap reference unit) avoids the
fragment-into-22k-exalted gold blowup surfaced while driving the real app. `ghost = paper - realizable`.

It rides `arbitrage._best_conversions` / `simulate()` / `Edge.fill` — the same tested ladder
walk. Built on a SYNTHETIC graph so it needs no DB (mirrors test_convert.py).

    python -m pytest backend/tests/test_liquidity.py -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import liquidity  # noqa: E402
from app.arbitrage import Edge, Graph  # noqa: E402


def _g(reference="exalted", fee_table=None):
    s = {"gold_model": {}, "reference": reference, "league": "Test",
         "step_overhead_min": 0, "max_steps": 4}
    g = Graph(s)
    g.fee_table = fee_table or {}
    return g


def _edge(a, b, rate, stock, kind="live", vol=1000.0):
    # ladder stock is in DST units; caller can pass a single fat rung or build their own.
    return Edge(a, b, kind, rate, [{"rate": rate, "stock": stock}], age_s=0.0, vol_in_per_h=vol)


# Cash-like set is normally DERIVED from the market's hubs (see test_cash_set_derives_from_hubs);
# these logic tests pass it explicitly so they're deterministic and isolated from hub detection.
HUBS = {"divine", "chaos", "exalted"}


# --------------------------------------------------------------- cash is already liquid
def test_cash_currency_is_fully_liquid():
    """Divine/Chaos/Exalted are cash — they realize at paper with no conversion and no ghost,
    even if a lossy book for them exists (we must NOT 'sell' cash into the cheap reference)."""
    g = _g(reference="exalted")
    g.add(_edge("divine", "exalted", 30.0, 100))   # a THIN, lossy divine book that must be ignored
    rv = g.ref_values()
    r = liquidity.realizable(g, rv, "divine", 50, cash=HUBS)
    assert r["realizable_ref"] == r["paper_ref"]   # cash == paper, book ignored
    assert r["ghost_ref"] == 0.0
    assert r["slippage_pct"] == 0.0
    assert r["full_fill"] is True
    assert r["source"] == "cash"


def test_unpriced_cash_currency_realizes_null_not_qty():
    """Edge (surfaced running the frozen binary against an empty market): a cash currency with
    NO price must realize to null, never to its raw quantity — otherwise ghost goes nonsensical."""
    g = _g(reference="exalted")
    rv = {}                                         # nothing priced at all (empty market)
    r = liquidity.realizable(g, rv, "divine", 50, cash={"divine"})
    assert r["realizable_ref"] is None
    assert r["ghost_ref"] is None
    assert r["source"] == "none"


def test_reference_currency_is_fully_liquid():
    """Holdings already in the reference need no conversion — realizable == paper, no ghost."""
    g = _g(reference="exalted")
    rv = g.ref_values()
    rv["exalted"] = 1.0
    r = liquidity.realizable(g, rv, "exalted", 250, cash=set())   # reference is cash even if not a hub
    assert r["paper_ref"] == 250.0
    assert r["realizable_ref"] == 250.0
    assert r["ghost_ref"] == 0.0
    assert r["source"] == "cash"


# --------------------------------------------------------------- deep book ≈ paper
def test_deep_book_realizes_paper():
    """A non-cash holding with a deep, fairly-priced sell book cashes out at ~paper: no ghost."""
    g = _g()
    g.add(_edge("annul", "exalted", 50.0, 1_000_000))   # 1 annul -> 50 exalted, deep
    rv = g.ref_values()
    assert rv["annul"] == 50.0
    r = liquidity.realizable(g, rv, "annul", 10, cash=HUBS)
    assert r["paper_ref"] == 500.0
    assert r["realizable_ref"] == 500.0
    assert r["ghost_ref"] == 0.0
    assert r["slippage_pct"] < 1.0
    assert r["full_fill"] is True
    assert r["source"] == "live"


# --------------------------------------------------------------- thin book -> ghost
def test_thin_book_creates_ghost_and_slippage():
    """Paper is struck at the BEST rate; selling the full stack digs into worse rungs, so
    realizable < paper. The gap is ghost, shown as slippage (the whole stack sells, worse avg)."""
    g = _g()
    g.add(Edge("annul", "exalted", "live", 50.0,
               [{"rate": 50.0, "stock": 200}, {"rate": 30.0, "stock": 1_000_000}], age_s=0.0,
               vol_in_per_h=1000.0))
    rv = g.ref_values()
    assert rv["annul"] == 50.0
    r = liquidity.realizable(g, rv, "annul", 10, cash=HUBS)
    assert r["paper_ref"] == 500.0
    # 4 annul @50 = 200 exalted, 6 annul @30 = 180 exalted -> 380 realized.
    assert r["realizable_ref"] == 380.0
    assert r["ghost_ref"] == 120.0
    assert 20.0 < r["slippage_pct"] < 30.0     # (500-380)/500 = 24%
    assert r["full_fill"] is True


# --------------------------------------------------------------- stack beyond depth
def test_stack_beyond_total_depth_strands_remainder():
    """When the book can't absorb the whole stack, the unsellable remainder is pure ghost and
    full_fill is False — the honest 'if I dumped it all right now' answer."""
    g = _g()
    g.add(_edge("annul", "exalted", 50.0, 200))   # only 200 exalted stock -> absorbs 4 annul
    rv = g.ref_values()
    r = liquidity.realizable(g, rv, "annul", 10, cash=HUBS)
    assert r["paper_ref"] == 500.0
    assert r["realizable_ref"] == 200.0            # only 4 of 10 annul clear the book
    assert r["ghost_ref"] == 300.0                 # 6 stranded annul * 50
    assert r["full_fill"] is False


# --------------------------------------------------------------- gold subtracted
def test_gold_cost_lowers_realizable():
    """Cashing out charges gold; realizable is NET of gold at the user's gold price, so a higher
    gold price yields less realizable value."""
    g = _g(reference="exalted", fee_table={"exalted": 100})   # 100 gold per exalted bought
    g.add(_edge("annul", "exalted", 50.0, 1_000_000))         # 10 annul -> 500 exalted, gold=100*500
    rv = g.ref_values()
    cheap = liquidity.realizable(g, rv, "annul", 10, cash=HUBS, gold_value_per_1k=0.0)
    dear = liquidity.realizable(g, rv, "annul", 10, cash=HUBS, gold_value_per_1k=1.0)
    assert cheap["realizable_ref"] == 500.0        # gold free -> full value
    assert dear["realizable_ref"] < cheap["realizable_ref"]
    assert dear["ghost_ref"] > cheap["ghost_ref"]


def test_no_tracked_market_is_unrealizable():
    """No fake numbers: a currency with no tracked exchange market reports realizable=None
    (source 'none'), even if it has a paper price. The real fix for coverage is the metadata→trade
    bridge (test_currencies), which gives such currencies real edges — not a paper-estimate guess."""
    g = _g()
    g.add(_edge("annul", "exalted", 50.0, 1_000_000))
    rv = g.ref_values()
    rv["fracturing"] = 100_000.0                    # priced, but no edges out of it (no market)
    r = liquidity.realizable(g, rv, "fracturing", 2, cash=HUBS)
    assert r["paper_ref"] == 200_000.0             # worth is still shown
    assert r["realizable_ref"] is None             # but we do NOT fabricate a cash-out number
    assert r["ghost_ref"] is None
    assert r["source"] == "none"


# --------------------------------------------------------------- best cash target (anti-fragment)
def test_cashes_into_best_cash_currency_not_cheap_reference():
    """The core fix: a non-cash holding is sold into whichever CASH currency nets the most, NOT
    forced down to the cheap reference unit. Fragmenting into thousands of tiny exalted incurs
    huge per-unit gold; selling into Divine (few units) nets far more, so Divine wins."""
    g = _g(reference="exalted", fee_table={"exalted": 120, "divine": 120})
    g.add(_edge("annul", "exalted", 100.0, 10_000_000))   # 1 annul -> 100 exalted (fragments)
    g.add(_edge("annul", "divine", 0.2, 10_000_000))      # 1 annul -> 0.2 divine (few units)
    g.add(_edge("divine", "exalted", 500.0, 10_000_000))  # 1 divine -> 500 exalted (so annul==100 ex either way)
    rv = g.ref_values()
    assert rv["annul"] == 100.0                            # consistent value both ways; paper=1000 for 10
    r = liquidity.realizable(g, rv, "annul", 10, cash=HUBS, gold_value_per_1k=0.05)
    assert r["path"][-1] == "divine"                       # cashed into Divine, not fragmented to exalted
    assert r["realizable_ref"] > 900.0                     # ~paper (gold on 2 divine is trivial)


# --------------------------------------------------------------- realizable capped at paper
def test_realizable_never_exceeds_paper():
    """Realizable is capped at paper: any apparent surplus (a cross-rate inconsistency the convert
    ranker tolerates as noise) is disguised arbitrage, not cash-out value, so ghost stays >= 0."""
    g = _g(reference="exalted")
    g.add(_edge("annul", "divine", 1.0, 10_000_000))     # 1 annul -> 1 divine (deep)
    g.add(_edge("divine", "exalted", 50.0, 10_000_000))  # 1 divine -> 50 exalted
    # Feed a ref_value that UNDER-prices annul (49.75) vs what the annul->divine path realizes
    # (50) — a ~0.5% surplus, within the convert ranker's gain tolerance so it isn't rejected.
    rv = {"exalted": 1.0, "divine": 50.0, "annul": 49.75}
    r = liquidity.realizable(g, rv, "annul", 10, cash={"divine"})
    assert r["paper_ref"] == 497.5
    assert r["realizable_ref"] == 497.5                   # capped at paper, not the 500 the path yields
    assert r["ghost_ref"] == 0.0


# --------------------------------------------------------------- confidence source
def test_digest_edge_flags_lower_confidence():
    """A cash-out leaning on a digest (historical) edge rather than a live book is flagged."""
    g = _g()
    g.add(_edge("annul", "exalted", 50.0, 1_000_000, kind="digest"))
    rv = g.ref_values()
    r = liquidity.realizable(g, rv, "annul", 10, cash=HUBS)
    assert r["realizable_ref"] == 500.0
    assert r["source"] == "digest"


# --------------------------------------------------------------- cash = hubs (derived)
def test_cash_set_derives_from_hubs():
    """Cash-like status is DERIVED from the market's hubs (centrality), not a hardcoded currency
    list. A currency that IS the dominant hub — even a non-standard one — is treated as cash
    (realizes at paper), and a leaf that merely feeds it is not."""
    g = _g(reference="exalted")
    g.s["hub_count"] = 2                             # only the top-2 by PageRank are hubs
    # Three leaves trade into 'runegraft' at high volume -> runegraft is the dominant hub.
    for leaf in ("alpha", "beta", "gamma"):
        g.add(_edge(leaf, "runegraft", 1.0, 10_000_000))
    g.add(_edge("runegraft", "exalted", 100.0, 10_000_000))   # prices runegraft at 100 exalted
    rv = g.ref_values()
    cash = liquidity.cash_set(g, rv)                 # derived via PageRank, no hardcoding
    assert "runegraft" in cash
    # The hub realizes at paper (cash); derive cash internally (cash=None) to exercise the wiring.
    hub = liquidity.realizable(g, rv, "runegraft", 5)
    assert hub["source"] == "cash"
    assert hub["realizable_ref"] == hub["paper_ref"]
    # A leaf that merely feeds the hub is NOT cash — it gets sold.
    assert "alpha" not in cash


# --------------------------------------------------------------- endpoint back-compat
def test_capital_endpoint_enriches_rows(monkeypatch):
    """GET /api/capital gains realizable fields per row and ghost totals, without dropping any
    existing field (back-compat). Cash holdings realize at paper."""
    from app import arbitrage, db, main

    g = _g(reference="exalted")
    g.add(_edge("divine", "exalted", 50.0, 1_000_000))
    monkeypatch.setattr(arbitrage.graph, "cached_graph", lambda: g)
    monkeypatch.setattr(arbitrage, "cached_graph", lambda: g)
    monkeypatch.setattr(db, "get_capital", lambda: {"divine": 10, "exalted": 100})

    res = main.capital()
    assert res["reference"] == "exalted"
    assert "realizable_total_ref" in res and "ghost_ref" in res
    row = next(r for r in res["rows"] if r["currency"] == "divine")
    assert {"currency", "name", "qty", "ref_value", "value_ref"} <= row.keys()   # existing
    assert {"realizable_ref", "slippage_pct", "fill_hours", "source", "full_fill"} <= row.keys()
    assert row["realizable_ref"] == row["value_ref"]      # divine is cash -> realizable == paper


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
