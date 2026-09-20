"""Trades that are never going to happen (owner, 2026-09-19).

A route offered to buy a Tecrod's Gaze for 471 exalted when it sells for ~12 divine. Its exalted
market is not a market: over six hours the trades that did happen ran 87 … 3,114 exalted per gaze,
and the newest of them (2 gazes for 175 ex) set the rate at 87.5. Nobody sells a 12-divine item for
87 exalted, so an average of the two sides is a lie.

    "So for trades where the gap between the ask and bid is really really large its likely an
     indication of an inactive market, so we should just assume the ask is the only viable path,
     not the average of the ask and bid."

The rules that follow from that:
  1. A market is INACTIVE when the prices it actually traded at over the window disagree by more
     than `settings.wide_spread` (default 2x, tunable on the Arbitrage page, 0 = off).
  2. An inactive market is priced at the DEAREST hour when you are buying and the CHEAPEST when
     you are selling — never the middle. An active market keeps its executed rate.
  3. What counts is what EXECUTED. The digest's ratio columns are what was LISTED, and the book is
     full of bait: the divine<->exalted market carries a (1:1) listing beside the real (1:500).
  4. An inactive market never prices a currency that has an active one, and never drags its value.

    python -m pytest backend/tests/test_inactive_markets.py -q
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import db, digest, settings  # noqa: E402
from app.arbitrage import Edge, Graph  # noqa: E402

FX = json.loads((Path(__file__).parent / "fixtures" / "tecrods_gaze_2026-09-19.json").read_text())


def _row(**kw):
    base = {"vol_a": 1, "vol_b": 1, "hi_stock_a": 100, "hi_stock_b": 100, "hour": 0,
            "lo_ratio_a": 0, "hi_ratio_a": 0, "lo_ratio_b": 0, "hi_ratio_b": 0}
    return {**base, **kw}


def _hours(hub: str):
    """(exalted|divine|chaos) per gaze for each hour the fixture recorded, plus the raw rows."""
    out = []
    for r in FX["hours"][hub]:
        if not r["vol_a"] or not r["vol_b"]:
            continue
        # the fixture keeps each row's orientation; express every hour as hub-per-gaze
        px = (r["vol_b"] / r["vol_a"]) if r["gaze_is_a"] else (r["vol_a"] / r["vol_b"])
        out.append((px, r))
    return out


# ------------------------------------------------------------------ 1 + 3. what counts as inactive
def test_the_gap_is_measured_on_what_executed_not_what_was_listed():
    """Six real hours of each market. The gaze's exalted market disagrees with itself by 35x; its
    divine market repeats the same price. A bait LISTING (1 divine for 1 exalted, which the digest
    carries beside the real 1:500) must not make a market look inactive."""
    ex = [px for px, _ in _hours("exalted")]
    dv = [px for px, _ in _hours("divine")]
    assert max(ex) / min(ex) > 30, (min(ex), max(ex))
    assert max(dv) / min(dv) < 1.5, (min(dv), max(dv))

    rows = [_row(vol_a=7119, vol_b=3395357, lo_ratio_a=1, lo_ratio_b=500, hi_ratio_a=1, hi_ratio_b=1,
                 cur_a="divine", cur_b="exalted", hour=1),
            _row(vol_a=6391, vol_b=3053090, lo_ratio_a=1, lo_ratio_b=500, hi_ratio_a=1, hi_ratio_b=300,
                 cur_a="divine", cur_b="exalted", hour=2)]
    lo, hi = digest.traded_bounds(rows)[("divine", "exalted")]
    assert hi / lo < 1.1, (lo, hi)          # the bait listing is ignored; the fills agree


def test_the_threshold_is_a_setting():
    """Tunable on the Arbitrage page; 0 turns the rule off entirely."""
    assert settings.wide_spread({}) == 2.0
    assert settings.wide_spread({"wide_spread": 5}) == 5.0
    assert settings.wide_spread({"wide_spread": 0}) == 0.0


# ------------------------------------------------------------------ 2. an inactive market's price
def test_an_inactive_market_is_priced_at_the_ask_when_buying_and_the_bid_when_selling():
    """The gaze's exalted market: buying one costs the dearest hour (3,114 ex), selling one pays
    the cheapest (87.5). Not 471, and not the 87.5 average that produced the fake trade."""
    px = sorted(p for p, _ in _hours("exalted"))
    out = digest.directed_rates("exalted", "gaze", _row(vol_a=175, vol_b=2, hi_stock_b=6, hi_stock_a=1190),
                                age=60.0, bounds=(px[0], px[-1]), wide_spread=2.0)
    assert abs(1 / out[("exalted", "gaze")]["rate"] - px[-1]) < 1e-6      # you pay the dearest
    assert abs(out[("gaze", "exalted")]["rate"] - px[0]) < 1e-6           # you receive the cheapest
    assert out[("exalted", "gaze")]["inactive"] is True


def test_an_active_market_keeps_its_executed_rate():
    """The gaze's divine market trades steadily, so what it traded at is what you get."""
    px = sorted(p for p, _ in _hours("divine"))
    out = digest.directed_rates("divine", "gaze", _row(vol_a=531, vol_b=44, hi_stock_a=1011, hi_stock_b=97),
                                age=60.0, bounds=(px[0], px[-1]), wide_spread=2.0)
    assert abs(out[("divine", "gaze")]["rate"] - 44 / 531) < 1e-12
    assert not out[("divine", "gaze")]["inactive"]


