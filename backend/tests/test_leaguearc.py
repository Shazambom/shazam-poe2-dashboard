"""TDD for Phase 3 backend — the forward league-arc projection + DTW-weighted prediction.

Two things under test, both PURE (no DB, stdlib only, runs under .venv-test):

  1. holdscore._predict(weights=...) — the DTW weight vector replaces GAMMA**rank recency, is
     fully backward-compatible (weights=None → today's behavior), and degrades to recency when the
     weights cover none of the leagues that actually have data for the item.
  2. leaguearc.project(...) — turns the current item's arc + past leagues into a history series, a
     forward projected band ('you are here at day N' → N+H), and buy/sell windows.

Run:  .venv-test/bin/python -m pytest backend/tests/test_leaguearc.py -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import holdscore, leaguearc  # noqa: E402


def _per(points):
    """{age: (price, value)} from {age: price} with a flat liquid value."""
    return {a: (p, 1e9) for a, p in points.items()}


def test_predict_weights_override_recency_and_are_backward_compatible():
    # item 1: two past leagues. 'Recent' rose +0%, 'Old' rose +100% over the same delta.
    recent = {1: _per({0: 10.0, 3: 10.0})}
    old = {1: _per({0: 10.0, 3: 20.0})}
    past = [("Recent", recent), ("Old", old)]          # most-recent-first
    base = holdscore._predict(1, 0, 3, past)            # weights=None → GAMMA recency (favors Recent)
    weighted = holdscore._predict(1, 0, 3, past, weights={"Old": 1.0, "Recent": 0.0})
    assert base is not None and weighted is not None
    # Recency leans toward Recent (~0%); DTW-weighting all-on-Old must pull the prediction up.
    assert weighted["pred"] > base["pred"]
    assert weighted["pred"] > 0.9                       # ~ +100%, i.e. the Old league dominates
    assert weighted.get("weighted") is True and base.get("weighted") is False


def test_predict_weights_that_miss_all_data_fall_back_to_recency():
    recent = {1: _per({0: 10.0, 3: 12.0})}
    old = {1: _per({0: 10.0, 3: 11.0})}
    past = [("Recent", recent), ("Old", old)]
    # weights name a league that has no data for this item → must not zero-out; degrade to recency.
    got = holdscore._predict(1, 0, 3, past, weights={"Nonexistent": 1.0})
    ref = holdscore._predict(1, 0, 3, past)
    assert got is not None and abs(got["pred"] - ref["pred"]) < 1e-9
    assert got.get("weighted") is False                 # fell back → not DTW-weighted


def test_project_builds_history_forward_band_and_windows():
    # current league: item 1 has risen 10→14 over ages 0..4 (N=4).
    cur = {1: _per({0: 10.0, 1: 11.0, 2: 12.0, 3: 13.0, 4: 14.0})}
    # one past league where, from day 4, price climbs then falls — a sell-then-dip arc ahead.
    past = [("P", {1: _per({4: 14.0, 5: 16.0, 6: 18.0, 7: 15.0, 8: 12.0})})]
    out = leaguearc.project(1, cur, past, weights=None, horizon=4)
    assert out is not None
    assert out["cur_age"] == 4
    # history is the actual arc so far, oldest→newest.
    assert [h["age"] for h in out["history"]] == [0, 1, 2, 3, 4]
    assert out["history"][-1]["price"] == 14.0
    # forward arc: one point per horizon day past N, each with a mean + band.
    assert [a["age"] for a in out["arc"]] == [5, 6, 7, 8]
    for pt in out["arc"]:
        assert "pred_pct" in pt and "lo_pct" in pt and "hi_pct" in pt
        assert pt["lo_pct"] <= pt["pred_pct"] <= pt["hi_pct"]
    # the projected peak is a SELL window, the later trough a BUY window.
    kinds = {w["kind"] for w in out["windows"]}
    assert "sell" in kinds and "buy" in kinds


def test_phase_thresholds():
    assert leaguearc._phase(None) is None
    assert leaguearc._phase(0) == "early" and leaguearc._phase(9) == "early"
    assert leaguearc._phase(10) == "mid" and leaguearc._phase(44) == "mid"
    assert leaguearc._phase(45) == "late"


def test_project_returns_none_without_enough_history():
    cur = {1: _per({0: 10.0})}
    assert leaguearc.project(1, cur, [], horizon=4) is None


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
