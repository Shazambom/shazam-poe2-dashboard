"""A loop that claims an impossible margin is a data artifact, not an opportunity.

2026-09-17, real Forbidden Rites data: 107 of 169 "passing" loops claimed > +50% (up to
+25,000%), every one of them through hourly-average digest edges — one odd trade in a thin
market (1 divine for 1 rune worth 9 exalted) becomes that market's "rate" for the hour, and a
loop through it prints money. Real exchange arbitrage is single-digit percent. Such loops are
withheld from the list and COUNTED (`implausible`), so the UI can say what it hid and why —
never silently dropped, never shown as if they were tradable.

    python -m pytest backend/tests/test_route_credibility.py -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app.arbitrage import routes  # noqa: E402

F = {"min_margin_pct": 0.5, "sort": "margin_pct", "limit": 100}
S = {"rank_weights": {}}


def _r(i, pct, ref=10.0):
    return {"id": f"r{i}", "margin_pct": pct, "margin_ref": ref, "gold": 0, "gold_free": True,
            "margin_per_1k_gold": None, "liquidity_ref": 1000, "all_live": False, "volume_ref_per_h": 500,
            "fill_hours": 1.0, "velocity": None, "velocity_inf": True, "uses_recipe": False, "pairs": []}


def test_impossible_margins_are_withheld_and_counted(monkeypatch):
    monkeypatch.setattr(routes.pairscore, "observe", lambda rs: None)
    rs = [_r(1, 3.9), _r(2, 49.9), _r(3, 50.1), _r(4, 780.0), _r(5, 25268.6), _r(6, 0.1)]
    kept, limit, implausible = routes._finish(rs, F, S)
    assert [r["id"] for r in kept] == ["r2", "r1"]
    assert implausible == 3                      # r3, r4, r5 — r6 failed the user's own filter instead


def test_the_bound_is_a_constant_a_reader_can_find():
    assert routes.MAX_CREDIBLE_MARGIN_PCT == 50.0
