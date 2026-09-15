"""TDD for the gold-value slider's effect on Arbitrage velocity.

Velocity ranks loops. Gold is priced by the user's slider (`gold_value_per_1k`, Divine per 1k
gold) and its value is SUBTRACTED from the margin (net margin), then still divided by gold to
keep the per-1k-gold efficiency weighting:

    net      = margin_ref - gold * gold_price_ref
    velocity = net / fill_hours / gold * 1000        (gold-free -> INF when net>0)

The subtraction is what makes the slider actually move the ranking (a pure divisor was a
rank-invariant scalar). gold_price_ref is the slider price in reference-per-gold.

    python -m pytest backend/tests/test_velocity.py -q
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import arbitrage  # noqa: E402


def v(margin, gold, fill_hours, price):
    return arbitrage._velocity(margin, fill_hours, gold, price)


def test_gold_free_ranks_best():
    assert v(50, 0, 1.0, 0.01) == math.inf     # net 50 > 0
    assert v(0, 0, 1.0, 0.01) == 0.0           # net 0


def test_higher_gold_price_lowers_velocity_and_can_go_negative():
    # Same loop, gold now valued higher -> lower velocity; past break-even it goes negative (net loss).
    assert v(100, 5000, 1.0, 0.001) > v(100, 5000, 1.0, 0.03)
    assert v(100, 5000, 1.0, 0.03) < 0         # net = 100 - 5000*0.03 = -50


def test_slider_reorders_loops():
    # Two loops, different fill times. The gold price flips which one ranks higher — proof the
    # slider meaningfully reorders (a scalar divisor never could).
    lo, hi = 0.001, 0.05
    assert v(100, 2000, 1.0, lo) > v(110, 2000, 2.0, lo)   # cheap gold: the faster loop wins
    assert v(110, 2000, 2.0, hi) > v(100, 2000, 1.0, hi)   # dear gold: order flips


def test_no_fill_hours_is_none():
    assert arbitrage._velocity(100, None, 1000, 0.01) is None
    assert arbitrage._velocity(100, 0, 1000, 0.01) is None