def test_the_rule_is_off_when_the_threshold_is_zero():
    px = sorted(p for p, _ in _hours("exalted"))
    out = digest.directed_rates("exalted", "gaze", _row(vol_a=175, vol_b=2, hi_stock_b=6, hi_stock_a=1190),
                                age=60.0, bounds=(px[0], px[-1]), wide_spread=0)
    assert abs(out[("exalted", "gaze")]["rate"] - 2 / 175) < 1e-12        # the executed average
    assert not out[("exalted", "gaze")]["inactive"]


# ------------------------------------------------------------------ 4. what an inactive market may price
SETTINGS = {"league": "L", "reference": "exalted", "watchlist": [], "max_steps": 3, "gold_model": {},
            "step_overhead_min": 0.0, "allow_digest_edges": True, "allow_recipe_edges": False,
            "digest_max_age_h": 6, "live_max_age_s": 1800, "hub_count": 2, "filters": {}}


def _graph(edges) -> Graph:
    g = Graph(dict(SETTINGS))
    g.fee_table = {}
    for src, dst, rate, vol, inactive in edges:
        g.add(Edge(src, dst, "digest", rate, [{"rate": rate, "stock": 10_000}], age_s=0.0,
                   vol_in_per_h=vol, meta={"inactive": inactive}))
    return g


@pytest.fixture
def gaze_graph(monkeypatch):
    """The gaze as its real markets have it: deep and steady against divine and chaos, inactive
    against exalted (priced at the ask, per the rule above)."""
    from app import leaguehistory
    monkeypatch.setattr(leaguehistory, "scout_prices", lambda league: {})
    return _graph([
        ("divine", "exalted", 471.0, 5_000, False), ("exalted", "divine", 1 / 471.0, 2_400_000, False),
        ("chaos", "exalted", 56.0, 40_000, False), ("exalted", "chaos", 1 / 56.0, 2_200_000, False),
        ("gaze", "divine", 12.07, 65, False), ("divine", "gaze", 1 / 12.07, 786, False),
        ("gaze", "chaos", 105.9, 22, False), ("chaos", "gaze", 1 / 105.9, 2_148, False),
        ("gaze", "exalted", 87.5, 1.4, True), ("exalted", "gaze", 1 / 3114.0, 3_501, True),
    ])


def test_an_inactive_market_never_prices_what_an_active_one_does(gaze_graph):
    """The gaze is worth what its divine market says (12.07), not what its inactive exalted
    market says — whichever end of that market you read."""
    V = gaze_graph.values()
    assert gaze_graph.priced_by.get("gaze") == "divine", gaze_graph.priced_by.get("gaze")
    assert abs(V["gaze"] / V["divine"] - 12.07) < 1e-6, V["gaze"] / V["divine"]


def test_the_hubs_are_unmoved_by_it(gaze_graph):
    """Nothing about one junk market may touch what a Divine or a Chaos is worth."""
    V = gaze_graph.values()
    assert abs(V["divine"] - 471.0) < 1e-6 and abs(V["chaos"] - 56.0) < 1e-6


def test_buying_through_the_inactive_market_costs_its_ask(gaze_graph):
    """What the route search may assume: 3,114 exalted for a gaze, never 471."""
    assert abs(1 / gaze_graph.edges[("exalted", "gaze")].rate - 3114.0) < 1e-6


# ------------------------------------------------------------------ the deepest market decides
def test_the_deepest_market_prices_it_even_beside_junk(monkeypatch):
    """The Preserved Cranium's shape on 2026-09-19: two deep markets that agree (divine 14.69,
    chaos 14.60), an inactive exalted market, and two markets so small they are noise (an annul
    market at 1,100 ex/h, a jeweller's orb market at 46 ex/h claiming it is worth 1.16 divine).
    The deep ones price it — it read 7.27 divine off one of the tiny ones."""
    from app import leaguehistory
    monkeypatch.setattr(leaguehistory, "scout_prices", lambda league: {})
    g = _graph([
        ("divine", "exalted", 471.0, 5_000, False), ("exalted", "divine", 1 / 471.0, 2_400_000, False),
        ("chaos", "exalted", 56.0, 40_000, False), ("exalted", "chaos", 1 / 56.0, 2_200_000, False),
        ("cranium", "divine", 14.69, 55, False), ("divine", "cranium", 1 / 14.69, 52_000, False),
        ("cranium", "chaos", 122.6, 200, False), ("chaos", "cranium", 1 / 122.6, 146_000, False),
        ("cranium", "exalted", 400.0, 1.4, True), ("exalted", "cranium", 1 / 4347.0, 58_000, True),
        ("cranium", "annul", 60.0, 2, False), ("annul", "cranium", 1 / 60.0, 100, False),
        ("cranium", "jewellers", 900.0, 0.5, False), ("jewellers", "cranium", 1 / 900.0, 40, False),
        ("annul", "exalted", 98.0, 12, False), ("jewellers", "exalted", 0.6, 7, False),
    ])
    V = g.values()
    assert g.priced_by.get("cranium") in ("divine", "chaos"), g.priced_by.get("cranium")
    assert abs(V["cranium"] / V["divine"] - 14.69) < 0.15, V["cranium"] / V["divine"]
