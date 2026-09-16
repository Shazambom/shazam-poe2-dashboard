"""TDD for Phase 6 — the parent-death watchdog (supervision tree Electron→backend→sidecar).

No child in the tree may outlive its parent. Primary signal is cross-platform stdin-EOF (the
parent holds the child's stdin open; death closes it → EOF). A POSIX PARENT_PID poll is the
backup. Both a hard Electron crash (backend must die) and a backend crash (sidecar must die)
are covered. Stdlib-only so the lean sidecar imports it without the backend.

Run:  python -m pytest backend/tests/test_watchdog.py -q
"""
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import watchdog  # noqa: E402


def test_parent_alive_for_self_and_dead_for_impossible_pid():
    assert watchdog.parent_alive(os.getpid()) is True
    # PID 1 exists; a huge unused pid does not.
    assert watchdog.parent_alive(2_000_000_000) is False
    # falsy pid means "no parent tracked" -> treat as alive (dev/standalone, never self-kill)
    assert watchdog.parent_alive(0) is True
    assert watchdog.parent_alive(None) is True


def test_watch_parent_noop_without_pid():
    assert watchdog.watch_parent(0) is None
    assert watchdog.watch_parent(None) is None


def test_watch_parent_fires_on_dead():
    fired = []
    # A pid that's already gone -> on_dead should fire promptly.
    t = watchdog.watch_parent(2_000_000_000, interval=0.02, on_dead=lambda: fired.append(True))
    assert t is not None
    for _ in range(100):
        if fired:
            break
        time.sleep(0.02)
    assert fired == [True]


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
