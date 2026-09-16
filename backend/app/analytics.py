"""Sidecar analytics transport — SQLite, no network (docs/db-architecture.md "Heavy analytics").

This is the ONE shared crossing point between the backend and the heavy-analytics sidecar.
It is deliberately **stdlib-only and connection-injected**:

  * The backend passes its ATTACHed connection (`with db.tx() as c`); the two tables live in the
    `market` database, and SQLite resolves the unqualified names there.
  * The lean sidecar — a separate PyInstaller binary that must NOT drag the FastAPI backend in
    — passes its own `market.sqlite` connection. Importing this module runs no DB boot.

Two tables (market side, self-healed on boot; see MARKET_SCHEMA in db.py):
  analytics_jobs   control channel  — backend enqueues 'queued', sidecar claims → running → done/error
  analytics_cache  results outbox   — sidecar is the SOLE writer; the backend only READS it

Contract: endpoints only ever READ the cache, so a dead/slow sidecar can never take down a
request — it just serves stale-or-empty results. Every read here returns a benign default
(None / []) rather than raising, to keep that guarantee.

TRANSACTIONS: every helper here runs plain statements on the connection it is handed and NEVER
commits — the caller owns the transaction (backend: `with db.tx() as c`; sidecar: `with conn:`).
The one exception is claim(), which needs its own BEGIN IMMEDIATE for exactly-once semantics.
"""
from __future__ import annotations

import json
import sqlite3
import time
from typing import Any, Optional


def _now() -> int:
    return int(time.time())


# ---------------------------------------------------------------- control channel (jobs)
def enqueue(conn: sqlite3.Connection, kind: str, params: Optional[dict] = None,
            *, coalesce: bool = True) -> int:
    """Insert a 'queued' job and return its id. With coalesce (default), if a job of the same
    kind is already queued, reuse it instead of piling up duplicates (the periodic backend loop
    keeps asking; the sidecar may be busy or down)."""
    if coalesce:
        row = conn.execute(
            "SELECT id FROM analytics_jobs WHERE kind=? AND state='queued' ORDER BY id LIMIT 1",
            (kind,)).fetchone()
        if row:
            return row[0]
    cur = conn.execute(
        "INSERT INTO analytics_jobs(kind, params_json, state, enqueued_at) VALUES(?,?, 'queued', ?)",
        (kind, json.dumps(params or {}), _now()))
    return cur.lastrowid


def requeue_stale(conn: sqlite3.Connection, *, older_than_s: int = 120) -> int:
    """Reset jobs stuck in 'running' longer than `older_than_s` back to 'queued', returning how many.

    A job only reaches 'running' via claim(); if the sole consumer (the sidecar) dies mid-job — a
    hard crash, an OS kill, a watchdog os._exit — that row stays 'running' forever and, because
    claim() only takes 'queued' rows, the pipeline wedges (queued piles up, nothing completes; the
    exact Windows symptom in v0.2.50). Calling this on sidecar startup makes the pipeline
    SELF-HEAL: orphans from a previous crash are re-queued and reprocessed. 120s is comfortably
    longer than any real compute (a league's jobs finish in seconds), so it can't steal a job that's
    genuinely in flight in another (hypothetical) worker."""
    n = conn.execute(
        "UPDATE analytics_jobs SET state='queued', started_at=NULL WHERE state='running' "
        "AND started_at IS NOT NULL AND started_at <= ?",
        (_now() - older_than_s,)).rowcount
    return n


def claim(conn: sqlite3.Connection) -> Optional[dict]:
    """Atomically take the oldest queued job of ANY kind (queued→running) and return
    {id, kind, params}, or None if the queue is empty. The single consumer (sidecar) dispatches by
    kind itself, so there's no kind filter here. A lock-free WAL read pre-checks for a queued row
    so an idle poll never takes the write lock; BEGIN IMMEDIATE + the state guard make the actual
    claim exactly-once (even across processes, with WAL + busy_timeout)."""
    if conn.execute("SELECT 1 FROM analytics_jobs WHERE state='queued' LIMIT 1").fetchone() is None:
        return None
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT id, kind, params_json FROM analytics_jobs WHERE state='queued' "
            "ORDER BY id LIMIT 1").fetchone()
        if row is None:
            conn.commit()
            return None
        jid, kind, params_json = row[0], row[1], row[2]
        conn.execute("UPDATE analytics_jobs SET state='running', started_at=? WHERE id=?",
                     (_now(), jid))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    try:
        params = json.loads(params_json) if params_json else {}
    except (ValueError, TypeError):
        params = {}
    return {"id": jid, "kind": kind, "params": params}


def complete(conn: sqlite3.Connection, job_id: Optional[int], kind: str, key: str,
             value: Any) -> None:
    """Write one result to the cache (upsert on (kind,key)) and mark the job done. job_id may be
    None when a producer writes cache without a tracked job (e.g. a self-scheduled refresh)."""
    conn.execute(
        "INSERT INTO analytics_cache(kind, key, computed_at, value_json) VALUES(?,?,?,?) "
        "ON CONFLICT(kind, key) DO UPDATE SET computed_at=excluded.computed_at, "
        "value_json=excluded.value_json",
        (kind, str(key), _now(), json.dumps(value)))
    if job_id is not None:
        conn.execute("UPDATE analytics_jobs SET state='done', finished_at=? WHERE id=?",
                     (_now(), job_id))


def fail(conn: sqlite3.Connection, job_id: int, error: str) -> None:
    conn.execute("UPDATE analytics_jobs SET state='error', error=?, finished_at=? WHERE id=?",
                 (str(error)[:2000], _now(), job_id))


def prune_jobs(conn: sqlite3.Connection, keep: int = 200) -> None:
    """Housekeeping: keep only the most recent `keep` finished (done/error) jobs so the control
    table can't grow without bound. Queued/running rows are never pruned."""
    conn.execute(
        "DELETE FROM analytics_jobs WHERE state IN ('done','error') AND id NOT IN "
        "(SELECT id FROM analytics_jobs WHERE state IN ('done','error') ORDER BY id DESC LIMIT ?)",
        (keep,))


# ------------------------------------------------------------------- results (cache) — READ only
def read_cache(conn: sqlite3.Connection, kind: str, key: str):
    """The parsed cached value for (kind, key), or None. Never raises — endpoints degrade
    gracefully when the sidecar is idle."""
    try:
        row = conn.execute(
            "SELECT value_json FROM analytics_cache WHERE kind=? AND key=?",
            (kind, str(key))).fetchone()
        return json.loads(row[0]) if row else None
    except sqlite3.Error:
        return None
