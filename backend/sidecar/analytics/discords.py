"""Volume-confirmed matrix-profile discords — the sidecar's first heavy job.

For each liquid item, STUMPY's matrix profile finds the *discord*: the price window least like
anything else the item has done (an anomaly — a pump or crash forming). Raw discords are noisy,
so we keep one only when a VOLUME spike sits inside the discord window (MAD-z on traded value —
the confirmation Movers lacks) AND the spike is RECENT (this is "about to move", not history).

Pure over the shaped series from `marketseries` (so it's unit-testable with planted anomalies);
numpy + stumpy only, so it lives in the lean sidecar binary and never imports the backend.

SHORT HORIZONS ARE THE NORM: PoE leagues are short-lived and a fresh league has only a handful of
daily points, so the metric must produce meaning early — not only after weeks. Hence a short motif
(m=3 → signals from ~7 days of data) rather than a long window that would blind the opening week.
Higher-resolution (hourly digest) input is the bigger lever if we need signals even sooner — a
Phase-4 consideration.
"""
from __future__ import annotations

import numpy as np
import stumpy

# Median daily traded VALUE (Exalted) floor — mirrors movers.MIN_VALUE_EX. The sidecar stays
# standalone (no backend import), so the constant is duplicated deliberately.
MIN_VALUE_EX = 100_000.0


Z_CAP = 50.0   # a z past this is already "unmistakable spike"; the exact value is meaningless


def _mad_z(arr: np.ndarray, i: int) -> float:
    """Signed modified z-score of arr[i] vs the series (robust to outliers). High positive = a
    genuine spike above the item's normal traded volume. MAD is floored relative to the median so
    a near-constant series (or FP noise) can't explode the score, and the result is clamped."""
    med = np.median(arr)
    mad = np.median(np.abs(arr - med))
    floor = 1e-6 * abs(med) + 1e-9
    if mad < floor:
        mad = floor
    z = 0.6745 * (arr[i] - med) / mad
    return float(max(-Z_CAP, min(Z_CAP, z)))


def compute(series: dict, meta: dict, *, min_value_ex: float = MIN_VALUE_EX, m: int = 3,
            recent_days: int = 5, vol_z: float = 2.5, top_n: int = 20) -> list[dict]:
    """Return volume-confirmed recent discord signals, strongest first (ranked by vol_z, capped at
    top_n): [{item_id, name, t, mp_dist, vol_z, close}]. It's a ranked shortlist, not a binary
    alarm — the vol_z floor (default 2.5 ≈ a clear robust outlier) is deliberately modest so the
    metric fires on SHORT leagues where MAD-z is statistically compressed by few points; ranking +
    top_n keep it tight. Each item is guarded — a bad series is skipped, never fatal to the batch."""
    out: list[dict] = []
    for item_id, pts in series.items():
        try:
            if len(pts) < 2 * m + 1:                 # need enough history for a stable profile
                continue
            closes = np.asarray([p[1] for p in pts], dtype=float)
            values = np.asarray([p[2] for p in pts], dtype=float)
            if float(np.median(values)) < min_value_ex:      # liquidity floor (traded VALUE)
                continue
            # Confirm on VOLUME (units = value/close), NOT value: a price spike alone tripling
            # value must not masquerade as heavy trading. This independence is the point.
            volumes = np.divide(values, closes, out=np.zeros_like(values), where=closes > 0)

            # normalize=False on PURPOSE: the default z-normalized matrix profile finds unusual
            # SHAPES and normalizes magnitude away — a 3x price spike becomes just a "step-up".
            # "About to move" is a MAGNITUDE anomaly (pump/crash), so we want the non-normalized
            # profile, whose discord lands on the biggest price dislocation (verified: a planted
            # spike is the discord on both a 7-day and a 30-day series; z-normalized missed it).
            mp = stumpy.stump(closes, m, normalize=False)
            dist = np.asarray(mp[:, 0], dtype=float)
            dist[~np.isfinite(dist)] = -np.inf               # ignore constant-window nan/inf
            if not np.isfinite(dist).any():
                continue
            di = int(np.argmax(dist))                        # discord window start

            # Volume-confirm within the discord window: take the strongest spike there.
            n = len(pts)
            window = range(di, min(di + m, n))
            vz, spike_j = max((_mad_z(volumes, j), j) for j in window)
            if vz < vol_z:                                   # not volume-confirmed
                continue
            if spike_j < n - recent_days:                    # not recent -> not "about to move"
                continue

            out.append({
                "item_id": item_id,
                "name": meta.get(item_id, ("?", ""))[0],
                "t": pts[spike_j][0],
                "mp_dist": float(dist[di]),
                "vol_z": round(float(vz), 2),
                "close": float(closes[spike_j]),
            })
        except Exception:
            continue

    out.sort(key=lambda s: s["vol_z"], reverse=True)
    return out[:top_n]
