"""Tests for backend/app/inflation.py — clean, despiked, honest inflation computation.

Covers:
  - 7d velocity (OLS trend) vs 24h change: gap-aware time regression, sub-day guard,
    exact recovery of known daily inflation rate.
  - Single-hour outlier despiking without erasing persistent or post-gap moves, and
    preserving local weight in the basket after VWMA cleanup.
  - Thin-anchor (Lock/Mirror) volume-weighted smoothing so a 1-trade hour doesn't
    jerk every chained currency line and the basket.
  - Divine-unit weighting in the basket (Divine weighted by Divine volume, not Lock count).
  - Core soft currencies always included and used for the headline basket, hard anchors
    excluded from soft series, extra watchlist items marked default_on=False.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import db, inflation, marketseries, settings
from app.currencies import registry

HOUR = 3600
LEAGUE = "Test League Inflation"

DIV = marketseries.ANCHORS["divine"].metadata_id
LOCK = marketseries.ANCHORS["lock"].metadata_id
MIRROR = marketseries.ANCHORS["mirror"].metadata_id
CHAOS = marketseries.ANCHORS["chaos"].metadata_id
EXALT = registry.metas("exalted")[0]
OMEN = "Metadata/Items/Currency/OmenOnChaosAddMod"


@pytest.fixture(autouse=True)
def _clean_inflation_league():
    inflation._cache.clear()
    with db.tx() as c:
        c.execute("DELETE FROM digest_markets WHERE league = ?", (LEAGUE,))
    yield
    inflation._cache.clear()
    with db.tx() as c:
        c.execute("DELETE FROM digest_markets WHERE league = ?", (LEAGUE,))


def _seed_market(rows: list[tuple[int, str, str, float, float]]) -> None:
    """Reset this test module's league rows and insert (hour, cur_a, cur_b, vol_a, vol_b)."""
    inflation._cache.clear()
    with db.tx() as c:
        c.execute("DELETE FROM digest_markets WHERE league = ?", (LEAGUE,))
        c.executemany(
            "INSERT INTO digest_markets (league, hour, market_id, cur_a, cur_b, vol_a, vol_b) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(LEAGUE, h, f"{a}|{b}", a, b, va, vb) for h, a, b, va, vb in rows],
        )


def _use_settings(monkeypatch, watchlist: list[str]) -> None:
    s = dict(settings.DEFAULTS, league=LEAGUE, watchlist=watchlist)
    monkeypatch.setattr(inflation, "get_settings", lambda: s)


