"""Phase 7a MIGRATION GATE — the numpy sidecar must be 1:1 with the heavy libraries.

The sidecar's two heavy jobs (matrix-profile discords, DTW league-arc) crash the frozen
PyInstaller binary on Windows because their native deps (numba/llvmlite via STUMPY, the C
core of dtaidistance) die with STATUS_ACCESS_VIOLATION (0xC0000005). Phase 7a replaces those
libraries with pure-numpy implementations so the sidecar bundles as numpy-only and can't crash
natively.

This is the gate that lets us cut the deps: it LOADS THE REAL heavy libraries (`stumpy`,
`dtaidistance`) alongside the new numpy code and asserts they agree **1:1** on a **fuzz** of
randomized inputs — not a handful of fixtures. If a single seed disagrees beyond a tight
numerical tolerance, the swap is not faithful and the deps stay. Because it needs the real
libraries, it runs in the sidecar venv:

    desktop/.venv-sidecar/bin/python -m pytest backend/tests/test_sidecar_equivalence.py -q

Once Phase 7a ships and this stays green, it is the permanent proof that the numpy sidecar
computes exactly what the heavy libraries did.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from sidecar.analytics import arc, discords  # noqa: E402

# The real heavy libraries. If they're missing we're not in the sidecar venv — skip loudly
# rather than silently pass (a green run must mean the comparison actually happened).
stumpy = pytest.importorskip("stumpy", reason="run in desktop/.venv-sidecar (needs real stumpy)")
_dtai = pytest.importorskip("dtaidistance", reason="run in desktop/.venv-sidecar (needs real dtaidistance)")
from dtaidistance import dtw as _dtw_lib  # noqa: E402

# Tight but not zero: STUMPY computes the profile via running dot-products (STOMP), the numpy
# impl sums squared diffs directly, so the two accumulate FP error differently. 1e-6 relative
# is "the same number" for price series, not "close enough".
RTOL, ATOL = 1e-6, 1e-6

# Fuzz breadth: enough seeds/shapes that a subtle off-by-one in the exclusion zone or a wrong
# cost formula cannot hide. Kept in the low hundreds so the gate runs in a couple seconds.
N_SEEDS = 120


def _rng(seed):
    return np.random.default_rng(seed)


def _series(rng, n):
    """A price-like series: a random walk (so windows genuinely differ) with occasional spikes,
    the shape discords is built to find. Mixed magnitudes stress the non-normalized distance."""
    base = 10.0 ** rng.uniform(-1, 3)                       # leagues live at wildly different levels
    walk = base + np.cumsum(rng.normal(0, base * 0.05, n))
    walk = np.abs(walk) + 1e-3                              # prices are positive
    for _ in range(rng.integers(0, 3)):                    # 0-2 planted spikes
        walk[rng.integers(0, n)] *= rng.uniform(2, 6)
    return walk.astype(float)


# ---------------------------------------------------------------------------
# Matrix profile: discords._matrix_profile(a, m) must equal stumpy.stump(a, m, normalize=False)[:,0]
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("seed", range(N_SEEDS))
def test_matrix_profile_matches_stumpy(seed):
    rng = _rng(seed)
    m = int(rng.integers(3, 8))
    n = int(rng.integers(2 * m + 1, 60))                   # discords.compute's own length floor
    a = _series(rng, n)

    mine = np.asarray(discords._matrix_profile(a, m), dtype=float)
    theirs = np.asarray(stumpy.stump(a, m, normalize=False)[:, 0], dtype=float)

    assert mine.shape == theirs.shape, f"seed={seed} m={m} n={n}"
    # Same non-finite pattern (a window with no valid neighbour → inf in both), then 1:1 on the rest.
    fin_m, fin_t = np.isfinite(mine), np.isfinite(theirs)
    assert np.array_equal(fin_m, fin_t), f"seed={seed} finite mask differs\nmine={mine}\ntheirs={theirs}"
    assert np.allclose(mine[fin_t], theirs[fin_t], rtol=RTOL, atol=ATOL), (
        f"seed={seed} m={m} n={n}\nmine  ={mine[fin_t]}\ntheirs={theirs[fin_t]}"
    )


def test_matrix_profile_argmax_never_disagrees():
    """The signal only depends on the DISCORD (argmax of the profile). Even inside tolerance a
    tie could flip argmax, so assert the two impls pick the SAME discord across the whole fuzz —
    this is the property discords.compute actually consumes."""
    for seed in range(N_SEEDS):
        rng = _rng(1000 + seed)
        m = int(rng.integers(3, 8))
        n = int(rng.integers(2 * m + 1, 60))
        a = _series(rng, n)
        mine = np.asarray(discords._matrix_profile(a, m), dtype=float)
        theirs = np.asarray(stumpy.stump(a, m, normalize=False)[:, 0], dtype=float)
        mine[~np.isfinite(mine)] = -np.inf
        theirs[~np.isfinite(theirs)] = -np.inf
        assert int(np.argmax(mine)) == int(np.argmax(theirs)), f"discord disagrees at seed={seed}"


def test_discords_compute_end_to_end_identical():
    """Belt and braces: the FULL public entrypoint must return the same signals whether it's
    backed by numpy or (temporarily) stumpy. We compare numpy-compute against a stumpy-backed
    reference built from the same real library the gate loads."""
    DAY = 86400

    def stumpy_profile(a, m):
        return np.asarray(stumpy.stump(np.asarray(a, float), m, normalize=False)[:, 0], dtype=float)

    for seed in range(40):
        rng = _rng(7000 + seed)
        series, meta = {}, {}
        for item_id in range(rng.integers(1, 6)):
            n = int(rng.integers(10, 45))
            closes = _series(rng, n)
            vols = np.abs(rng.normal(30_000, 8_000, n)) + 100
            k = int(rng.integers(0, n))
            vols[k] *= rng.uniform(3, 15)                  # a volume spike to (maybe) confirm
            t0 = 1_700_000_000
            series[item_id] = [(t0 + i * DAY, float(c), float(c) * float(v))
                               for i, (c, v) in enumerate(zip(closes, vols))]
            meta[item_id] = (f"item{item_id}", "currency")

        got = discords.compute(series, meta)
        want = discords.compute(series, meta, _mp=stumpy_profile)   # same code, heavy-lib profile
        assert got == want, f"seed={seed}\nnumpy={got}\nstumpy={want}"


# ---------------------------------------------------------------------------
# DTW: arc._dtw(a, b) must equal dtaidistance.dtw.distance(a, b)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("seed", range(N_SEEDS))
def test_dtw_matches_dtaidistance(seed):
    rng = _rng(2000 + seed)
    a = _series(rng, int(rng.integers(3, 40)))
    b = _series(rng, int(rng.integers(3, 40)))
    mine = float(arc._dtw(a, b))
    theirs = float(_dtw_lib.distance(a, b))
    assert np.isclose(mine, theirs, rtol=RTOL, atol=ATOL), (
        f"seed={seed} len(a)={len(a)} len(b)={len(b)} mine={mine} theirs={theirs}"
    )


def test_dtw_z_normalized_like_arc_uses_it():
    """arc.compute_weights feeds DTW z-normalized signatures, so equivalence must hold there too
    (small values near zero — where atol matters more than rtol)."""
    for seed in range(N_SEEDS):
        rng = _rng(3000 + seed)
        a = arc._z(_series(rng, int(rng.integers(3, 40))))
        b = arc._z(_series(rng, int(rng.integers(3, 40))))
        mine = float(arc._dtw(a, b))
        theirs = float(_dtw_lib.distance(np.ascontiguousarray(a), np.ascontiguousarray(b)))
        assert np.isclose(mine, theirs, rtol=1e-6, atol=1e-6), f"seed={seed} mine={mine} theirs={theirs}"


def test_compute_weights_ranking_identical_to_dtaidistance():
    """The property arc actually exports is the WEIGHT RANKING over past leagues. Prove numpy-DTW
    and dtaidistance produce the same ordering (and near-identical weights) on random league fields."""
    def dtai_weights(cur, past, min_len=arc.MIN_LEN):
        cur = [float(v) for v in cur if v is not None]
        if len(cur) < min_len or not past:
            return {}
        n = len(cur)
        cz = arc._z(np.asarray(cur, float))
        dists = {}
        for lg, sig in past.items():
            s = [float(v) for v in (sig or []) if v is not None]
            if len(s) < min_len:
                continue
            s = s[:n] if len(s) > n else s
            d = _dtw_lib.distance(np.ascontiguousarray(cz), np.ascontiguousarray(arc._z(np.asarray(s, float))))
            if np.isfinite(d):
                dists[lg] = float(d)
        if not dists:
            return {}
        vals = np.asarray(list(dists.values()), float)
        temp = float(np.median(vals)) or 1.0
        w = np.exp(-vals / temp)
        w = w / w.sum()
        return {lg: float(wi) for lg, wi in zip(dists.keys(), w)}

    for seed in range(60):
        rng = _rng(4000 + seed)
        cur = list(_series(rng, int(rng.integers(4, 20))))
        past = {f"L{k}": list(_series(rng, int(rng.integers(3, 20))))
                for k in range(rng.integers(2, 7))}
        got = arc.compute_weights(cur, past)
        want = dtai_weights(cur, past)
        assert set(got) == set(want), f"seed={seed} keys differ"
        if got:
            order_got = sorted(got, key=got.get, reverse=True)
            order_want = sorted(want, key=want.get, reverse=True)
            assert order_got == order_want, f"seed={seed} ranking differs\n{got}\n{want}"
            for lg in got:
                assert np.isclose(got[lg], want[lg], rtol=1e-6, atol=1e-6), f"seed={seed} {lg}"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
