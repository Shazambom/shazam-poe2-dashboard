"""The desktop backend's access log keeps events, not polling. The renderer polls /api/status,
/api/backfill and friends every few seconds; logged, they filled the "Report a problem" log tail
(64 KB, ~5 minutes on report FY0M4R) and pushed out the league switch that mattered. A successful
read is not an event; a write, or any request that failed, is."""
from __future__ import annotations

import logging

READS = {"GET", "HEAD", "OPTIONS"}


class QuietReads(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        a = record.args
        if not (isinstance(a, tuple) and len(a) == 5):
            return True                                   # not uvicorn's access shape: keep
        method, status = a[1], a[4]
        try:
            return not (method in READS and int(status) < 400)
        except (TypeError, ValueError):
            return True


def install() -> None:
    lg = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, QuietReads) for f in lg.filters):
        lg.addFilter(QuietReads())
