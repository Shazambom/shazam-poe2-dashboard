"""The sidecar supervisor backs off a sidecar that keeps dying, and forgives one that ran a while.

Audit 2026-09-29 (docs/bugs/2026-09-29-audit-open-items.md, S2): the backoff was reset right after
every successful spawn, so a sidecar that crashes at start (a bad numpy import, a native crash on
some Windows machine) was respawned every second forever: a PyInstaller unpack plus a numpy import
each time, and on beta one telemetry post per second.

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_sidecar_supervisor.py -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import sidecar_supervisor as sup  # noqa: E402


def _run(monkeypatch, lifetimes):
    """Supervise a child whose runs last `lifetimes` seconds each; return the backoff sleeps."""
    clock, sleeps, runs = [0.0], [], list(lifetimes)

    class Child:
        pid, stderr = 1, None

        def wait(self):
            clock[0] += runs.pop(0)
            return 3221225477

    def fake_sleep(s):
        sleeps.append(s)
        clock[0] += s
        if not runs:
            sup._stop = True
    monkeypatch.setattr(sup.subprocess, "Popen", lambda *a, **k: Child())
    monkeypatch.setattr(sup.time, "sleep", fake_sleep)
    monkeypatch.setattr(sup.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(sup, "_tlog", lambda *a, **k: None)
    monkeypatch.setattr(sup, "_stop", False)
    sup._supervise(["sidecar"])
    return sleeps


def test_a_sidecar_that_dies_at_start_backs_off_to_30_seconds(monkeypatch):
    assert _run(monkeypatch, [0.5] * 7) == [1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0]


def test_a_sidecar_that_ran_a_while_restarts_quickly_again(monkeypatch):
    assert _run(monkeypatch, [0.5, 0.5, 0.5, 3600, 0.5]) == [1.0, 2.0, 4.0, 1.0, 2.0]
