"""The pure pieces of ops/hold-diagnostics.py (the measurements behind Hold's crash conclusions)."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _hd():
    spec = importlib.util.spec_from_file_location("hold_diagnostics", ROOT / "ops" / "hold-diagnostics.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_auc_is_one_for_a_perfect_sign_and_half_for_none():
    hd = _hd()
    assert hd.auc([5, 6, 7], [1, 2, 3]) == 1.0
    assert hd.auc([1, 2, 3], [5, 6, 7]) == 0.0
    assert hd.auc([1, 2], [1, 2]) == 0.5
    assert hd.auc([], [1]) is None


def test_a_never_crashing_list_ties_when_nothing_on_the_board_crashes():
    hd = _hd()
    assert hd.p_zero(40, 0) == 1.0            # no crashes: every random list ties → 50th percentile
    assert hd.p_zero(40, 35) == 0.0           # too few survivors for a clean 10-item list
    assert 0 < hd.p_zero(40, 5) < 1


def test_the_bootstrap_is_deterministic_and_brackets_the_point():
    hd = _hd()
    cells = [[30.0] * 10 + [50.0] * 10, [45.0] * 20, [20.0] * 20]
    a = hd.block_bootstrap_counts(cells, n=300)
    assert a == hd.block_bootstrap_counts(cells, n=300)
    assert a[0] <= 2 <= a[-1]
