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

# TEMPORARY DEV DIAGNOSTIC (see CLAUDE.md): a native sidecar crash (rc=0xC0000005) dies too fast to
# post its own telemetry, so the supervisor reports the exit code + stderr tail. Best-effort, only
# on desktop (parent pid set). Strip with the rest of the Windows-signals diagnostics.
def _tlog(msg: str) -> None:
    if not os.environ.get("ARBITER_PARENT_PID"):
        return
    try:
        import sys
        import urllib.request
        ver = os.environ.get("ARBITER_VERSION", "?")
        body = f"v{ver} {sys.platform} [supervisor]: {msg}".encode("utf-8", "replace")
        req = urllib.request.Request("http://192.168.1.250:8080/api/installlog?p=sidecar",
                                     data=body, headers={"Content-Type": "text/plain"})
        urllib.request.urlopen(req, timeout=4).close()
    except Exception:
        pass


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
            # Capture the sidecar's stderr so a native crash (rc=0xC0000005) or traceback is
            # visible instead of being discarded — the death was invisible in v0.2.50.
            _proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
            log.info("analytics sidecar started pid=%s (%s)", _proc.pid, cmd[0])
            backoff = 1.0                           # a clean start resets the backoff
            err_tail = b""
            try:                                    # drain stderr so a chatty child can't block
                err_tail = (_proc.stderr.read() or b"") if _proc.stderr else b""
            except Exception:
                pass
            rc = _proc.wait()
            if _stop:
                break
            log.info("analytics sidecar exited rc=%s — restarting", rc)
            # rc=3221225477 (0xC0000005) = native access violation; a clean rc=0 with jobs stuck
            # usually means a watchdog os._exit. Either way, surface it.
            _tlog(f"exited rc={rc} stderr_tail={err_tail[-600:].decode('utf-8', 'replace')!r}")
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
