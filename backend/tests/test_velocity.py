"""TDD for the gold-value slider's effect on Arbitrage velocity.

Velocity ranks loops as the geometric mean of net profit/hour and net profit/1k gold.
Gold is priced by the user's slider (`gold_value_per_1k`, Divine per 1k gold) and its
value is SUBTRACTED from the margin:

    net      = margin_ref - gold * gold_price_ref
    velocity = net / sqrt(fill_hours * gold / 1000)  (gold-free -> INF when net>0)

The subtraction is what makes the slider actually move the ranking (a pure divisor was a
rank-invariant scalar). Using sqrt(fill_hours * gold / 1000) fixes the 1/scale distortion
of dividing by both fill_hours and gold: scaling a loop up never lowers its velocity.

    python -m pytest backend/tests/test_velocity.py -q
"""

import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import arbitrage


def v(margin, gold, fill_hours, price):
    velocity = arbitrage._velocity(margin, fill_hours, gold, price)
    assert velocity is not None
    return velocity


def test_gold_free_ranks_best():
    assert v(50, 0, 1.0, 0.01) == math.inf  # net 50 > 0
    assert v(0, 0, 1.0, 0.01) == 0.0  # net 0


def test_higher_gold_price_lowers_velocity_and_can_go_negative():
    # Same loop, gold now valued higher -> lower velocity; past break-even it goes negative (net loss).
    assert v(100, 5000, 1.0, 0.001) > v(100, 5000, 1.0, 0.03)
    assert v(100, 5000, 1.0, 0.03) < 0  # net = 100 - 5000*0.03 = -50


def test_slider_reorders_loops():
    # Two loops, different fill times. The gold price flips which one ranks higher — proof the
    # slider meaningfully reorders (a scalar divisor never could).
    lo, hi = 0.001, 0.05
    assert v(100, 2000, 1.0, lo) > v(
        110, 2000, 2.0, lo
    )  # cheap gold: the faster loop wins
    assert v(110, 2000, 2.0, hi) > v(100, 2000, 1.0, hi)  # dear gold: order flips


def test_no_fill_hours_is_none():
    assert arbitrage._velocity(100, None, 1000, 0.01) is None
    assert arbitrage._velocity(100, 0, 1000, 0.01) is None


def test_scaling_up_a_loop_never_lowers_velocity():
    # Scaling a loop 10x scales margin and gold 10x while fill_hours = overhead + c*k grows
    # sub-linearly because of step overhead -> velocity must increase, never drop as 1/k.
    overhead = 0.1
    small = v(margin=10, gold=1000, fill_hours=overhead + 0.1, price=0.001)
    large = v(margin=100, gold=10000, fill_hours=overhead + 1.0, price=0.001)
    assert large > small
    # Without overhead, pure scaling is exactly scale-invariant.
    assert v(10, 1000, 0.1, 0.001) == pytest.approx(v(100, 10000, 1.0, 0.001))


def test_velocity_scales_linearly_with_reference_currency():
    # thresholds_in_reference scales min_velocity by ex_in_ref, so velocity must be linear in ref.
    in_ex = v(margin=500, gold=2000, fill_hours=1.5, price=0.01)
    in_div = v(margin=500 * 0.01, gold=2000, fill_hours=1.5, price=0.01 * 0.01)
    assert in_div == pytest.approx(in_ex * 0.01)
