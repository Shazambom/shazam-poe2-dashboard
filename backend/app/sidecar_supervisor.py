"""Supervises the heavy-analytics sidecar as the backend's child (supervision tree
Electron → backend → sidecar).

Spawns the sidecar holding its stdin open (so the sidecar sees EOF and dies if the backend dies)
and passes ARBITER_PARENT_PID (the backup POSIX/Win poll). Restarts it with capped backoff. If no
sidecar is available (no bundled binary and not running from source), it's a NO-OP: the app still
works because endpoints only READ analytics_cache — they just serve empty/stale results.
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional

log = logging.getLogger("poe2arb.sidecar")

_proc: Optional[subprocess.Popen] = None
_stop = False


def _sidecar_cmd() -> Optional[list[str]]:
    """How to launch the sidecar:
      * the bundled per-platform binary — SIDECAR_BIN, set by Electron (desktop); or
      * the from-source entry with the current interpreter, but ONLY when SIDECAR_FROM_SOURCE is
        set (local dev with numpy/stumpy installed). This is opt-in so the web/server Docker env
        — which has neither the binary nor the heavy deps — never fail-loops trying to spawn it.
    None when neither applies → supervisor no-ops and analytics endpoints serve empty."""
    exe = os.environ.get("SIDECAR_BIN")
    if exe:
        # SIDECAR_BIN is set only by Electron (desktop), which passes the EXPECTED path. If it's
        # missing, that's a packaging regression, not the legitimate web-env absence — make it
        # observable (WARNING) rather than a silent no-op.
        if Path(exe).exists():
            return [exe]
        log.warning("SIDECAR_BIN set but not found at %s — bundled sidecar missing; analytics "
                    "disabled (packaging regression?)", exe)
        return None
    if os.environ.get("SIDECAR_FROM_SOURCE") and not getattr(sys, "frozen", False):
        entry = Path(__file__).resolve().parents[1] / "sidecar" / "run_sidecar.py"
        if entry.exists():
            return [sys.executable, str(entry)]
    return None


def _supervise(cmd: list[str]) -> None:
    global _proc
    backoff = 1.0
    while not _stop:
        try:
            env = dict(os.environ, ARBITER_PARENT_PID=str(os.getpid()))
            _proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, env=env)
            log.info("analytics sidecar started pid=%s (%s)", _proc.pid, cmd[0])
            backoff = 1.0                           # a clean start resets the backoff
            rc = _proc.wait()
            if _stop:
                break
            log.info("analytics sidecar exited rc=%s — restarting", rc)
        except Exception as exc:
            log.warning("analytics sidecar spawn failed: %s", exc)
        if _stop:
            break
        time.sleep(backoff)
        backoff = min(30.0, backoff * 2)


def start() -> None:
    """Begin supervising in a daemon thread. Safe to call once at startup."""
    cmd = _sidecar_cmd()
    if not cmd:
        log.info("analytics sidecar unavailable — analytics endpoints will serve empty results")
        return
    threading.Thread(target=_supervise, args=(cmd,), daemon=True,
                     name="sidecar-supervisor").start()


def stop() -> None:
    """Stop supervising and end the child: closing its stdin gives it EOF; then terminate."""
    global _stop
    _stop = True
    p = _proc
    if p and p.poll() is None:
        try:
            if p.stdin:
                p.stdin.close()          # EOF -> sidecar's stdin watchdog exits it cleanly
        except Exception:
            pass
        try:
            p.terminate()
        except Exception:
            pass
