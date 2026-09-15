"""TDD for the gold-value slider's effect on Arbitrage velocity.

Velocity ranks loops. Gold is a real, precious cost priced by the user's slider
(`gold_value_per_1k`, Divine per 1k gold). The slider must actually REORDER loops: when gold is
precious a gold-thrifty loop wins; when gold is cheap the higher-margin loop wins even if it
spends more gold. A pure uniform scale of the gold divisor is a no-op under rank-normalized
scoring, so velocity charges gold as an additive cost with a floor:

    velocity = margin_ref / fill_hours / max(gold * gold_price_ref, FLOOR)

where gold_price_ref is the slider price in reference-per-gold. gold-free loops rank best (INF).

    python -m pytest backend/tests/test_velocity.py -q
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import arbitrage  # noqa: E402


def v(margin, gold, price):
    return arbitrage._velocity(margin, 1.0, gold, price)


def test_gold_free_ranks_best():
    assert v(50, 0, 0.01) == math.inf
    assert v(0, 0, 0.01) == 0.0


def test_high_gold_price_penalises_gold_hungry_loop():
    # Gold precious: a 100-margin/1k-gold loop beats a 120-margin/10k-gold loop.
    assert v(100, 1000, 0.01) > v(120, 10000, 0.01)


def test_low_gold_price_lets_margin_win():
    # Gold cheap: both loops' priced gold-cost falls under the floor, so gold is ~ignored and the
    # higher-margin loop wins — the SAME two loops flip vs the high-price case above.
    assert v(120, 10000, 1e-5) > v(100, 1000, 1e-5)


def test_no_fill_hours_is_none():
    assert arbitrage._velocity(100, None, 1000, 0.01) is None
    assert arbitrage._velocity(100, 0, 1000, 0.01) is None
