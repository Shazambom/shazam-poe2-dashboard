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
from app import digest, settings  # noqa: E402
from app.arbitrage import Edge, Graph, routes  # noqa: E402
from app.arbitrage.graph import simulate  # noqa: E402


def _row(**kw):
    base = {"vol_a": 1, "vol_b": 13, "hi_stock_a": 0, "hi_stock_b": 120, "hour": 0}
    return {**base, **kw}


# ---------------------------------------------------------------- 1. sellers must exist
def test_no_standing_sellers_means_no_edge_in_that_direction():
    """Radiance(a) <-> chaos(b): chaos is on offer (120), Radiance is not (0)."""
    out = digest.directed_rates("radiance", "chaos", _row(), age=60.0)
    assert set(out) == {("radiance", "chaos")}                 # you CAN sell a Radiance into the chaos bids
    assert out[("radiance", "chaos")]["rate"] == 13.0 and out[("radiance", "chaos")]["stock"] == 120
    # ...but you cannot BUY one with chaos: nobody is selling. (Old code: stock = volume = 1.)


def test_both_sides_standing_gives_both_edges_with_real_stock():
    out = digest.directed_rates("radiance", "divine", _row(vol_a=17, vol_b=564, hi_stock_a=39, hi_stock_b=576), age=60.0)
    assert out[("radiance", "divine")]["stock"] == 576 and out[("divine", "radiance")]["stock"] == 39
    assert out[("divine", "radiance")]["rate"] == pytest.approx(17 / 564)


def test_a_dead_market_gives_nothing():
    assert digest.directed_rates("a", "b", _row(hi_stock_b=0), age=60.0) == {}


# ---------------------------------------------------------------- 2. turnover relative to the trade
def _edge(a, b, rate, vol):
    return Edge(a, b, "digest", rate, [{"rate": rate, "stock": 10_000_000}], vol_in_per_h=vol)


def _graph(edges):
    g = Graph({"reference": "a", "step_overhead_min": 0.0, "gold_model": {}})
    g.fee_table = {}
    for e in edges:
        g.add(e)
    return g


def test_simulate_reports_the_slowest_steps_share_of_its_market():
    cyc = [_edge("a", "b", 1.0, 1000.0), _edge("b", "c", 1.0, 40.0), _edge("c", "a", 1.05, 1000.0)]
    sim = simulate(_graph(cyc), cyc, 20, {"a": 1.0, "b": 1.0, "c": 1.0})
    assert sim["slowest_step_hours"] == pytest.approx(20 / 40)      # 20 units into a 40/h market
    assert sim["fill_hours"] == pytest.approx(20 / 1000 + 20 / 40 + 20 / 1000)


def test_a_step_with_no_turnover_at_all_is_infinitely_slow():
    cyc = [_edge("a", "b", 1.0, 1000.0), _edge("b", "a", 1.05, 0.0)]
    assert simulate(_graph(cyc), cyc, 20, {"a": 1.0, "b": 1.0})["slowest_step_hours"] is None


def _route(**kw):
    base = {"margin_pct": 5.0, "margin_ref": 5.0, "gold": 0, "gold_free": True, "margin_per_1k_gold": None,
            "liquidity_ref": 9999, "all_live": False, "volume_ref_per_h": 9999, "fill_hours": 1.0,
            "velocity": None, "velocity_inf": True, "uses_recipe": False, "slowest_step_hours": 0.5}
    return {**base, **kw}


def test_keep_drops_a_loop_whose_slowest_step_exceeds_the_limit():
    f = {"max_step_minutes": 45}
    assert routes._keep(_route(slowest_step_hours=0.74), f)
    assert not routes._keep(_route(slowest_step_hours=0.76), f)
    assert not routes._keep(_route(slowest_step_hours=None), f)           # unknown turnover = cannot fill
    assert routes._keep(_route(slowest_step_hours=9.0), {"max_step_minutes": 0})   # 0 = off, like the others


def test_default_is_45_minutes():
    assert settings.DEFAULTS["filters"]["max_step_minutes"] == 45
