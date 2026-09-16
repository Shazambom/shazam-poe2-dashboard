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
import sys
import time
import traceback

from app import analytics, devtelemetry, marketseries, watchdog


# TEMPORARY DEV DIAGNOSTIC (see CLAUDE.md "telemetry is mandatory"): the sidecar's lifecycle,
# posted via the shared beta/dev-gated sender so a mid-job death on Windows is visible.
def _tlog(msg: str) -> None:
    devtelemetry.tlog("sidecar", msg)


# ---- job handlers: kind -> fn(conn, job) that writes analytics_cache -----------------------
# Each kind caches ONE blob under a fixed key (the product shows a single active league at a time),
# with the league carried INSIDE the value — so the reader reads a stable key instead of having to
# re-resolve the league and hope it matches what was written. New kinds register here.
def handle_discords(conn: sqlite3.Connection, job: dict) -> None:
    from sidecar.analytics import discords
    league = (job.get("params") or {}).get("league")
    series, meta = marketseries.series_for_league(conn, league) if league else ({}, {})
    _tlog(f"discords read league={league!r} items={len(series)}")   # <-- pinpoints read vs compute hang
    signals = discords.compute(series, meta) if league else []
    _tlog(f"discords computed n={len(signals)}")
    analytics.complete(conn, job["id"], "discords", "current", {"league": league, "signals": signals})


def handle_arc(conn: sqlite3.Connection, job: dict) -> None:
    from sidecar.analytics import arc
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
        with conn:                      # the sidecar owns its transactions (helpers never commit)
            analytics.fail(conn, job["id"], f"no handler for kind {job['kind']!r}")
        return True
    kind = job["kind"]
    league = (job.get("params") or {}).get("league")
    _tlog(f"claim {kind} league={league!r}")   # <-- last line before a native death pinpoints it
    try:
        with conn:                      # compute + cache write + 'done' land as one commit
            handler(conn, job)
        cached = analytics.read_cache(conn, kind, "current") or {}
        n = len(cached.get("signals") or []) if kind == "discords" else len(cached.get("weights") or {})
        _tlog(f"done {kind} n={n}")
    except Exception as exc:            # a bad series must not wedge the loop
        with conn:
            analytics.fail(conn, job["id"], repr(exc))
        _tlog(f"FAIL {kind} {exc!r}")
    return True


def open_market(data_dir: str | None = None) -> sqlite3.Connection:
    data_dir = data_dir or os.environ.get("DATA_DIR") or "/data"
    conn = sqlite3.connect(os.path.join(data_dir, "market.sqlite"), timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=15000")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def main() -> None:
    parent = os.environ.get("ARBITER_PARENT_PID")
    ppid = int(parent) if parent and parent.isdigit() else None
    _tlog(f"start pid={os.getpid()} parent={ppid} stdin={bool(getattr(sys, 'stdin', None))}")

    # Eagerly import numpy + the analytics modules HERE — in the main thread, BEFORE any watchdog
    # threads exist — so it matches the (proven-good) --selftest import order. The v0.2.50/0.2.51
    # Windows hang was a job claimed then wedged with no crash/timeout; the only heavy thing left in
    # that path is numpy's first (lazy) import happening in a spawned, console-less process with
    # daemon threads already running. Doing it up-front removes that variable and surfaces a slow/
    # stuck import as its own telemetry line instead of an invisible mid-job wedge.
    try:
        import numpy  # noqa: F401
        from sidecar.analytics import arc, discords  # noqa: F401
        _tlog("numpy+analytics imported")
    except Exception as exc:
        _tlog(f"IMPORT CRASH {exc!r}")
        raise

    # Die with the parent (backend): stdin-EOF is primary, PARENT_PID poll is the debounced backup.
    # on_dead posts WHICH signal fired before exiting, so a spurious watchdog kill is now visible
    # instead of looking like a silent crash.
    def _on_dead(reason: str = "?") -> None:
        _tlog(f"WATCHDOG EXIT reason={reason}")
        os._exit(0)
    watchdog.guard(parent_pid=ppid, on_dead=_on_dead)

    conn = open_market()
    # SELF-HEAL: re-queue jobs orphaned in 'running' by a previous crash so the pipeline recovers
    # instead of wedging forever (the v0.2.50 Windows symptom).
    try:
        with conn:
            healed = analytics.requeue_stale(conn, older_than_s=0)
        if healed:
            _tlog(f"requeued {healed} stale running job(s) at startup")
    except sqlite3.Error as exc:
        _tlog(f"requeue-stale error {exc!r}")

    idle = done = 0
    while True:
        try:
            worked = run_once(conn)
        except sqlite3.Error:
            time.sleep(2.0)             # transient DB contention — back off and retry
            continue
        except Exception as exc:        # never let an unexpected error die silently — report it
            _tlog(f"LOOP CRASH {exc!r}\n{traceback.format_exc()[-1500:]}")
            raise
        if worked:
            done += 1
            if done % 50 == 0:          # trim occasionally, not on every job's hot path
                with conn:
                    analytics.prune_jobs(conn)
            idle = 0
        else:
            # periodically re-heal in case a job was orphaned while we were idle-looping
            if idle == 0:
                try:
                    with conn:
                        analytics.requeue_stale(conn, older_than_s=120)
                except sqlite3.Error:
                    pass
            time.sleep(min(5.0, 0.5 * (idle + 1)))   # gentle idle backoff
            idle = min(idle + 1, 9)
