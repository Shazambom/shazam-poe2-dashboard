"""Characterization tests for the small pure helpers the sand-down refactors touch.

These pin CURRENT behaviour over synthetic inputs so that moving/merging a helper
(settings clamps, window change, route filters/sorting, offer parsing, header triples)
cannot change a result without a red test.

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_pure_helpers.py -q
"""
import copy
import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import arbitrage, db, digest, gateway, holdscore, movers, orderbook, settings  # noqa: E402

INF = math.inf


# ----------------------------------------------------------------- settings
def test_deep_update_merges_nested_and_replaces_leaves():
    base = {"a": 1, "f": {"x": 1, "y": 2}, "l": [1]}
    settings._deep_update(base, {"a": 2, "f": {"y": 3, "z": 4}, "l": [9], "n": {"k": 1}})
    assert base == {"a": 2, "f": {"x": 1, "y": 3, "z": 4}, "l": [9], "n": {"k": 1}}


def test_get_settings_bakes_liquidity_floor_once():
    db.kv_set("settings", {"filters": {"min_liquidity_ref": 0, "min_volume_ref_per_h": 5}})
    s = settings.get_settings()
    assert s["filters"]["min_liquidity_ref"] == 50.0
    assert s["filters"]["min_volume_ref_per_h"] == 100.0
    assert s["_liq_floor_v1"] is True
    # After the bake the user may lower them and it sticks.
    settings.save_settings({"filters": {"min_liquidity_ref": 1.0}})
    assert settings.get_settings()["filters"]["min_liquidity_ref"] == 1.0
    db.kv_set("settings", {})


def test_get_settings_defaults_are_not_mutated():
    before = copy.deepcopy(settings.DEFAULTS)
    settings.get_settings()
    assert settings.DEFAULTS == before


# ----------------------------------------------------------------- movers
def test_change_pct_uses_point_at_or_before_window_start():
    day = movers._DAY
    pts = [(0, 10.0, 0), (day, 12.0, 0), (2 * day, 15.0, 0), (3 * day, 20.0, 0)]
    assert movers._change_pct(pts, 1) == pytest.approx(100 * (20 - 15) / 15)
    assert movers._change_pct(pts, 2) == pytest.approx(100 * (20 - 12) / 12)
    assert movers._change_pct(pts, 30) == pytest.approx(100.0)   # older than series → first point
    assert movers._change_pct(pts[:1], 1) is None
    assert movers._change_pct([(0, 0.0, 0), (day, 1.0, 0)], 1) is None   # zero base


def test_win_days_rounds_hours():
    assert movers._win_days(24) == 1
    assert movers._win_days(72) == 3
    assert movers._win_days(336) == 14
    assert movers._win_days(0) == 1
    assert movers._win_days(5) == 1


# ----------------------------------------------------------------- holdscore
def test_metrics_horizon_and_fallback():
    series = {0: (10.0, 1e9), 1: (11.0, 1e9), 2: (12.0, 1e9), 5: (15.0, 1e9)}
    # Prices are neighbour-median smoothed (_smooth): last (age 5) = 15; base for hz=3 is the
    # latest age <= 5-3 → age 2 → median(11, 12) = 11.5.
    m = holdscore._metrics(series, 3)
    assert m["ret"] == pytest.approx(15.0 / 11.5 - 1)
    assert m["n"] == 4 and m["mdd"] == 0.0
    young = holdscore._metrics(series, 30)     # league younger than horizon → earliest (median(10, 11))
    assert young["ret"] == pytest.approx(15.0 / 10.5 - 1)
    assert holdscore._metrics({0: (1.0, 1.0)}, 1) is None


def test_metrics_drawdown_and_confidence():
    series = {0: (10.0, 0.0), 1: (5.0, 0.0), 2: (8.0, 0.0)}
    m = holdscore._metrics(series, 1)
    assert m["mdd"] == -0.5
    assert m["stab"] == 0.5
    assert m["conf"] == 0.0                   # zero traded value → no liquidity confidence


# ----------------------------------------------------------------- arbitrage filters/sort/score
def _route(**kw):
    base = {"id": "r", "margin_pct": 5.0, "margin_ref": 10.0, "gold": 100, "gold_free": False,
            "margin_per_1k_gold": 50.0, "liquidity_ref": 500.0, "all_live": True,
            "volume_ref_per_h": 1000.0, "fill_hours": 2.0, "velocity": 1.0, "velocity_inf": False,
            "uses_recipe": False}
    base.update(kw)
    return base


