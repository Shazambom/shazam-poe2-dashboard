"""A loop is only worth listing if every step can realistically FILL (owner, 2026-09-17).

Two rules, both born from one row: Esh's Radiance "bought for 13 chaos" (it trades at ~33 divine).
In that market NOBODY sells Radiance for chaos — standing Radiance stock is 0 in every hourly
row; there are only chaos bids, and every few hours a holder dumps one into a bid. The old code
papered over the missing sellers with `stock = hi_stock or volume`.

  1. SELLERS MUST EXIST. A digest edge a->b hands you b, so someone must be standing there
     offering b for a: the receiving side's standing stock that hour must be > 0. No stock, no
     edge — never substitute traded volume for stock.
  2. TURNOVER IS RELATIVE TO THE TRADE. A fixed ex/h floor lets "expensive but trades twice a
     day" through. Each step's share of its market = units you push in ÷ units that market
     trades per hour = hours of that market's ENTIRE turnover. Slowest step over
     `max_step_minutes` (default 45) → the loop is dropped. One slow step cannot hide behind
     two fast ones the way it can in the summed `fill_hours`.

    python -m pytest backend/tests/test_fillable_steps.py -q
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import digest, settings
from app.arbitrage import Edge, Graph, routes
from app.arbitrage.graph import simulate


def _row(**kw):
    base = {"vol_a": 1, "vol_b": 13, "hi_stock_a": 0, "hi_stock_b": 120, "hour": 0}
    return {**base, **kw}


# ---------------------------------------------------------------- 1. sellers must exist
def test_no_standing_sellers_means_no_edge_in_that_direction():
    """Radiance(a) <-> chaos(b): chaos is on offer (120), Radiance is not (0)."""
    out = digest.directed_rates("radiance", "chaos", _row(), age=60.0)
    assert set(out) == {
        ("radiance", "chaos")
    }  # you CAN sell a Radiance into the chaos bids
    assert (
        out[("radiance", "chaos")]["rate"] == 13.0
        and out[("radiance", "chaos")]["stock"] == 120
    )
    # ...but you cannot BUY one with chaos: nobody is selling. (Old code: stock = volume = 1.)


def test_both_sides_standing_gives_both_edges_with_real_stock():
    out = digest.directed_rates(
        "radiance",
        "divine",
        _row(vol_a=17, vol_b=564, hi_stock_a=39, hi_stock_b=576),
        age=60.0,
    )
    assert (
        out[("radiance", "divine")]["stock"] == 576
        and out[("divine", "radiance")]["stock"] == 39
    )
    assert out[("divine", "radiance")]["rate"] == pytest.approx(17 / 564)


def test_a_dead_market_gives_nothing():
    assert digest.directed_rates("a", "b", _row(hi_stock_b=0), age=60.0) == {}


# ---------------------------------------------------------------- 2. turnover relative to the trade
def _edge(a, b, rate, vol):
    return Edge(
        a, b, "digest", rate, [{"rate": rate, "stock": 10_000_000}], vol_in_per_h=vol
    )


def _graph(edges):
    g = Graph({"reference": "a", "step_overhead_min": 0.0, "gold_model": {}})
    g.fee_table = {}
    for e in edges:
        g.add(e)
    return g


def test_simulate_reports_the_slowest_steps_share_of_its_market():
    cyc = [
        _edge("a", "b", 1.0, 1000.0),
        _edge("b", "c", 1.0, 40.0),
        _edge("c", "a", 1.05, 1000.0),
    ]
    sim = simulate(_graph(cyc), cyc, 20, {"a": 1.0, "b": 1.0, "c": 1.0})
    assert sim["slowest_step_hours"] == pytest.approx(
        20 / 40
    )  # 20 units into a 40/h market
    assert sim["fill_hours"] == pytest.approx(20 / 1000 + 20 / 40 + 20 / 1000)


def test_a_step_with_no_turnover_at_all_is_infinitely_slow():
    cyc = [_edge("a", "b", 1.0, 1000.0), _edge("b", "a", 1.05, 0.0)]
    assert (
        simulate(_graph(cyc), cyc, 20, {"a": 1.0, "b": 1.0})["slowest_step_hours"]
        is None
    )


def _route(**kw):
    base = {
        "margin_pct": 5.0,
        "margin_ref": 5.0,
        "gold": 0,
        "gold_free": True,
        "margin_per_1k_gold": None,
        "liquidity_ref": 9999,
        "all_live": False,
        "volume_ref_per_h": 9999,
        "fill_hours": 1.0,
        "velocity": None,
        "velocity_inf": True,
        "uses_recipe": False,
        "slowest_step_hours": 0.5,
    }
    return {**base, **kw}


def test_keep_drops_a_loop_whose_slowest_step_exceeds_the_limit():
    f = {"max_step_minutes": 45}
    assert routes._keep(_route(slowest_step_hours=0.74), f)
    assert not routes._keep(_route(slowest_step_hours=0.76), f)
    assert not routes._keep(
        _route(slowest_step_hours=None), f
    )  # unknown turnover = cannot fill
    assert routes._keep(
        _route(slowest_step_hours=9.0), {"max_step_minutes": 0}
    )  # 0 = off, like the others


# A loop too big for `max_step_minutes` at full capital is sized DOWN to the largest whole lot that fills in time,
# not dropped: otherwise more capital showed FEWER loops (owner, 2026-11-24: 1,809 divine held, only small loops listed).
_SLOW = [
    _edge("a", "b", 1.0, 1000.0),
    _edge("b", "c", 1.0, 40.0),  # the slow market: 40 b/h
    _edge("c", "a", 1.25, 1000.0),
]
_REF = {"a": 1.0, "b": 1.0, "c": 1.0}


def _sized(held, max_step_minutes=0.0) -> dict:
    r = routes._route_from(
        _graph(_SLOW), _SLOW, "a", held, held, _REF, max_step_minutes
    )
    assert r is not None
    return r


def test_a_loop_too_slow_at_full_capital_is_shown_at_the_largest_size_that_fills_in_time():
    f = {"max_step_minutes": 60}
    assert not routes._keep(_sized(2000), f)  # 2000 units into a 40/h market: 50 h
    sized = _sized(2000, 60)
    assert sized["start_amount"] == 40
    assert sized["slowest_step_hours"] == pytest.approx(1.0)
    assert routes._keep(sized, f) and sized["margin"] == 10
    # the largest: one more unit would break the limit
    assert not routes._keep(_sized(41), f)


def test_the_limit_off_or_already_met_leaves_the_size_alone():
    assert _sized(2000, 0)["start_amount"] == 2000
    assert _sized(30, 60)["start_amount"] == 30


def test_more_capital_never_hides_a_loop():
    g = _graph(_SLOW)
    s = {"max_start_fraction": 1.0, "max_steps": 3}
    f = {"max_step_minutes": 60}
    for held in (30, 40, 400, 40_000):
        found = [
            r
            for r in routes._iter_candidates(
                g, s, _REF, {"a": held}, ["a"], False, max_step_minutes=60
            )
            if len(r["path"]) == 4 and routes._keep(r, f)
        ]
        assert [r["start_amount"] for r in found] == [min(held, 40)]


def test_max_gold_and_max_fill_hours_size_down_instead_of_dropping():
    cyc = [
        _edge("a", "b", 1.0, 1000.0),
        _edge("b", "c", 1.0, 100.0),
        _edge("c", "a", 1.25, 1000.0),
    ]
    g = Graph(
        {
            "reference": "a",
            "step_overhead_min": 0.0,
            "gold_model": {"per_unit": {"a": 100, "b": 100, "c": 100}},
        }
    )
    g.fee_table = {}
    for e in cyc:
        g.add(e)
    # 1 unit costs 100 (b) + 100 (c) + 100 (a) = 300 gold (approx 325 with 1.25 out).
    # At max_gold=3250, full held=2000 must be sized down rather than dropped.
    sized_g = routes._route_from(g, cyc, "a", 2000, 2000, _REF, max_gold=3250)
    assert sized_g is not None
    assert sized_g["gold"] <= 3250
    assert sized_g["start_amount"] == 10
    assert routes._keep(sized_g, {"max_gold": 3250})
    one_more = routes._route_from(g, cyc, "a", 11, 11, _REF)
    assert one_more is not None and not routes._keep(one_more, {"max_gold": 3250})

    # At max_fill_hours=0.5 (sum of used/vol across all 3 steps), full held=2000 fits ~41 units.
    sized_fh = routes._route_from(g, cyc, "a", 2000, 2000, _REF, max_fill_hours=0.5)
    assert sized_fh is not None
    assert sized_fh["fill_hours"] is not None and sized_fh["fill_hours"] <= 0.5
    assert routes._keep(sized_fh, {"max_fill_hours": 0.5})
    next_up = routes._route_from(
        g, cyc, "a", sized_fh["start_amount"] + 1, sized_fh["start_amount"] + 1, _REF
    )
    assert next_up is not None and not routes._keep(next_up, {"max_fill_hours": 0.5})


def test_commit_trims_floor_rounding_waste_on_expensive_intermediates():
    # Intermediate `item` costs 80 chaos and sells for 132 chaos. Committing 169 chaos (or 100)
    # only buys 1 item via floor(); trimming avoids burning extra chaos into rounding waste so
    # holding more capital never turns a profitable loop negative.
    cyc = [
        _edge("chaos", "item", 1.0 / 80.0, 500.0),
        _edge("item", "chaos", 132.0, 100.0),
    ]
    g = _graph(cyc)
    ref = {"chaos": 1.0, "item": 80.0}
    r100 = routes._route_from(g, cyc, "chaos", 100, 100, ref)
    r159 = routes._route_from(g, cyc, "chaos", 159, 159, ref)
    r200 = routes._route_from(g, cyc, "chaos", 200, 200, ref)
    assert r100 is not None and r159 is not None and r200 is not None
    assert (r100["start_amount"], r100["end_amount"], r100["margin"]) == (80, 132, 52)
    assert (r159["start_amount"], r159["end_amount"], r159["margin"]) == (80, 132, 52)
    assert (r200["start_amount"], r200["end_amount"], r200["margin"]) == (160, 264, 104)


def test_dedup_rotations_keeps_single_best_entry_per_cycle():
    # Two rotations of the same cycle a->b->c->a: higher-scoring rotation wins.
    r_a = _route(
        id="a>b|b>c|c>a",
        margin_ref=50.0,
        velocity=40.0,
        velocity_inf=False,
        gold=100,
        gold_free=False,
        margin_per_1k_gold=500.0,
        steps=[
            {"from": "a", "to": "b", "kind": "digest"},
            {"from": "b", "to": "c", "kind": "digest"},
            {"from": "c", "to": "a", "kind": "digest"},
        ],
    )
    r_b = _route(
        id="b>c|c>a|a>b",
        margin_ref=10.0,
        velocity=10.0,
        velocity_inf=False,
        gold=100,
        gold_free=False,
        margin_per_1k_gold=100.0,
        steps=[
            {"from": "b", "to": "c", "kind": "digest"},
            {"from": "c", "to": "a", "kind": "digest"},
            {"from": "a", "to": "b", "kind": "digest"},
        ],
    )
    r_other = _route(
        id="a>d|d>a",
        margin_ref=20.0,
        velocity=20.0,
        velocity_inf=False,
        gold=100,
        gold_free=False,
        margin_per_1k_gold=200.0,
        steps=[
            {"from": "a", "to": "d", "kind": "digest"},
            {"from": "d", "to": "a", "kind": "digest"},
        ],
    )
    kept, _ = routes._finish([r_b, r_other, r_a], {}, {})
    assert [r["id"] for r in kept] == ["a>b|b>c|c>a", "a>d|d>a"]


def test_route_edge_overlay_recent_volume_and_stability_without_mutating_graph(
    monkeypatch,
):
    e_steady = Edge(
        "a",
        "b",
        "digest",
        1.0,
        [{"rate": 1.0, "stock": 10_000}],
        age_s=1800,
        vol_in_per_h=100.0,
    )
    e_sporadic = Edge(
        "a",
        "c",
        "digest",
        1.0,
        [{"rate": 1.0, "stock": 10_000}],
        age_s=1800,
        vol_in_per_h=100.0,
    )
    e_wild = Edge(
        "a",
        "d",
        "digest",
        1.0,
        [{"rate": 1.0, "stock": 10_000}],
        age_s=1800,
        vol_in_per_h=100.0,
    )
    e_stale = Edge(
        "a",
        "e",
        "digest",
        1.0,
        [{"rate": 1.0, "stock": 10_000}],
        age_s=4 * 3600,
        vol_in_per_h=100.0,
    )
    g = Graph({"league": "L", "volume_window_h": 72, "wide_spread": 2.0})
    for e in (e_steady, e_sporadic, e_wild, e_stale):
        g.add(e)

    monkeypatch.setattr(
        digest,
        "pair_activity",
        lambda _lg: {
            "league_hours": 24,
            "vol_recent": {
                ("a", "b"): 25.0,
                ("a", "c"): 50.0,
                ("a", "d"): 50.0,
                ("a", "e"): 50.0,
            },
            "hours_active": {
                ("a", "b"): 20,
                ("a", "c"): 3,
                ("a", "d"): 20,
                ("a", "e"): 20,
            },
            "range_24h": {
                ("a", "b"): 1.4,
                ("a", "c"): 1.2,
                ("a", "d"): 5.5,
                ("a", "e"): 1.2,
            },
        },
    )
    edge_map, blocked, range_24h = routes._route_edge_overlay(g, g.s)
    # Sporadic (<6h), wild (>2*wide_spread=4.0), and stale (>3h) are excluded; steady stays.
    assert blocked == {("a", "c"), ("a", "d"), ("a", "e")}
    # Steady edge's route volume is capped to recent 6h flow without mutating g.edges.
    assert edge_map[("a", "b")].vol_in_per_h == 25.0
    assert g.edges[("a", "b")].vol_in_per_h == 100.0
    assert range_24h[("a", "b")] == 1.4

    # Fail-open when league has < 12h of history (fresh league or tiny test fixture).
    monkeypatch.setattr(
        digest,
        "pair_activity",
        lambda _lg: {
            "league_hours": 6,
            "vol_recent": {},
            "hours_active": {},
            "range_24h": {},
        },
    )
    assert routes._route_edge_overlay(g, g.s) == ({}, set(), {})


def test_as_hill_margin_scaling_unlocks_large_calm_commits_and_protects_volatile():
    # Curve shape: flat near base for tiny commits, decays smoothly toward floor=0.25*m0.
    m0 = 20.0
    small = routes._effective_min_margin_pct(m0, 1.0, 1.1)
    mid = routes._effective_min_margin_pct(m0, 200.0, 1.1)
    large_calm = routes._effective_min_margin_pct(m0, 1000.0, 1.1)
    large_vol = routes._effective_min_margin_pct(m0, 1000.0, 2.0)
    extreme = routes._effective_min_margin_pct(m0, 100_000.0, 1.0)
    assert 19.0 < small < 20.0
    assert mid == pytest.approx(12.5)
    assert 5.0 < large_calm < 10.0
    assert large_vol > 15.0  # volatile 2x range raises the AS floor
    assert extreme > 5.0  # bounded above 0.25 * m0 even at extreme scale
    # Non-positive base thresholds are never scaled.
    assert routes._effective_min_margin_pct(0.0, 1000.0, 1.0) == 0.0
    # Extreme volatility clamps floor at base_pct (never stricter than user's setting).
    assert routes._effective_min_margin_pct(m0, 1000.0, 5.0) == pytest.approx(m0)

    # Integration through _keep: 762d calm loop at 18.5% passes under base 20%;
    # small 10d loop at 15% is still rejected; volatile 2.5x loop at 15% is rejected.
    ref = {"divine": 100.0, "chaos": 1.0, "omen": 50.0}
    f = {"min_margin_pct": 20.0}
    calm_ranges = {
        ("chaos", "divine"): 1.05,
        ("chaos", "omen"): 1.15,
        ("divine", "omen"): 1.12,
    }
    vol_ranges = {
        ("chaos", "divine"): 1.05,
        ("chaos", "omen"): 2.5,
        ("divine", "omen"): 1.12,
    }
    pairs = [["divine", "chaos"], ["chaos", "omen"], ["omen", "divine"]]
    r_calm = _route(start="divine", start_amount=762, margin_pct=18.5, pairs=pairs)
    r_small = _route(start="divine", start_amount=10, margin_pct=15.0, pairs=pairs)
    r_vol = _route(start="divine", start_amount=762, margin_pct=15.0, pairs=pairs)
    assert routes._keep(r_calm, routes._route_filters(r_calm, f, ref, calm_ranges))
    assert not routes._keep(
        r_small, routes._route_filters(r_small, f, ref, calm_ranges)
    )
    assert not routes._keep(r_vol, routes._route_filters(r_vol, f, ref, vol_ranges))


def test_default_is_the_balanced_presets():
    assert (
        settings.DEFAULTS["filters"]["max_step_minutes"]
        == settings.ARBITRAGE_PRESETS[0]["values"]["filters"]["max_step_minutes"]
        == 60
    )


# ---------------------------------------------------------------- 3. an inactive market trades at its ask
def test_a_wide_ask_bid_gap_is_priced_at_the_ask_not_the_average(monkeypatch):
    """Owner, 2026-09-19: Tecrod's Gaze sells for ~12 divine, yet a route offered to buy one for
    471 exalted. Its exalted market is inactive — over one window its ratios ran 75 … 3,113 ex per
    gaze — and one sparse hour (175 ex for 2) set the executed average at 87.5. Nobody sells a 12d
    item under the ask, so averaging the two sides is a lie: a market whose ask is far above its
    bid is priced at the ASK when you are buying and at the BID when you are selling. A tight
    market (the gaze's divine market ran 10 … 14) keeps its executed rate."""
    wide = _row(
        vol_a=175,
        vol_b=2,
        hi_stock_a=1190,
        hi_stock_b=6,
        lo_ratio_a=75,
        hi_ratio_a=3113,
        lo_ratio_b=1,
        hi_ratio_b=1,
    )  # exalted(a) per gaze(b)
    out = digest.directed_rates(
        "exalted", "gaze", wide, age=60.0, bounds=(87.5, 3113.0)
    )
    assert (
        abs(out[("exalted", "gaze")]["rate"] - 1 / 3113) < 1e-12
    )  # buying a gaze costs the ask
    assert (
        abs(out[("gaze", "exalted")]["rate"] - 87.5) < 1e-9
    )  # selling one pays the cheapest
    assert out[("exalted", "gaze")]["inactive"] is True

    tight = _row(
        vol_a=531,
        vol_b=44,
        hi_stock_a=1011,
        hi_stock_b=97,
        lo_ratio_a=11,
        hi_ratio_a=13,
        lo_ratio_b=1,
        hi_ratio_b=1,
    )  # divine(a) per gaze(b)
    out = digest.directed_rates("divine", "gaze", tight, age=60.0, bounds=(11.8, 12.3))
    assert (
        abs(out[("divine", "gaze")]["rate"] - 44 / 531) < 1e-12
    )  # the executed rate, as before
    assert abs(out[("gaze", "divine")]["rate"] - 531 / 44) < 1e-12
    assert not out[("divine", "gaze")].get("inactive")

    # no ratio data at all (older rows, synthetic fixtures) → unchanged behaviour
    out = digest.directed_rates("a", "b", _row(), age=60.0, bounds=None)
    assert out[("a", "b")]["rate"] == 13.0
