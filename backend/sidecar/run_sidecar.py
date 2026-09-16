"""Sidecar entrypoint: the heavy-analytics runtime the backend spawns as its child.

PyInstaller bundles this as a second single binary (numpy/stumpy). It reads market.sqlite from
DATA_DIR (RO/RW on the disposable market DB), never opens a socket, and dies with the backend
(ARBITER_PARENT_PID + stdin-EOF). See docs/db-architecture.md "Heavy analytics".
"""
import sys
from pathlib import Path

# When frozen, `app`/`sidecar` are on the bundle path; in dev, add backend/ so both import.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sidecar import runner  # noqa: E402


def _selftest() -> int:
    """Exercise the exact path that crashed the frozen Windows binary: import the analytics
    modules and run BOTH heavy jobs' compute once on a tiny synthetic series. Prints OK and
    exits 0 on success; any native fault (STATUS_ACCESS_VIOLATION 0xC0000005 from a bad dep)
    aborts the process with a non-zero code, so the release-desktop-win CI turns red. This is the
    faithful Windows smoke — it runs the FROZEN binary in the same environment that builds it."""
    from sidecar.analytics import arc, discords

    DAY, t0 = 86400, 1_700_000_000
    closes = [10.0, 9.8, 10.2, 9.9, 10.1, 9.8, 30.0]
    vols = [30_000] * 6 + [300_000]
    series = {1: [(t0 + i * DAY, float(c), float(c) * float(v))
                  for i, (c, v) in enumerate(zip(closes, vols))]}
    signals = discords.compute(series, {1: ("Divine Orb", "currency")})
    weights = arc.compute_weights([1, 1.3, 1.6, 1.9, 1.7],
                                  {"A": [10, 13, 16, 19, 17], "B": [1, .8, .6, .4, .3]})
    assert len(signals) == 1 and signals[0]["item_id"] == 1, signals
    assert weights and abs(sum(weights.values()) - 1.0) < 1e-9, weights
    print(f"sidecar selftest OK: discords={signals} arc={weights}")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(_selftest())
    runner.main()
