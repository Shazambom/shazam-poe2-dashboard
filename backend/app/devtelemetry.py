"""Dev-diagnostic telemetry for the two Python processes (backend supervisor + analytics sidecar).

TEMPORARY DEV DIAGNOSTIC (CLAUDE.md "telemetry is mandatory"): the sidecar is invisible on Windows
(the supervisor discards its stdio), so a mid-job death left no trace and jobs wedged at 'running'
(v0.2.50). Both processes post their lifecycle to the sanctioned installlog endpoint so we can SEE
where they die. Best-effort, stdlib-only, no secrets.

Gate: ARBITER_TELEMETRY=1, which Electron sets ONLY on the beta/dev channel — stable builds and the
web/server env never post. This module is stdlib-only and importable by the lean sidecar binary.
"""
from __future__ import annotations

import os
import sys
import urllib.request

_URL = "http://192.168.1.250:8080/api/installlog?p=sidecar"


def enabled() -> bool:
    return os.environ.get("ARBITER_TELEMETRY") == "1"


def tlog(tag: str, msg: str) -> None:
    """Post one line as `v<ver> <platform> [tag]: msg`. Silent unless the gate is on; never raises."""
    if not enabled():
        return
    try:
        ver = os.environ.get("ARBITER_VERSION", "?")
        frozen = getattr(sys, "frozen", False)
        body = f"v{ver} {sys.platform} frozen={frozen} [{tag}]: {msg}".encode("utf-8", "replace")
        req = urllib.request.Request(_URL, data=body, headers={"Content-Type": "text/plain"})
        urllib.request.urlopen(req, timeout=4).close()
    except Exception:
        pass
