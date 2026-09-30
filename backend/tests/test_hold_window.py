"""TDD for Hold's window: it is the holding period, and the ranking answers it.

Owner, 2026-09-30: "The window is asking 'how long I want to hold this asset for'" … "And the hold should
tell you the best currency to hold for that duration" … "the window should influence the scoring."
Bug: docs/bugs/2026-09-30-hold-ignores-the-time-window.md. Measurements: docs/hold-research.md "The
window is the holding period".

The contract (`holdscore.hold_rank(..., hold=days)`):
    price    — weighs 1 + PRICE_SHORT / hold²: over a day the price level protects, the climb hasn't time to pay
    forecast — what the item did over the next `hold` days from this league-day in earlier leagues
               (`_predict`, >= FORECAST_MIN_LEAGUES of them); weighs FORECAST_W × hold / 7
    trend    — read over max(TREND_DAYS, 2 × hold) days
    14d is a real window (`horizon_for(336) == "14d"`).

    python -m pytest backend/tests/test_hold_window.py -q
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app import holdscore  # noqa: E402


def series(prices, value=1e8):
    return {a: (p, value) for a, p in enumerate(prices)}


def steady(p0, rate, days):
    return [p0 * (1 + rate) ** a for a in range(days)]


def universe(t=24):
    return [(100 + i, series(steady(5 + i, 0.005 * (i % 5 - 2), t + 1))) for i in range(20)]


def order(entries, hold, t=24, past=()):
    sc = holdscore.hold_rank(entries, t, None, past, None, hold=hold)
    return sorted(sc, key=lambda i: -sc[i])


# ------------------------------------------------------------------ the windows the app offers

@pytest.mark.parametrize("hours,horizon,days", [(24, "1d", 1), (72, "3d", 3), (168, "7d", 7), (336, "14d", 14)])
def test_every_window_the_app_offers_is_its_own_holding_period(hours, horizon, days):
    assert holdscore.horizon_for(hours) == horizon
    assert holdscore.HORIZON_DAYS[horizon] == days


def test_a_window_longer_than_the_app_offers_is_the_longest_one():
    assert holdscore.horizon_for(720) == "14d"


# ------------------------------------------------------------------ the window moves the ranking

def test_the_scores_depend_on_the_holding_period():
    ents = universe() + [(1, series(steady(700.0, 0.0, 25))), (2, series(steady(8.0, 0.02, 25)))]
    day, fortnight = (holdscore.hold_rank(ents, 24, None, (), None, hold=h) for h in (1, 14))
    assert day != fortnight


def test_a_short_hold_leans_on_the_price_level_and_a_long_hold_on_the_climb():
    """An expensive asset that goes nowhere against a cheaper one that climbs steadily: for a day the
    expensive one is the safer park (it moves least); over two weeks the climb is what you earn."""
    rich = (1, series(steady(700.0, 0.0005, 25)))
    climber = (2, series(steady(14.5, 0.004, 25)))
    ents = universe() + [rich, climber]
    day, fortnight = holdscore.hold_rank(ents, 24, None, (), None, hold=1), holdscore.hold_rank(ents, 24, None, (), None, hold=14)
    assert day[1] - day[2] > fortnight[1] - fortnight[2], "the price level counts for more over a day"


def _three_leagues(items):
    """Three earlier leagues with the same paths: {item_id: prices by league-day}."""
    return [(f"Past {n}", {iid: series(p) for iid, p in items.items()}) for n in (3, 2, 1)]


def test_a_long_hold_reads_what_the_item_did_from_this_league_day_in_earlier_leagues():
    """Two assets with the same path this league. In every earlier league one kept climbing for the two
    weeks after league-day 24 and the other sagged. For a 14-day hold the climber ranks clearly above;
    for a 1-day hold that forecast barely counts."""
    now = steady(40.0, 0.01, 25)
    flat = [40.0] * 80
    rose = [40.0] * 22 + [40.0 * 1.02 ** d for d in range(58)]
    sagged = [40.0] * 22 + [40.0 * 0.99 ** d for d in range(58)]
    past = _three_leagues({**{i: flat for i in range(100, 120)}, 1: rose, 2: sagged})
    ents = universe() + [(1, series(now)), (2, series(now))]
    day = holdscore.hold_rank(ents, 24, None, past, None, hold=1)
    fortnight = holdscore.hold_rank(ents, 24, None, past, None, hold=14)
    assert fortnight[1] > fortnight[2]
    assert fortnight[1] - fortnight[2] > 3 * (day[1] - day[2])


def test_the_forecast_waits_for_three_earlier_leagues():
    """Two earlier leagues are too few to forecast from (the arrows' measured limit): the pair that
    differ only in their past-league path rank the same on the forecast."""
    now = steady(40.0, 0.01, 25)
    rose = [40.0] * 22 + [40.0 * 1.02 ** d for d in range(58)]
    sagged = [40.0] * 22 + [40.0 * 0.99 ** d for d in range(58)]
    past = _three_leagues({1: rose, 2: sagged})[:2]
    ents = universe() + [(1, series(now)), (2, series(now))]
    w = holdscore._regime_weights(holdscore._EARLY_ONLY, holdscore.CAUTION_K, 24, 14)
    assert w["forecast"] == pytest.approx(holdscore.FORECAST_W * 2)
    sig = dict(holdscore._rank_signals(ents, 24, past, w, 14))
    assert sig[1]["forecast"] is None and sig[2]["forecast"] is None


def test_the_trend_is_read_over_a_span_that_grows_with_the_hold():
    """Flat for a month, then climbing for the last two weeks: a week-long hold reads the last 14 days
    (all climb); a 14-day hold reads 28 days, half of them flat, so its climb is less clean."""
    p = [10.0] * 30 + [10.0 * 1.02 ** d for d in range(1, 17)]
    week = holdscore._signals(series(p), 45, 7)["trend"]
    fortnight = holdscore._signals(series(p), 45, 14)["trend"]
    assert fortnight < week
    assert holdscore._signals(series(p), 45, 1)["trend"] == pytest.approx(week), "short holds keep the 14-day read"


def test_the_weights_at_a_week_are_the_tuned_ones_but_for_the_window_terms():
    week = holdscore._regime_weights(holdscore._EARLY_ONLY, holdscore.CAUTION_K, 24, 7)
    day = holdscore._regime_weights(holdscore._EARLY_ONLY, holdscore.CAUTION_K, 24, 1)
    assert day["price"] / week["price"] == pytest.approx((1 + holdscore.PRICE_SHORT) / (1 + holdscore.PRICE_SHORT / 49))
    assert day["forecast"] == pytest.approx(holdscore.FORECAST_W / 7)
    for name in ("kept", "trend", "dip", "record"):
        assert day[name] == pytest.approx(week[name])


# ------------------------------------------------------------------ the board

def _board(monkeypatch, horizon):
    """A league at day 24 with three earlier leagues: `_leaderboard` for one window."""
    t = 24
    cur = {100 + i: series(steady(5 + i, 0.005 * (i % 5 - 2), t + 1)) for i in range(24)}
    cur[1] = series(steady(700.0, 0.0005, t + 1))
    cur[2] = series(steady(14.5, 0.004, t + 1))
    cur[291] = series([1.0] * (t + 1))
    past_paths = {i: [5.0 + (i % 7)] * 80 for i in cur}
    for i in list(cur)[::3]:
        past_paths[i] = [5.0] * 22 + [5.0 * 1.015 ** d for d in range(58)]
    past = [(f"Past {n}", {i: series(p) for i, p in past_paths.items()}) for n in (3, 2, 1)]
    meta = {i: (f"Item {i}", "currency") for i in cur}
    monkeypatch.setattr(holdscore, "build_context", lambda num_id: ("Now", cur, past, meta))
    monkeypatch.setattr(holdscore, "_arc_weights", lambda name: None)
    monkeypatch.setattr(holdscore, "regime_of", lambda league: None)
    from app import currencies, movers
    monkeypatch.setattr(movers, "exchange_cards", lambda names, hours, num=None: {})
    monkeypatch.setattr(currencies.registry, "resolve_meta", lambda meta_id: "divine")
    return holdscore._leaderboard(horizon, "all", "divine", 291, "Divine Orb", holdscore.CAUTION_K)


def test_the_board_changes_with_the_window(monkeypatch):
    day, fortnight = _board(monkeypatch, "1d"), _board(monkeypatch, "14d")
    assert fortnight["horizon"] == "14d" and fortnight["delta_days"] == 14 and fortnight["window_h"] == 336
    assert [a["id"] for a in day["assets"]] != [a["id"] for a in fortnight["assets"]], "the order follows the window"
    assert [a["hold"] for a in day["assets"]] != [a["hold"] for a in fortnight["assets"]], "and so do the scores"


def test_the_public_leaderboard_accepts_14d(monkeypatch):
    seen = {}
    monkeypatch.setattr(holdscore, "_leaderboard", lambda horizon, *a: seen.setdefault("hz", horizon) and {})
    holdscore.invalidate()
    holdscore.leaderboard("14d", "all", "divine", k=2.0)
    holdscore.invalidate()
    assert seen["hz"] == "14d"
