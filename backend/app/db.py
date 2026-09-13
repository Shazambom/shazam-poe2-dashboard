import json
import sqlite3
import threading
from contextlib import contextmanager
from typing import Any, Iterator

from .config import DB_PATH

# WAL lets any number of readers run alongside one writer. Writes serialise on
# _write_lock; reads use a per-thread connection and never wait on writers, so a
# digest backfill burst can't stall API requests.
_write_lock = threading.Lock()
_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS digest_markets (
    hour INTEGER NOT NULL,
    league TEXT NOT NULL,
    market_id TEXT NOT NULL,
    cur_a TEXT NOT NULL,
    cur_b TEXT NOT NULL,
    vol_a INTEGER, vol_b INTEGER,
    lo_stock_a INTEGER, lo_stock_b INTEGER,
    hi_stock_a INTEGER, hi_stock_b INTEGER,
    lo_ratio_a INTEGER, lo_ratio_b INTEGER,
    hi_ratio_a INTEGER, hi_ratio_b INTEGER,
    PRIMARY KEY (hour, league, market_id)
);
CREATE INDEX IF NOT EXISTS idx_digest_league_hour ON digest_markets(league, hour);
CREATE INDEX IF NOT EXISTS idx_digest_pair ON digest_markets(league, cur_a, cur_b);

CREATE TABLE IF NOT EXISTS orderbook (
    league TEXT NOT NULL,
    have TEXT NOT NULL,
    want TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    offers TEXT NOT NULL,
    PRIMARY KEY (league, have, want)
);

CREATE TABLE IF NOT EXISTS orderbook_history (
    league TEXT NOT NULL,
    have TEXT NOT NULL,
    want TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    best_rate REAL,
    best_stock INTEGER,
    depth INTEGER
);
CREATE INDEX IF NOT EXISTS idx_obh ON orderbook_history(league, have, want, fetched_at);

CREATE TABLE IF NOT EXISTS capital (
    currency TEXT PRIMARY KEY,
    qty REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=15000")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def _conn() -> sqlite3.Connection:
    c = getattr(_local, "conn", None)
    if c is None:
        c = _local.conn = _connect()
    return c


_boot = _connect()
_boot.executescript(SCHEMA)
_boot.commit()
_boot.close()


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    """Write transaction: serialised app-wide, committed on exit."""
    with _write_lock:
        c = _conn()
        try:
            yield c
            c.commit()
        except Exception:
            c.rollback()
            raise


@contextmanager
def q() -> Iterator[sqlite3.Connection]:
    """Read-only access on this thread's connection. WAL readers see a consistent
    snapshot and never block, so use this for every SELECT-only path."""
    yield _conn()


def kv_get(key: str, default: Any = None) -> Any:
    with q() as c:
        row = c.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def kv_set(key: str, value: Any) -> None:
    with tx() as c:
        c.execute(
            "INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )


def get_capital() -> dict[str, float]:
    with q() as c:
        rows = c.execute("SELECT currency, qty FROM capital").fetchall()
    return {r["currency"]: r["qty"] for r in rows}


def set_capital(entries: dict[str, float]) -> None:
    with tx() as c:
        c.execute("DELETE FROM capital")
        c.executemany(
            "INSERT INTO capital(currency, qty) VALUES(?, ?)",
            [(k, float(v)) for k, v in entries.items() if float(v) > 0],
        )
