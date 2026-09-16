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


def test_windows_uses_handle_check_and_never_calls_os_kill(monkeypatch):
    """On Windows, os.kill(pid, 0) is CTRL_C_EVENT — sending it would Ctrl+C our own process group
    and kill the whole supervision tree (the real 0.2.46 bug). parent_alive must use the handle
    check and never invoke os.kill there."""
    calls = []
    monkeypatch.setattr(watchdog.os, "name", "nt")
    monkeypatch.setattr(watchdog.os, "kill", lambda *a, **k: calls.append(a))
    monkeypatch.setattr(watchdog, "_win_alive", lambda pid: pid == 1234)
    assert watchdog.parent_alive(1234) is True
    assert watchdog.parent_alive(5678) is False
    assert watchdog.parent_alive(None) is True        # falsy short-circuits before any probe
    assert calls == []                                # os.kill NEVER called on Windows


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


def test_watch_parent_debounces_a_single_spurious_miss(monkeypatch):
    # A single not-alive poll (e.g. a transient OpenProcess failure on Windows) must NOT kill a
    # healthy child; only `misses` consecutive misses do. Script parent_alive: miss, then alive.
    seq = iter([False, True, True, True, True, True])
    monkeypatch.setattr(watchdog, "parent_alive", lambda pid: next(seq, True))
    fired = []
    watchdog.watch_parent(123, interval=0.01, misses=2, on_dead=lambda reason=None: fired.append(reason))
    time.sleep(0.15)
    assert fired == [], "a single spurious miss must not trigger death"


def test_watch_parent_fires_after_consecutive_misses_with_reason(monkeypatch):
    monkeypatch.setattr(watchdog, "parent_alive", lambda pid: False)   # always gone
    fired = []
    watchdog.watch_parent(123, interval=0.01, misses=2, on_dead=lambda reason=None: fired.append(reason))
    for _ in range(100):
        if fired:
            break
        time.sleep(0.01)
    assert fired and fired[0] == "parent-pid-gone"


def test_win_alive_treats_access_denied_as_alive(monkeypatch):
    # OpenProcess returns NULL for BOTH a dead pid and a live-but-inaccessible one; only
    # ERROR_INVALID_PARAMETER (87) means "no such process". A NULL + ACCESS_DENIED (5) must read as
    # ALIVE, or the sidecar self-kills mid-job on Windows (the v0.2.50 bug).
    import ctypes

    class _FakeK:
        def __init__(self, err):
            self._err = err
        def OpenProcess(self, *a):
            return 0                      # NULL handle
        # GetExitCodeProcess/CloseHandle unused on the NULL path

    monkeypatch.setattr(ctypes, "windll", type("W", (), {})(), raising=False)
    # access-denied -> alive
    monkeypatch.setattr(ctypes.windll, "kernel32", _FakeK(5), raising=False)
    monkeypatch.setattr(ctypes, "get_last_error", lambda: 5, raising=False)
    assert watchdog._win_alive(4321) is True
    # invalid-parameter (no such pid) -> dead
    monkeypatch.setattr(ctypes, "get_last_error", lambda: 87, raising=False)
    assert watchdog._win_alive(4321) is False


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
