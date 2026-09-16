"""Sidecar runtime loop — claim analytics jobs, compute, write results to the cache.

Reads market.sqlite directly with its OWN plain sqlite3 connection (never imports app.db, which
would boot the backend). Shares the SQLite transport (`app.analytics`) and the stdlib series
reader (`app.marketseries`) with the backend. Heavy libs (numpy/stumpy) enter only via the
analytics handlers, keeping this module import-cheap for tests that stub them out.

Endpoints only READ analytics_cache, so if this loop is slow or dead the app still serves — it
just serves stale-or-empty results.
"""
from __future__ import annotations

import os
import sqlite3
import time

from app import analytics, marketseries, watchdog


# ---- job handlers: kind -> fn(conn, job) that writes analytics_cache -----------------------
# Each kind caches ONE blob under a fixed key (the product shows a single active league at a time),
# with the league carried INSIDE the value — so the reader reads a stable key instead of having to
# re-resolve the league and hope it matches what was written. New kinds register here.
def handle_discords(conn: sqlite3.Connection, job: dict) -> None:
    from sidecar.analytics import discords          # lazy: keep numpy/stumpy off the import path
    league = (job.get("params") or {}).get("league")
    series, meta = marketseries.series_for_league(conn, league) if league else ({}, {})
    signals = discords.compute(series, meta) if league else []
    analytics.complete(conn, job["id"], "discords", "current", {"league": league, "signals": signals})


def handle_arc(conn: sqlite3.Connection, job: dict) -> None:
    from sidecar.analytics import arc               # lazy: keep numpy/dtaidistance off the import path
    league = (job.get("params") or {}).get("league")
    sigs = marketseries.league_signatures(conn)
    weights: dict = {}
    resembles = None
    if league and league in sigs:
        past = {lg: s for lg, s in sigs.items() if lg != league}
        weights = arc.compute_weights(sigs[league], past)
        if weights:
            resembles = max(weights, key=weights.get)   # the most-similar past league
    analytics.complete(conn, job["id"], "arc", "current",
                       {"league": league, "weights": weights, "resembles": resembles})


HANDLERS = {"discords": handle_discords, "arc": handle_arc}


def run_once(conn: sqlite3.Connection) -> bool:
    """Claim and run one job. Returns True if a job was handled (success or error), False if the
    queue was empty. A single claim of the oldest queued job of any kind; we dispatch by kind here,
    failing an unhandleable kind in the same pass (so it can't accumulate, and no second claim can
    race a freshly-enqueued valid job). Never raises for a job failure — it records it and moves on."""
    job = analytics.claim(conn)
    if job is None:
        return False
    handler = HANDLERS.get(job["kind"])
    if handler is None:
        analytics.fail(conn, job["id"], f"no handler for kind {job['kind']!r}")
        return True
    try:
        handler(conn, job)
    except Exception as exc:            # a bad series must not wedge the loop
        analytics.fail(conn, job["id"], repr(exc))
    return True


def open_market(data_dir: str | None = None) -> sqlite3.Connection:
    data_dir = data_dir or os.environ.get("DATA_DIR") or "/data"
    conn = sqlite3.connect(os.path.join(data_dir, "market.sqlite"), timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=15000")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def main() -> None:
    # Die with the parent (backend): stdin-EOF is primary, PARENT_PID poll is the POSIX backup.
    parent = os.environ.get("ARBITER_PARENT_PID")
    watchdog.guard(parent_pid=int(parent) if parent and parent.isdigit() else None)
    conn = open_market()
    idle = done = 0
    while True:
        try:
            worked = run_once(conn)
        except sqlite3.Error:
            time.sleep(2.0)             # transient DB contention — back off and retry
            continue
        if worked:
            done += 1
            if done % 50 == 0:          # trim occasionally, not on every job's hot path
                analytics.prune_jobs(conn)
            idle = 0
        else:
            time.sleep(min(5.0, 0.5 * (idle + 1)))   # gentle idle backoff
            idle = min(idle + 1, 9)
