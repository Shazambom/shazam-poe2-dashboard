"""TDD for Feature 1 — Cheapest A->B conversion (open-path, not a cycle).

Convert reuses the EXISTING exchange graph + fill model: an open path is just a
`list[Edge]` that `arbitrage.simulate()` already knows how to walk. These tests pin the
new surface:
  * `Graph.iter_paths(start, target, max_steps)` — open-path sibling of `iter_cycles`.
  * `arbitrage._best_conversions(g, ref_value, have, want, amount, ...)` — the pure core
    that ranks open paths by output of `want`, reusing `simulate()`/`route_cap()`, and
    reports the direct-market baseline + loss.

Built on a SYNTHETIC graph so it needs no DB (mirrors how `simulate` is pure over a graph).

    python -m pytest backend/tests/test_convert.py -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import arbitrage  # noqa: E402
from app.arbitrage import Edge, Graph  # noqa: E402


def _graph():
    """chaos --x10--> exalted --x0.02--> divine  (2-hop => 0.20 div/chaos),
    plus a WORSE direct chaos --x0.15--> divine. Reference = exalted.
    Deep ladders so liquidity isn't the binding constraint (that's a separate test)."""
    s = {"gold_model": {}, "reference": "exalted", "league": "Test",
         "step_overhead_min": 0, "max_steps": 4}
    g = Graph(s)
    g.fee_table = {}

    def edge(a, b, rate, stock):
        # ladder stock is in DST units; one fat offer at `rate`.
        return Edge(a, b, "live", rate, [{"rate": rate, "stock": stock}], age_s=0.0)

    g.add(edge("chaos", "exalted", 10.0, 1_000_000))    # 1 chaos -> 10 exalted
    g.add(edge("exalted", "divine", 0.02, 1_000_000))   # 1 exalted -> 0.02 divine
    g.add(edge("chaos", "divine", 0.15, 1_000_000))     # direct, worse than 0.20
    return g


def test_iter_paths_enumerates_open_paths():
    g = _graph()
    paths = [[ (e.src, e.dst) for e in p ] for p in g.iter_paths("chaos", "divine", 4)]
    assert [("chaos", "divine")] in paths                                   # direct
    assert [("chaos", "exalted"), ("exalted", "divine")] in paths           # 2-hop
    # open paths END at target and never revisit a node.
    for p in paths:
        assert p[-1][1] == "divine"
        nodes = [p[0][0]] + [hop[1] for hop in p]
        assert len(nodes) == len(set(nodes)), "path revisited a node"


def test_iter_paths_respects_max_steps():
    g = _graph()
    # max_steps=1 admits only the single-hop direct path.
    paths = list(g.iter_paths("chaos", "divine", 1))
    assert [(e.src, e.dst) for e in paths[0]] == [("chaos", "divine")]
    assert all(len(p) <= 1 for p in paths)


def test_convert_two_hop_beats_direct():
    g = _graph()
    rv = g.ref_values()
    res = arbitrage._best_conversions(g, rv, "chaos", "divine", 100, max_steps=4)
    # 100 chaos -> 1000 exalted -> 20 divine (whole-unit floored by simulate()).
    assert res["best"]["path"] == ["chaos", "exalted", "divine"]
    assert res["best"]["out"] == 20
    # direct market: 100 chaos -> 15 divine.
    assert res["direct"]["out"] == 15
    assert res["best"]["out"] > res["direct"]["out"]
    # loss vs value-in the 2-hop path is ~0 (fair rates); direct loses value.
    assert res["best"]["loss_pct"] < 1.0
    assert res["direct"]["loss_pct"] > res["best"]["loss_pct"]


def test_convert_no_path_returns_none():
    g = _graph()
    rv = g.ref_values()
    res = arbitrage._best_conversions(g, rv, "chaos", "mirror", 100, max_steps=4)
    assert res["best"] is None
    assert res["alternatives"] == []


def test_convert_liquidity_caps_output():
    """A thin sell rung on the 2-hop route caps realized output below the notional product,
    so the direct path (deep) can win — proving convert sizes on real liquidity via simulate."""
    s = {"gold_model": {}, "reference": "exalted", "league": "Test",
         "step_overhead_min": 0, "max_steps": 4}
    g = Graph(s)
    g.fee_table = {}
    # 2-hop first leg is starved: only 50 exalted of stock => at rate 10, absorbs 5 chaos.
    g.add(Edge("chaos", "exalted", "live", 10.0, [{"rate": 10.0, "stock": 50}], age_s=0.0))
    g.add(Edge("exalted", "divine", "live", 0.02, [{"rate": 0.02, "stock": 1_000_000}], age_s=0.0))
    g.add(Edge("chaos", "divine", "live", 0.18, [{"rate": 0.18, "stock": 1_000_000}], age_s=0.0))
    rv = g.ref_values()
    res = arbitrage._best_conversions(g, rv, "chaos", "divine", 100, max_steps=4)
    # direct absorbs all 100 -> 18 divine; the thin 2-hop can only convert ~5 chaos -> 1 divine.
    assert res["best"]["path"] == ["chaos", "divine"]
    assert res["best"]["out"] == 18


def test_convert_rejects_phantom_gain_mirage():
    """The exact failure driving the real app: a HIGH-VOLUME cross-rate inconsistency
    (chaos->omen->divine) whose rate product implies a ~+100% value GAIN. A conversion can't
    create value, so it's rejected as disguised arbitrage — the honest direct market wins,
    even though the mirage 'produces' more units. (A volume floor would NOT catch this — the
    mirage is liquid; only the gain tolerance does.)"""
    s = {"gold_model": {}, "reference": "divine", "league": "Test",
         "step_overhead_min": 0, "max_steps": 4}
    g = Graph(s)
    g.fee_table = {}

    def edge(a, b, rate, stock, vol):
        return Edge(a, b, "live", rate, [{"rate": rate, "stock": stock}], age_s=0.0, vol_in_per_h=vol)

    # Honest direct market: 1 chaos -> 0.10 divine (a normal ~small-loss conversion).
    g.add(edge("chaos", "divine", 0.10, 1_000_000, 5000.0))
    # Liquid but mispriced 2-hop: implies 1 chaos -> 0.20 divine (a +100% phantom gain).
    g.add(edge("chaos", "omen", 2.0, 1_000_000, 5000.0))
    g.add(edge("omen", "divine", 0.10, 1_000_000, 5000.0))
    rv = g.ref_values()
    res = arbitrage._best_conversions(g, rv, "chaos", "divine", 1000, max_steps=4)
    assert res["best"]["path"] == ["chaos", "divine"]   # phantom-gain 2-hop rejected
    # With the tolerance lifted, the mirage reappears — proving the guard, not a graph quirk.
    loose = arbitrage._best_conversions(g, rv, "chaos", "divine", 1000, max_steps=4, max_gain_pct=1e9)
    assert loose["best"]["path"] == ["chaos", "omen", "divine"]


def test_convert_gold_value_changes_ranking():
    """Convert ranks by NET value = value of `want` received minus gold charged at the user's
    gold price (Divine per 1k gold — the slider). The same graph flips its 'best' route with the
    gold price: when gold is PRECIOUS, the gold-thrifty direct market wins; when gold is CHEAP,
    the route that spends more gold for more divine wins. This is the exact real case
    (direct 107 divine/86k gold vs omen 114 divine/585k gold). Gain-tolerance lifted to isolate
    the net-value ranking."""
    s = {"gold_model": {"base_per_order": 0, "per_unit": {}, "per_ref_unit": 0},
         "reference": "divine", "league": "Test", "step_overhead_min": 0, "max_steps": 4}
    g = Graph(s)
    g.fee_table = {"divine": 100, "omen": 290}   # gold per unit bought

    def edge(a, b, rate):
        return Edge(a, b, "live", rate, [{"rate": rate, "stock": 10_000_000}], age_s=0.0, vol_in_per_h=1000.0)

    g.add(edge("chaos", "divine", 0.107))                       # direct: 1000 -> 107 divine, ~10.7k gold
    g.add(edge("chaos", "omen", 2.0)); g.add(edge("omen", "divine", 0.057))  # 1000 -> ~114 divine, ~591k gold
    rv = g.ref_values()

    # Gold precious (1 Divine per 1k gold): the 591k-gold omen route is punished -> direct wins.
    dear = arbitrage._best_conversions(g, rv, "chaos", "divine", 1000, max_steps=4,
                                       max_gain_pct=1e9, gold_value_per_1k=1.0)
    assert dear["best"]["path"] == ["chaos", "divine"]
    assert dear["best"]["out"] == 107

    # Gold cheap (0.001 Divine per 1k gold): the extra 7 divine is worth the gold -> omen wins.
    cheap = arbitrage._best_conversions(g, rv, "chaos", "divine", 1000, max_steps=4,
                                        max_gain_pct=1e9, gold_value_per_1k=0.001)
    assert cheap["best"]["path"] == ["chaos", "omen", "divine"]
    assert cheap["best"]["out"] == 114


def test_convert_endpoint_registered_and_delegates(monkeypatch):
    """/api/convert is wired and passes have/want/amount/max_steps through to
    arbitrage.convert (tested via a stub so no DB/graph is needed)."""
    import asyncio

    from app import arbitrage, main

    assert "/api/convert" in {r.path for r in main.app.routes}

    called = {}

    def fake_convert(have, want, amount=None, max_steps=None):
        called.update(have=have, want=want, amount=amount, max_steps=max_steps)
        return {"have": have, "want": want, "amount": amount, "reference": "exalted",
                "best": None, "direct": None, "alternatives": []}

    monkeypatch.setattr(arbitrage, "convert", fake_convert)
    res = asyncio.run(main.convert_ep(have="chaos", want="divine", amount=100, max_steps=4))
    assert called == {"have": "chaos", "want": "divine", "amount": 100, "max_steps": 4}
    assert res["have"] == "chaos" and res["want"] == "divine"


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))


def test_a_route_that_delivers_nothing_is_never_a_conversion():
    """Found driving the packaged app 2026-09-17 (and identical in production 0.2.57): converting
    4 divine -> exalted returned 'divine > medveds-felling > exalted · out 0 · 100% lost' as BEST,
    with the real direct market (1,896 exalted) ranked #855. Whole-unit rounding floors a thin
    detour to 0 output — and 0 output means 0 gold, so its net value (0) beat every real route
    once gold is priced dear enough that they all net negative. Turning your stack into nothing is
    not a conversion: such paths are dropped, so the best REAL route wins even when it nets < 0."""
    s = {"gold_model": {"base_per_order": 0, "per_unit": {}, "per_ref_unit": 0},
         "reference": "exalted", "league": "Test", "step_overhead_min": 0, "max_steps": 4}
    g = Graph(s)
    g.fee_table = {"exalted": 120}            # gold per exalted bought: the direct route is gold-heavy

    def edge(a, b, rate):
        return Edge(a, b, "digest", rate, [{"rate": rate, "stock": 10_000_000}], age_s=0.0, vol_in_per_h=1000.0)

    g.add(edge("divine", "exalted", 474.0))                                   # direct: 4 -> 1,896
    g.add(edge("divine", "felling", 0.111)); g.add(edge("felling", "exalted", 34.9))   # 4 -> floor(0.44) = 0 -> 0
    rv = g.ref_values()
    res = arbitrage._best_conversions(g, rv, "divine", "exalted", 4, max_steps=4,
                                      max_gain_pct=1e9, gold_value_per_1k=0.05)       # gold dear: direct nets < 0
    assert res["best"]["path"] == ["divine", "exalted"] and res["best"]["out"] == 1896
    assert all(r["out"] > 0 for r in [res["best"]] + res["alternatives"])
