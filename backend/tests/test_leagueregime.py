"""TDD for the league-regime detector: EARLY (price discovery), MID (settled), LATE (winding down),
read from market state, not the calendar. Design and validation on the five real leagues:
docs/hold-research.md "Regimes".

    python -m pytest backend/tests/test_leagueregime.py -q
"""
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import leagueregime as LR  # noqa: E402

DIV = LR.DIVINE_ID


def league(days=90, discovery=20, late_from=60, items=40, seed=7):
    """A synthetic league {item_id: {age: (close_ex, volume)}}. Until `discovery` every item re-prices
    along its own persistent drift; afterwards prices wobble and partly reverse; from `late_from`
    trading volume falls to a fifth."""
    rnd = random.Random(seed)
    per = {DIV: {a: (100.0, 1000.0) for a in range(days)}}
    for i in range(1, items + 1):
        drift = rnd.uniform(-0.08, 0.08)
        p, s, prev = 10.0 * i, {}, 0.0
        for a in range(days):
            if a < discovery:
                p *= 1 + drift + rnd.uniform(-0.005, 0.005)
            else:
                step = -0.6 * prev + rnd.uniform(-0.03, 0.03)   # noise that partly reverses
                prev = step
                p *= 1 + step
            vol = 500.0 if a < late_from else 100.0
            s[a] = (p, vol)
        per[i] = s
    return per


def label(per, t):
    w = LR.regime(per, t)
    return max(w, key=w.get)


def test_memberships_are_weights():
    per = league()
    for t in (0, 5, 30, 70, 89):
        w = LR.regime(per, t)
        assert set(w) == {"early", "mid", "late"}
        assert abs(sum(w.values()) - 1) < 1e-9 and all(0 <= v <= 1 for v in w.values())


def test_a_league_opens_in_price_discovery():
    per = league()
    for t in range(0, 12):
        assert label(per, t) == "early", t


def test_settled_prices_read_as_mid_and_fading_trade_as_late():
    per = league()
    assert label(per, 45) == "mid"
    assert label(per, 85) == "late"


def test_the_switch_follows_the_market_not_the_calendar():
    """A league whose prices take longer to settle stays EARLY longer."""
    fast, slow = league(discovery=14), league(discovery=30)
    first_mid = lambda per: next(t for t in range(90) if label(per, t) == "mid")  # noqa: E731
    assert first_mid(slow) > first_mid(fast) + 5


def test_it_never_reads_the_future():
    """The answer for day t is the same whether or not later days exist."""
    per = league()
    cut = {i: {a: v for a, v in s.items() if a <= 40} for i, s in per.items()}
    for t in (10, 25, 40):
        assert LR.regime(cut, t) == LR.regime(per, t)


def test_an_empty_league_is_discovery():
    assert LR.regime({}, 3) == {"early": 1.0, "mid": 0.0, "late": 0.0}
