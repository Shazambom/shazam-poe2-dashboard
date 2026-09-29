"""Dev-diagnostic telemetry for the two Python processes (backend supervisor + analytics sidecar).

TEMPORARY DEV DIAGNOSTIC (CLAUDE.md "telemetry is mandatory"): the sidecar is invisible on Windows
(the supervisor discards its stdio), so a mid-job death left no trace and jobs wedged at 'running'
(v0.2.50). Both processes post their lifecycle to the sanctioned installlog endpoint so we can SEE
where they die. Best-effort, stdlib-only, no secrets.

Gate: ARBITER_TELEMETRY=1, which Electron sets ONLY on the beta/dev channel — stable builds and the
web/server env never post. This module is stdlib-only and importable by the lean sidecar binary.
"""
from __future__ import annotations

import atexit
import os
import queue
import sys
import threading
import urllib.request

_URL = "http://192.168.1.250:8080/api/installlog?p=sidecar"


def enabled() -> bool:
    return os.environ.get("ARBITER_TELEMETRY") == "1"


# A full-sync fallback: the client is rebuilding market data it should have received. Each is a
# T0 blocker for a stable release (owner directive 2026-09-25); `t0()` names it as one greppable
# line, ops/t0-scan.py classifies it on the server, and the stable publisher refuses while one
# exists for the version's beta line.
T0_KINDS = frozenset({
    "seed-failed",        # the bundled seed could not be applied
    "unseeded",           # a seed is bundled yet the local DB has no snapshot
    "seed-unreadable",    # the bundled seed's version or bytes cannot be read
    "digest-cold",        # the hourly digest starts from scratch with a seed bundled
    "league-full-crawl",  # the league-history crawl refetches a league it should have had
    "mods-empty",         # a seed is bundled yet there are no mod tables
    "crawl-lost",         # a seed replace could not carry the client's newer crawl over
    "seed-partial",       # the seed ships a current league's days past the day verified final
})


def t0(kind: str, msg: str) -> None:
    """Report a full-sync fallback. Always logged locally; posted on the beta channel."""
    assert kind in T0_KINDS, kind
    import logging
    logging.getLogger("poe2arb.t0").error("T0 %s: %s", kind, msg)
    tlog("T0", f"{kind}: {msg}")


def tlog(tag: str, msg: str) -> None:
    """Post one line as `v<ver> <platform> [tag]: msg`. Silent unless the gate is on; never raises,
    never blocks: callers include the backend's event loop, and a beta client off the owner's LAN
    would wait out the timeout on every line. The line is queued; one worker posts, in order."""
    if not enabled():
        return
    ver = os.environ.get("ARBITER_VERSION", "?")
    frozen = getattr(sys, "frozen", False)
    _queue.put(f"v{ver} {sys.platform} frozen={frozen} [{tag}]: {msg}".encode("utf-8", "replace"))
    _start()


_queue: queue.Queue = queue.Queue()
_worker: threading.Thread | None = None
_lock = threading.Lock()


def _post(body: bytes) -> None:
    try:
        req = urllib.request.Request(_URL, data=body, headers={"Content-Type": "text/plain"})
        urllib.request.urlopen(req, timeout=4).close()
    except Exception:
        pass


def _run() -> None:
    while True:
        body = _queue.get()
        try:
            _post(body)
        finally:
            _queue.task_done()


def _start() -> None:
    global _worker
    with _lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_run, name="devtelemetry", daemon=True)
            _worker.start()


def flush(timeout: float = 5.0) -> bool:
    """Wait (at most `timeout` s) until every queued line is posted; True when the queue drained.
    Runs at exit, so a process's last lines (the sidecar's death) still leave."""
    done = threading.Event()
    threading.Thread(target=lambda: (_queue.join(), done.set()), daemon=True).start()
    return done.wait(timeout)


atexit.register(flush)
