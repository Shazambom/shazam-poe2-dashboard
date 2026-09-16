"""Volume-confirmed matrix-profile discords — the sidecar's first heavy job.

For each liquid item, STUMPY's matrix profile finds the *discord*: the price window least like
anything else the item has done (an anomaly — a pump or crash forming). Raw discords are noisy,
so we keep one only when a VOLUME spike sits inside the discord window (MAD-z on traded value —
the confirmation Movers lacks) AND the spike is RECENT (this is "about to move", not history).

Pure over the shaped series from `marketseries` (so it's unit-testable with planted anomalies);
NUMPY ONLY, so it lives in the lean sidecar binary and never imports the backend.

The non-normalized matrix profile is computed directly in numpy (`_matrix_profile`) rather than
via STUMPY. STUMPY drags numba/llvmlite/scipy, whose native code crashed the frozen PyInstaller
binary on Windows (STATUS_ACCESS_VIOLATION); numpy is pure and can't. `_matrix_profile` is proven
1:1 with `stumpy.stump(a, m, normalize=False)[:,0]` across a fuzz of randomized inputs by the
migration gate `backend/tests/test_sidecar_equivalence.py` (which loads the REAL stumpy). Series
here are short (a league's daily points), so the O(n^2·m) brute force is trivially cheap and
matches STUMPY's STOMP result exactly.

SHORT HORIZONS ARE THE NORM: PoE leagues are short-lived and a fresh league has only a handful of
daily points, so the metric must produce meaning early — not only after weeks. Hence a short motif
(m=3 → signals from ~7 days of data) rather than a long window that would blind the opening week.
Higher-resolution (hourly digest) input is the bigger lever if we need signals even sooner — a
Phase-4 consideration.
"""
from __future__ import annotations

import numpy as np

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


def _matrix_profile(a, m: int) -> np.ndarray:
    """Non-normalized (raw-Euclidean) matrix profile of `a` with subsequence length `m` — the
    numpy equivalent of `stumpy.stump(a, m, normalize=False)[:, 0]`.

    For each length-m window it returns the Euclidean distance to its nearest OTHER window,
    excluding the trivial-match zone `|i-j| <= ceil(m/4)` (STUMPY's default exclusion zone). A
    window with no valid neighbour (all others inside its exclusion zone) gets `inf`, exactly as
    STUMPY does. O(k^2·m) over k = len(a)-m+1 windows — trivial for a league's daily series and
    proven 1:1 with STUMPY by test_sidecar_equivalence."""
    a = np.asarray(a, dtype=float)
    k = a.shape[0] - m + 1
    if k <= 0:
        return np.empty(0, dtype=float)
    subs = np.lib.stride_tricks.sliding_window_view(a, m)   # (k, m) windows, read-only view
    excl = int(np.ceil(m / 4.0))                            # STUMPY_EXCL_ZONE_DENOM = 4
    mp = np.full(k, np.inf, dtype=float)
    for i in range(k):
        diff = subs - subs[i]                               # (k, m)
        d = np.sqrt(np.einsum("ij,ij->i", diff, diff))      # raw Euclidean per window
        lo, hi = max(0, i - excl), min(k, i + excl + 1)     # exclude the trivial-match zone
        d[lo:hi] = np.inf
        if np.isfinite(d).any():
            mp[i] = d.min()
    return mp


def compute(series: dict, meta: dict, *, min_value_ex: float = MIN_VALUE_EX, m: int = 3,
            recent_days: int = 5, vol_z: float = 2.5, top_n: int = 20, _mp=_matrix_profile) -> list[dict]:
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

            # Non-normalized on PURPOSE: a z-normalized matrix profile finds unusual SHAPES and
            # normalizes magnitude away — a 3x price spike becomes just a "step-up". "About to
            # move" is a MAGNITUDE anomaly (pump/crash), so we use the raw-Euclidean profile,
            # whose discord lands on the biggest price dislocation (verified: a planted spike is
            # the discord on both a 7-day and a 30-day series; z-normalized missed it). `_mp` is
            # numpy by default; the equivalence gate injects the real stumpy profile to prove 1:1.
            dist = np.asarray(_mp(closes, m), dtype=float)
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
