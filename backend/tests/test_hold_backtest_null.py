"""TDD for the Hold smoke test's random-10 null (ops/hold-backtest.py `random_null`).

A 10-item list rarely beats an average driven by a few big winners, even with no skill (Bessembinder
2018). So the backtest also grades the top 10 against random 10-item lists drawn from the same day's
eligible board: its percentile on return (higher is better) and on crash share (lower is better).
docs/hold-research.md "Academic review, round 3".
"""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _bt():
    spec = importlib.util.spec_from_file_location("hold_backtest", ROOT / "ops" / "hold-backtest.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_the_best_ten_sit_at_the_top_of_the_null():
    bt = _bt()
    rets = [i / 100 for i in range(40)]            # item i returns i%
    crashed = [False] * 40
    top = list(range(30, 40))
    ret_pct, crash_pct = bt.random_null(rets, crashed, top, n=500, seed=1)
    assert ret_pct > 99


def test_the_worst_ten_sit_at_the_bottom_and_crash_more_than_any_random_list():
    bt = _bt()
    rets = [i / 100 for i in range(40)]
    crashed = [i < 10 for i in range(40)]          # the ten worst all crashed
    ret_pct, crash_pct = bt.random_null(rets, crashed, list(range(10)), n=500, seed=1)
    assert ret_pct < 1
    assert crash_pct > 99                          # higher crash percentile = worse


def test_a_random_pick_lands_near_the_middle():
    bt = _bt()
    rets = [((i * 37) % 40) / 100 for i in range(40)]
    crashed = [(i * 7) % 5 == 0 for i in range(40)]
    ret_pct, crash_pct = bt.random_null(rets, crashed, list(range(0, 40, 4)), n=2000, seed=3)
    assert 15 < ret_pct < 85 and 15 < crash_pct < 85


def test_it_is_deterministic():
    bt = _bt()
    rets = [((i * 13) % 17) / 10 for i in range(30)]
    crashed = [i % 6 == 0 for i in range(30)]
    a = bt.random_null(rets, crashed, list(range(10)), n=300, seed=9)
    assert a == bt.random_null(rets, crashed, list(range(10)), n=300, seed=9)
