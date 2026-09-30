"""TDD for the Hold smoke test's window checks (ops/hold-backtest.py).

Owner, 2026-09-30: the window (24h / 3d / 7d / 14d) is how long the player plans to hold, and Hold
ranks the best currencies to hold for that long. So the smoke test builds each window's OWN board,
holds it for exactly that window, and fails a ranking the window doesn't move
(docs/bugs/2026-09-30-hold-ignores-the-time-window.md).
"""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _bt():
    spec = importlib.util.spec_from_file_location("hold_backtest", ROOT / "ops" / "hold-backtest.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_every_window_is_its_own_board_and_14d_is_not_clamped():
    bt = _bt()
    assert {label: bt.board_days(wh) for label, wh in bt.SELECTIONS.items()} == \
        {"24h": 1, "3d": 3, "7d": 7, "14d": 14}


def _boards(per_label):
    """{label: {day: (top ids, scores)}} from {label: [ids per day]}; the scores follow the order."""
    return {label: {t: (ids, {i: 1.0 - p / 100 for p, i in enumerate(ids)}) for t, ids in enumerate(days, 1)}
            for label, days in per_label.items()}


def test_a_ranking_the_window_does_not_move_fails():
    bt = _bt()
    same = [list(range(10))] * 5
    w = bt.window_grade(_boards({"24h": same, "3d": same, "7d": same, "14d": same}))
    assert w["window_overlap"] == 1.0 and w["window_same"] == 1.0
    miss = bt.window_verdict(w)
    assert any(m.startswith("window_overlap") for m in miss) and any(m.startswith("window_same") for m in miss)


def test_boards_that_differ_by_window_pass():
    bt = _bt()
    short = [list(range(10))] * 5
    long_ = [[1, 0, 2, 3, 4, 10, 11, 12, 13, 14]] * 5      # 3 of 10 names at the same rank
    w = bt.window_grade(_boards({"24h": short, "3d": [list(range(2, 12))] * 5, "7d": [list(range(3, 13))] * 5,
                                 "14d": long_}))
    assert w["window_overlap"] == 0.3 and w["window_same"] == 0.0
    assert bt.window_verdict(w) == []


def test_the_overlap_is_names_at_the_same_rank_averaged_over_days_both_boards_exist():
    """The same ten names in another order is a different list to a player reading it top down."""
    bt = _bt()
    b = _boards({"24h": [list(range(10))] * 3, "14d": [list(range(10)), list(range(9, -1, -1)), list(range(10))]})
    del b["14d"][3]                                  # the 14d board isn't readable on day 3
    assert bt.window_grade(b)["window_overlap"] == 0.5


def test_two_windows_with_the_same_scores_count_even_when_the_far_pair_differs():
    bt = _bt()
    a, z = [list(range(10))] * 4, [list(range(10, 20))] * 4
    w = bt.window_grade(_boards({"24h": a, "3d": a, "7d": z, "14d": z}))
    assert w["window_overlap"] == 0.0
    assert abs(w["window_same"] - 2 / 6) < 1e-9     # 2 of the 6 pairs are identical every day
    assert any(m.startswith("window_same") for m in bt.window_verdict(w))


def test_the_production_scorer_ranks_for_the_holding_period(monkeypatch):
    bt = _bt()
    seen = {}
    monkeypatch.setattr(bt.H, "hold_rank", lambda entries, t, k, past, regime, hold=None: seen.setdefault("hold", hold) and {})
    bt.production([], {"t": 20, "k": 2.0, "past": [], "hold": 14})
    assert seen["hold"] == 14