def test_velocity_uses_7d_trend_and_ignores_noisy_24h_wiggle(monkeypatch):
    """Per-day velocity fits the 7-day log trend, so a 1-day pullback doesn't flip a 7d uptrend."""
    _use_settings(monkeypatch, ["chaos", "exalted", "divine"])
    now_h = (int(time.time()) // HOUR) * HOUR
    rows = []
    # 10 days (240h): days 0..2 flat, days 3..8 climb +3%/day, last 24h dips -2%
    for i in range(241):
        h = now_h - (240 - i) * HOUR
        if i <= 72:
            rate = 100.0
        elif i <= 216:
            rate = 100.0 * (1.03 ** ((i - 72) / 24.0))
        else:
            peak = 100.0 * (1.03 ** 6.0)
            rate = peak * (0.98 ** ((i - 216) / 24.0))
        rows.append((h, CHAOS, DIV, rate * 1000.0, 1000.0))
        rows.append((h, EXALT, DIV, rate * 5000.0, 1000.0))
    _seed_market(rows)

    res = inflation.compute("divine", hours=336)
    b = res["basket"]
    assert b["change_24h_pct"] is not None and b["change_24h_pct"] < 0
    assert b["velocity_pct_per_day"] is not None
    # 7-day OLS pace must stay clearly positive (~+2.5%/day), not flip negative from the last 24h dip
    assert 1.5 <= b["velocity_pct_per_day"] <= 3.5


def test_velocity_handles_hour_gaps_by_elapsed_time(monkeypatch):
    """Missing hours in the trend window must not inflate %/day by dividing by point count."""
    _use_settings(monkeypatch, ["chaos", "divine"])
    now_h = (int(time.time()) // HOUR) * HOUR
    rows = []
    # 7 days (168h), only every 3rd hour traded, climbing +3%/day
    for i in range(169):
        if i % 3 != 0:
            continue
        h = now_h - (168 - i) * HOUR
        rate = 100.0 * (1.03 ** (i / 24.0))
        rows.append((h, CHAOS, DIV, rate * 1000.0, 1000.0))
    _seed_market(rows)

    res = inflation.compute("divine", hours=240)
    vel = res["basket"]["velocity_pct_per_day"]
    assert vel is not None
    # Time-based OLS over sparse 3h points must still recover ~+3%/day, not ~+9%/day
    assert 2.5 <= vel <= 3.5


def test_thin_regal_is_not_in_core_default_series():
    """Regal Orb trades too thinly against Divine (~8 div/hr with 1:999 prints) to be a default core curve."""
    assert "regal" not in inflation.CORE_SOFT
    assert set(inflation.CORE_SOFT) == {"exalted", "vaal", "chaos", "annul", "divine"}


def test_single_hour_spike_is_suppressed_while_real_trend_persists(monkeypatch):
    """A 1-hour bad print (e.g. 2x ratio) is despiked, but a multi-hour move stays intact."""
    _use_settings(monkeypatch, ["chaos", "divine"])
    now_h = (int(time.time()) // HOUR) * HOUR
    rows = []
    for i in range(60):
        h = now_h - (59 - i) * HOUR
        if i == 30:
            rate = 220.0  # single-hour fat-finger spike
        elif i >= 45:
            rate = 135.0  # persistent +35% regime shift for 15 hours
        else:
            rate = 100.0
        rows.append((h, CHAOS, DIV, rate * 1000.0, 1000.0))
    _seed_market(rows)

    res = inflation.compute("divine", hours=96)
    chaos = next(c for c in res["currencies"] if c["id"] == "chaos")
    vals = [p["v"] for p in chaos["points"]]
    # Spike at hour 30 must NOT appear as ~220
    assert max(vals) < 150.0
    # Persistent move to 135 at the end must survive
    assert 130.0 <= chaos["current"] <= 140.0


def test_thin_anchor_hour_does_not_crash_chained_series(monkeypatch):
    """A single 1-Lock trade 15% off market between 20-Lock hours must be smoothed by volume."""
    _use_settings(monkeypatch, ["chaos", "divine"])
    now_h = (int(time.time()) // HOUR) * HOUR
    rows = []
    for i in range(60):
        h = now_h - (59 - i) * HOUR
        rows.append((h, CHAOS, DIV, 10_000.0, 1000.0))  # steady 10 chaos/div
        if i == 35:
            # 1 Lock traded 15% low (1700 vs 2000)
            rows.append((h, DIV, LOCK, 1700.0, 1.0))
        else:
            rows.append((h, DIV, LOCK, 40_000.0, 20.0))  # steady 2000 div/lock
    _seed_market(rows)

    res = inflation.compute("lock", hours=96)
    chaos = next(c for c in res["currencies"] if c["id"] == "chaos")
    vals = [p["v"] for p in chaos["points"]]
    # Without volume smoothing, hour 35 crashes to 85.0 (-15%). With VWMA, dip stays < 3%.
    assert min(vals) > 97.0


def test_divine_weighted_in_divine_units_not_lock_count(monkeypatch):
    """In the Lock-anchored basket, Divine must be weighted by Divine volume, not Lock count."""
    _use_settings(monkeypatch, ["chaos", "divine"])
    now_h = (int(time.time()) // HOUR) * HOUR
    rows = []
    for i in range(60):
        h = now_h - (59 - i) * HOUR
        # First 24h base: Chaos/Div = 10, Div/Lock = 2000 (Chaos/Lock = 20000)
        # After hour 30: Div/Lock stays 2000 (Divine index = 100), Chaos/Div doubles to 20 (Chaos index = 200)
        # Divine/Lock trades 20,000 Div (10 Locks); Chaos/Div trades 1,000 Div.
        # Properly weighted in Divine units, Divine has 20x Chaos's weight -> basket stays close to 100 (~103).
        # With the old unit bug (Lock count=10 vs Div vol=1000), Chaos got 100x weight -> basket hit ~199!
        c_rate = 10.0 if i < 30 else 20.0
        rows.append((h, CHAOS, DIV, c_rate * 1000.0, 1000.0))
        rows.append((h, DIV, LOCK, 20_000.0, 10.0))
    _seed_market(rows)

    res = inflation.compute("lock", hours=96)
    # Basket must reflect Divine's 20x higher Divine-denominated volume, not collapse to Chaos's 200
    assert res["basket"]["since_base_pct"] < 15.0


def test_core_currencies_always_included_hard_anchors_excluded_and_extras_default_off(monkeypatch):
    """Board watchlist without Exalted and with Mirror + Omen must still chart core softs,
    never plot hard anchors (Mirror/Lock), mark extra watchlist items default_on=False, and
    compute the headline basket from core currencies only."""
    # Register Omen metadata if needed via monkeypatch on _metas/name
    orig_metas = inflation._metas
    orig_name = inflation.registry.name

    def fake_metas(tid):
        if tid == "omen-of-whittling":
            return [OMEN]
        return orig_metas(tid)

    monkeypatch.setattr(inflation, "_metas", fake_metas)
    monkeypatch.setattr(inflation.registry, "name", lambda tid: "Omen of Whittling" if tid == "omen-of-whittling" else orig_name(tid))
    _use_settings(monkeypatch, ["mirror", "hinekoras-lock", "omen-of-whittling", "chaos", "divine"])

    now_h = (int(time.time()) // HOUR) * HOUR
    rows = []
    for i in range(48):
        h = now_h - (47 - i) * HOUR
        rows.append((h, DIV, LOCK, 20_000.0, 10.0))
        rows.append((h, MIRROR, DIV, 2.0, 10_000.0))
        rows.append((h, EXALT, DIV, (100.0 if i < 24 else 110.0) * 500.0, 500.0))
        rows.append((h, CHAOS, DIV, (10.0 if i < 24 else 11.0) * 1000.0, 1000.0))
        # Extra watchlist item explodes 3x with huge volume — must NOT warp headline basket!
        rows.append((h, OMEN, DIV, (1.0 if i < 24 else 3.0) * 50_000.0, 50_000.0))
    _seed_market(rows)

    res = inflation.compute("lock", hours=96)
    by_id = {c["id"]: c for c in res["currencies"]}

    # Hard anchors must never be plotted as soft currencies
    assert "mirror" not in by_id
    assert "hinekoras-lock" not in by_id

    # Exalted must be present and default_on even though omitted from watchlist
    assert "exalted" in by_id and by_id["exalted"]["default_on"] is True
    assert "chaos" in by_id and by_id["chaos"]["default_on"] is True
    assert "divine" in by_id and by_id["divine"]["default_on"] is True

    # Extra watchlist item is present so user can toggle it on, but starts off and doesn't pollute basket
    assert "omen-of-whittling" in by_id and by_id["omen-of-whittling"]["default_on"] is False
    # Headline basket comes from core currencies (~0% to +10%), NOT pulled toward Omen's +200%
    assert res["basket"]["since_base_pct"] < 20.0


def test_despiked_divine_hour_keeps_basket_weight(monkeypatch):
    """A single despiked Divine/Lock hour must NOT drop Divine out of the basket geometric mean."""
    _use_settings(monkeypatch, ["chaos", "divine"])
    now_h = (int(time.time()) // HOUR) * HOUR
    rows = []
    for i in range(60):
        h = now_h - (59 - i) * HOUR
        # Chaos is +80% after hour 30 (small volume = 500 Div); Divine is flat at 2000 Div/Lock (huge volume = 20,000 Div)
        c_rate = 10.0 if i < 30 else 18.0
        rows.append((h, CHAOS, DIV, c_rate * 500.0, 500.0))
        if i == 50:
            # Single bad print on Divine/Lock (3x outlier) -> despiked by _despike, smoothed by _vwma
            rows.append((h, DIV, LOCK, 60_000.0, 10.0))
        else:
            rows.append((h, DIV, LOCK, 20_000.0, 10.0))
    _seed_market(rows)

    res = inflation.compute("lock", hours=96)
    pts = {p["t"]: p["v"] for p in res["basket"]["points"]}
    h_spike = now_h - (59 - 50) * HOUR
    # If Divine were dropped from basket[h_spike], basket would jump to Chaos's ~180.
    # With restored neighbor weight, Divine keeps dominating (~101-105).
    assert pts[h_spike] < 115.0


def test_despike_does_not_compare_across_multiday_gap():
    """Legitimate moves after a multi-day gap on a thin anchor must not be overwritten by pre-gap prices."""
    base_h = 1_700_000_000
    series = {
        base_h + 0 * HOUR: (100.0, 10.0),
        base_h + 1 * HOUR: (100.0, 10.0),
        base_h + 2 * HOUR: (100.0, 10.0),
        # 72-hour gap, then new regime at 160
        base_h + 75 * HOUR: (160.0, 10.0),
        base_h + 76 * HOUR: (162.0, 10.0),
    }
    cleaned = inflation._despike(series)
    assert cleaned[base_h + 75 * HOUR][0] == 160.0
    assert cleaned[base_h + 75 * HOUR][1] == 10.0


def test_ols_daily_pct_guards_subday_span_and_overflow():
    """Sub-24h spans return None instead of wildly extrapolating; extreme slopes never raise OverflowError."""
    base_h = 1_700_000_000
    # 2 points 1 hour apart -> None
    assert inflation._ols_daily_pct([(base_h, 100.0), (base_h + HOUR, 300.0)]) is None
    # Extreme jump over 24h -> finite clamped float, never OverflowError
    val = inflation._ols_daily_pct([(base_h, 1.0), (base_h + 24 * HOUR, 1e30)])
    assert val is not None and val > 0