def test_keep_applies_each_filter():
    assert arbitrage._keep(_route(), {})
    assert not arbitrage._keep(_route(margin_pct=1), {"min_margin_pct": 3})
    assert not arbitrage._keep(_route(gold=500), {"max_gold": 100})
    assert arbitrage._keep(_route(gold_free=True, margin_per_1k_gold=None), {"min_margin_per_1k_gold": 99})
    assert not arbitrage._keep(_route(liquidity_ref=1), {"min_liquidity_ref": 50})
    assert arbitrage._keep(_route(liquidity_ref=None), {"min_liquidity_ref": 50})
    assert not arbitrage._keep(_route(all_live=False), {"live_only": True})
    assert not arbitrage._keep(_route(volume_ref_per_h=None), {"min_volume_ref_per_h": 1})
    assert not arbitrage._keep(_route(fill_hours=None), {"max_fill_hours": 24})
    assert arbitrage._keep(_route(velocity=None, velocity_inf=True), {"min_velocity": 5})
    assert not arbitrage._keep(_route(uses_recipe=True), {"exclude_recipes": True})


def test_sort_key_special_cases():
    assert arbitrage._sort_key("margin_per_1k_gold")(_route(gold_free=True)) == INF
    assert arbitrage._sort_key("margin_per_1k_gold")(_route(margin_per_1k_gold=None)) == -INF
    assert arbitrage._sort_key("fill_hours")(_route(fill_hours=None)) == -INF
    assert arbitrage._sort_key("fill_hours")(_route(fill_hours=2)) == -2
    assert arbitrage._sort_key("velocity")(_route(velocity_inf=True)) == INF
    assert arbitrage._sort_key("velocity")(_route(velocity=None)) == -INF
    assert arbitrage._sort_key("nope")(_route()) == 0


def test_composite_score_rank_normalised_and_unknown_volume_ranks_worst():
    a = _route(id="a", velocity=10, margin_per_1k_gold=10, margin_ref=10, volume_ref_per_h=None)
    b = _route(id="b", velocity=1, margin_per_1k_gold=1, margin_ref=1, volume_ref_per_h=1)
    arbitrage._composite_score([a, b], {})
    assert a["score_parts"]["volume"] == 0.5 and b["score_parts"]["volume"] == 1.0
    assert a["score_parts"]["velocity"] == 1.0 and b["score_parts"]["velocity"] == 0.5
    assert a["score"] == round((0.5 * 1 + 0.2 * 1 + 0.2 * 1 + 0.1 * 0.5) / 1.0, 4)
    arbitrage._composite_score([], {})   # no crash on empty


# ----------------------------------------------------------------- orderbook offers
def test_parse_offers_splits_per_have_and_sorts_best_first():
    payload = {"result": {
        "L1": {"listing": {"account": {"name": "A"}, "whisper": "w1", "offers": [
            {"exchange": {"currency": "chaos", "amount": 2}, "item": {"currency": "divine", "amount": 1, "stock": 5}},
            {"exchange": {"currency": "exalted", "amount": 10}, "item": {"currency": "divine", "amount": 1}},
            {"exchange": {"currency": "regal", "amount": 1}, "item": {"currency": "divine", "amount": 1}},   # not a have
            {"exchange": {"currency": "chaos", "amount": 0}, "item": {"currency": "divine", "amount": 1}},   # bad amount
        ]}},
        "L2": {"listing": {"account": {"name": "B"}, "offers": [
            {"exchange": {"currency": "chaos", "amount": 1}, "item": {"currency": "divine", "amount": 1}},
        ]}},
    }}
    books = orderbook._parse_offers(payload, ["chaos", "exalted"], "divine")
    assert [o["listing_id"] for o in books["chaos"]] == ["L2", "L1"]
    assert books["chaos"][1] == {"listing_id": "L1", "account": "A", "give": 2, "get": 1, "rate": 0.5,
                                 "stock": 5, "whisper": "w1"}
    assert books["chaos"][0]["stock"] == 1                     # stock defaults to get
    assert books["exalted"][0]["rate"] == 0.1


# ----------------------------------------------------------------- gateway / digest
def test_triples_parses_only_well_formed():
    assert gateway._triples("5:10:60, 20:60:120,bad,1:2") == [(5, 10, 60), (20, 60, 120)]
    assert gateway._triples("") == []


def test_hour_floor():
    assert digest._hour(3600 * 5 + 1799.9) == 3600 * 5
    assert digest._hour(0) == 0
