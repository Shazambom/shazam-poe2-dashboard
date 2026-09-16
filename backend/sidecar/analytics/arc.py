"""League-arc similarity — DTW over league price-shape signatures (the sidecar's second job).

"Which past league does the current run resemble?" We take each league's anchor-currency arc
(Divine-in-Exalted per league-day, the canonical inflation curve; built by
`marketseries.league_signatures`) and DTW-compare the current partial arc against every past
league's arc over the SAME elapsed phase. The result is a per-league weight vector that replaces
holdscore's flat `GAMMA**rank` recency weighting: past leagues that look like *this* one count more.

Shape, not level: leagues sit at wildly different absolute Divine prices, so each signature is
z-normalized before DTW — a resembling shape at a different price level still wins. Weights are a
softmax over −distance with a scale-free temperature (the median distance), so they're a proper
distribution the backend can drop straight into a weighted mean.

numpy + dtaidistance only (no backend import) so it bundles into the lean sidecar binary. Pure
over plain float lists → unit-testable with planted arcs.
"""
from __future__ import annotations

import numpy as np
from dtaidistance import dtw

MIN_LEN = 3   # need a few points before a shape is meaningful (short leagues are the norm)


def _z(x: np.ndarray) -> np.ndarray:
    """Z-normalize so DTW compares SHAPE, not absolute price level."""
    sd = x.std()
    return (x - x.mean()) / sd if sd > 1e-9 else x - x.mean()


def compute_weights(cur_sig, past_sigs: dict, *, min_len: int = MIN_LEN) -> dict:
    """{league: weight} over past leagues, summing to 1, higher = more like the current arc.

    Returns {} when it can't decide (current arc too short, or no usable past league) — the caller
    then falls back to recency weighting, so a dead/degenerate sidecar degrades to today's Hold."""
    cur = [float(v) for v in cur_sig if v is not None]
    if len(cur) < min_len or not past_sigs:
        return {}
    n = len(cur)
    cz = _z(np.asarray(cur, dtype=float))
    dists: dict = {}
    for lg, sig in past_sigs.items():
        s = [float(v) for v in (sig or []) if v is not None]
        if len(s) < min_len:
            continue
        s = s[:n] if len(s) > n else s          # compare the same elapsed league-phase
        d = dtw.distance(cz, _z(np.asarray(s, dtype=float)))
        if np.isfinite(d):
            dists[lg] = float(d)
    if not dists:
        return {}
    vals = np.asarray(list(dists.values()), dtype=float)
    temp = float(np.median(vals)) or 1.0        # scale-free: normalize distances by their spread
    w = np.exp(-vals / temp)
    w = w / w.sum()
    return {lg: float(wi) for lg, wi in zip(dists.keys(), w)}
