"""Supervises the heavy-analytics sidecar as the backend's child (supervision tree
Electron → backend → sidecar).

Spawns the sidecar holding its stdin open (so the sidecar sees EOF and dies if the backend dies)
and passes ARBITER_PARENT_PID (the backup POSIX/Win poll). Restarts it with capped backoff. If no
sidecar is available (no bundled binary and not running from source), it's a NO-OP: the app still
works because endpoints only READ analytics_cache — they just serve empty/stale results.
"""

from __future__ import annotations

import collections
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import devtelemetry

log = logging.getLogger("poe2arb.sidecar")

_proc: subprocess.Popen | None = None
_stop = False
_wake = threading.Event()


# TEMPORARY DEV DIAGNOSTIC (see CLAUDE.md): a native sidecar crash (rc=0xC0000005) dies too fast to
# post its own telemetry, so the supervisor reports the exit code + stderr tail (beta/dev only).
def _tlog(msg: str) -> None:
    devtelemetry.tlog("supervisor", msg)


def _sidecar_cmd() -> list[str] | None:
    """How to launch the sidecar:
      * the bundled per-platform binary — SIDECAR_BIN, set by Electron (desktop); or
      * when frozen (single unified PyInstaller binary), re-exec ourselves with `--sidecar`; or
      * the from-source entry with the current interpreter, but ONLY when SIDECAR_FROM_SOURCE is
        set (local dev with numpy installed). This is opt-in so the web/server Docker env
        — which has neither the binary nor the heavy deps — never fail-loops trying to spawn it.
    None when neither applies → supervisor no-ops and analytics endpoints serve empty."""
    exe = os.environ.get("SIDECAR_BIN")
    if exe:
        # SIDECAR_BIN is set only by Electron (desktop), which passes the EXPECTED path. If it's
        # missing, that's a packaging regression, not the legitimate web-env absence — make it
        # observable (WARNING) rather than a silent no-op.
        if Path(exe).exists():
            return [exe]
        log.warning(
            "SIDECAR_BIN set but not found at %s — bundled sidecar missing; analytics "
            "disabled (packaging regression?)",
            exe,
        )
        return None
    if getattr(sys, "frozen", False):
        return [sys.executable, "--sidecar"]
    if os.environ.get("SIDECAR_FROM_SOURCE"):
        entry = Path(__file__).resolve().parents[1] / "sidecar" / "run_sidecar.py"
        if entry.exists():
            return [sys.executable, str(entry)]
    return None


HEALTHY_RUN_S = 60.0  # a child that lived this long earns a quick restart; one that dies sooner backs off


def _drain_stderr(stream, tail: collections.deque) -> None:
    """Incrementally drain stderr into a bounded line ring so a chatty sidecar can neither
    deadlock on a full OS pipe buffer nor grow backend memory unboundedly."""
    try:
        for line in iter(stream.readline, b""):
            tail.append(line[:256])
    except (OSError, ValueError):
        pass


def _supervise(cmd: list[str]) -> None:
    global _proc
    backoff = 1.0
    while not _stop:
        try:
            env = dict(os.environ, ARBITER_PARENT_PID=str(os.getpid()))
            # Capture the sidecar's stderr so a native crash (rc=0xC0000005) or traceback is
            # visible instead of being discarded — the death was invisible in v0.2.50.
            _proc = subprocess.Popen(
                cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE, env=env
            )
            log.info("analytics sidecar started pid=%s (%s)", _proc.pid, cmd[0])
            started = time.monotonic()
            tail: collections.deque[bytes] = collections.deque(maxlen=32)
            reader = None
            if _proc.stderr is not None:
                reader = threading.Thread(
                    target=_drain_stderr,
                    args=(_proc.stderr, tail),
                    daemon=True,
                    name="sidecar-stderr",
                )
                reader.start()
            rc = _proc.wait()
            if reader is not None:
                reader.join(timeout=1.0)
            if _stop:
                break
            if rc == 0:
                # Clean idle exit (runner.IDLE_EXIT_S) — keep RAM freed until the next job arrives.
                backoff = 1.0
                log.info(
                    "analytics sidecar exited cleanly (idle) — sleeping until next job"
                )
                _wake.clear()
                while not _stop and not _wake.wait(timeout=1.0):
                    pass
                continue
            if time.monotonic() - started >= HEALTHY_RUN_S:
                backoff = 1.0  # it ran a while: restart it promptly
            log.info("analytics sidecar exited rc=%s — restarting", rc)
            # rc=3221225477 (0xC0000005) = native access violation; surface crash + bounded stderr tail.
            err_tail = b"".join(tail)[-600:].decode("utf-8", "replace")
            _tlog(f"exited rc={rc} stderr_tail={err_tail!r}")
        except Exception as exc:
            log.warning("analytics sidecar spawn failed: %s", exc)
        if _stop:
            break
        time.sleep(backoff)
        backoff = min(30.0, backoff * 2)


def wake() -> None:
    """Wake an idle-exited sidecar supervisor when new analytics jobs are enqueued."""
    _wake.set()


def start() -> None:
    """Begin supervising in a daemon thread. Safe to call once at startup."""
    global _stop
    _stop = False
    _wake.clear()
    cmd = _sidecar_cmd()
    if not cmd:
        log.info(
            "analytics sidecar unavailable — analytics endpoints will serve empty results"
        )
        return
    threading.Thread(
        target=_supervise, args=(cmd,), daemon=True, name="sidecar-supervisor"
    ).start()


def stop() -> None:
    """Stop supervising and end the child: closing its stdin gives it EOF; then terminate."""
    global _stop
    _stop = True
    _wake.set()
    p = _proc
    if p and p.poll() is None:
        try:
            if p.stdin:
                p.stdin.close()  # EOF -> sidecar's stdin watchdog exits it cleanly
        except Exception:
            log.debug("could not close sidecar stdin", exc_info=True)
        try:
            p.terminate()
        except Exception:
            log.debug("could not terminate the sidecar", exc_info=True)
