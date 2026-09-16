"""TDD for Phase 6 — the sidecar's first real analytics job: volume-confirmed discords.

"What's about to move": a matrix-profile *discord* (STUMPY) is the most-anomalous window in an
item's price series — a pattern unlike anything else it's done. Raw discords are noisy, so we
gate on a VOLUME spike inside the discord window (MAD-z on traded value) — the confirmation
Movers lacks — and require it to be RECENT (happening now, not league history).

Pure function over the shaped series `marketseries` produces; runs in the lean sidecar binary.

Run:  python -m pytest backend/tests/test_discords.py -q     # needs numpy + stumpy
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from sidecar.analytics import discords  # noqa: E402

DAY = 86400


def _pts(closes, vols, t0=1_700_000_000):
    """[(t, close, value)] with value = close*vol, one point per day."""
    return [(t0 + i * DAY, float(c), float(c) * float(v)) for i, (c, v) in enumerate(zip(closes, vols))]


def _calm(n=30, price=10.0, vol=30_000):
    """A steady, liquid series (value ~= 300k, above the floor) with mild wiggle so STUMPY has
    non-constant windows but no real anomaly."""
    closes = [price + (0.2 if i % 2 else -0.2) for i in range(n)]
    vols = [vol for _ in range(n)]
    return closes, vols


def test_volume_confirmed_recent_discord_surfaces():
    closes, vols = _calm()
    # Plant a sharp, recent price anomaly AND a matching volume spike at day 27.
    closes[27] = 30.0
    vols[27] = 300_000          # value ~= 9M -> huge MAD-z
    series = {1: _pts(closes, vols)}
    meta = {1: ("Divine Orb", "currency")}

    sig = discords.compute(series, meta)
    assert len(sig) == 1
    s = sig[0]
    assert s["item_id"] == 1 and s["name"] == "Divine Orb"
    assert s["vol_z"] >= 3.0
    # the signal points at the spike day (index 27)
    assert s["t"] == series[1][27][0]


def test_price_anomaly_without_volume_is_filtered():
    closes, vols = _calm()
    closes[27] = 30.0           # same price anomaly...
    # ...but volume stays flat -> not volume-confirmed
    series = {1: _pts(closes, vols)}
    meta = {1: ("Divine Orb", "currency")}
    assert discords.compute(series, meta) == []


def test_illiquid_item_is_skipped():
    closes, vols = _calm(vol=100)     # value ~= 1k, far below MIN_VALUE_EX
    closes[27] = 30.0
    vols[27] = 3000
    series = {1: _pts(closes, vols)}
    meta = {1: ("Sneezing Powder", "currency")}
    assert discords.compute(series, meta) == []


def test_old_discord_is_not_recent():
    closes, vols = _calm()
    closes[3] = 30.0            # anomaly early in the league (not recent)
    vols[3] = 300_000
    series = {1: _pts(closes, vols)}
    meta = {1: ("Divine Orb", "currency")}
    assert discords.compute(series, meta, recent_days=5) == []


def test_short_series_skipped_no_crash():
    series = {1: _pts([10, 11, 10], [30000, 30000, 30000])}   # too short for any matrix profile
    assert discords.compute(series, {1: ("X", "c")}) == []


def test_short_league_horizon_still_surfaces_signals():
    """PoE leagues are short-lived — the metric must work early, not only after weeks of data.
    A ~7-day league (the minimum) with a recent volume-confirmed anomaly must still fire."""
    closes = [10.0, 9.8, 10.2, 9.9, 10.1, 9.8, 30.0]     # spike on the last (recent) day
    vols = [30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 300_000]
    series = {1: _pts(closes, vols)}
    meta = {1: ("Divine Orb", "currency")}
    sig = discords.compute(series, meta)
    assert len(sig) == 1 and sig[0]["vol_z"] >= 3.0
    assert sig[0]["t"] == series[1][6][0]


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
