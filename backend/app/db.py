import gzip
import json
import logging
import os
import shutil
import sqlite3
import threading
from contextlib import contextmanager
from typing import Any, Iterator

from .config import MARKET_DB_PATH, MARKET_SEED_PATH, USER_DB_PATH

log = logging.getLogger("poe2arb.db")

# WAL lets any number of readers run alongside one writer. Writes serialise on
# _write_lock; reads use a per-thread connection and never wait on writers, so a
# digest backfill burst can't stall API requests.
#
# The DB is split into two files (see docs/db-architecture.md):
#   user.sqlite   (main)    — persist forever + migrate: capital, kv, user_meta
#   market.sqlite (ATTACH market) — disposable/snapshot-seeded: digest, orderbook,
#                                    league_daily, item_meta, kv_ops, market_meta
# One connection per thread opens user.sqlite and ATTACHes market.sqlite. Market
# tables live only in the attached file, so unqualified names (e.g. league_daily)
# resolve to market unambiguously; user tables resolve to main.
_write_lock = threading.Lock()
_local = threading.local()

USER_SCHEMA = """
CREATE TABLE IF NOT EXISTS capital (
    currency TEXT PRIMARY KEY,
    qty REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

MARKET_SCHEMA = """
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

CREATE TABLE IF NOT EXISTS league_daily (
    league TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    day TEXT NOT NULL,          -- YYYY-MM-DD
    close REAL, average REAL, volume INTEGER,
    PRIMARY KEY (league, item_id, day)
);
-- cross() filters by item_id (not the leading PK column), so it needs its own index.
CREATE INDEX IF NOT EXISTS idx_league_daily_item ON league_daily(item_id, day);

CREATE TABLE IF NOT EXISTS item_meta (
    item_id INTEGER PRIMARY KEY,
    name TEXT,
    category TEXT
);

CREATE TABLE IF NOT EXISTS kv_ops (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

# kv keys owned by the user (persist + migrate). Everything else is operational and
# lands in market.sqlite.kv_ops (ships in the snapshot, disposable). `secret:`-prefixed
# keys (encrypted session/oauth) are always user. See docs/db-maintenance.md.
_USER_KV = {"settings", "watches", "oauth_pending", "meta_overrides", "trading_workspace"}


def _is_user_kv(key: str) -> bool:
    return key in _USER_KV or key.startswith("secret:")


# ---------------------------------------------------------------------------
# Startup (single-threaded, before any per-thread connection ATTACHes market)
# ---------------------------------------------------------------------------

def _read_snapshot_version(path) -> int:
    """market_meta.snapshot_version for a market DB file, or -1 if missing/corrupt."""
    if not path or not os.path.exists(path):
        return -1
    try:
        c = sqlite3.connect(str(path), timeout=10)
        try:
            row = c.execute(
                "SELECT value FROM market_meta WHERE key='snapshot_version'"
            ).fetchone()
            return int(row[0]) if row else 0
        finally:
            c.close()
    except (sqlite3.Error, ValueError, TypeError):
        return -1


def _seed_version() -> int:
    """snapshot_version of the bundled seed. For a gzipped seed, read the cheap plaintext
    `<seed>.version` sidecar so we don't decompress 300MB+ on every launch; fall back to
    decompressing if the sidecar is missing. For a plain .sqlite seed, read it directly."""
    p = MARKET_SEED_PATH
    if str(p).endswith(".gz"):
        sidecar = p.parent / (p.name + ".version")
        if sidecar.exists():
            try:
                return int(sidecar.read_text().strip())
            except (ValueError, OSError):
                pass
        # No sidecar: decompress to a temp just to read the version (rare).
        try:
            tmp = MARKET_DB_PATH.with_suffix(".vercheck")
            with gzip.open(p, "rb") as fi, open(tmp, "wb") as fo:
                shutil.copyfileobj(fi, fo)
            v = _read_snapshot_version(tmp)
            tmp.unlink()
            return v
        except OSError:
            return -1
    return _read_snapshot_version(p)


def seed_market() -> None:
    """Replace the local market.sqlite with the bundled snapshot when the snapshot is
    newer (or when there's no local market DB yet). Atomic: write .tmp, fsync, rename.
    Supports a gzipped seed (`.gz`) — decompressed here, once, only when replacing.
    No-op when no seed is bundled (dev/server) — the live crawl builds market.sqlite.

    This is the "throw in a snapshot without regard of structure" rule: a newer
    snapshot_version wholesale-replaces the local file — no migration, no merge. User
    data is untouched (it lives in user.sqlite).
    """
    if not MARKET_SEED_PATH or not MARKET_SEED_PATH.exists():
        return
    seed_v = _seed_version()
    local_v = _read_snapshot_version(MARKET_DB_PATH)
    if MARKET_DB_PATH.exists() and seed_v <= local_v:
        log.info("market seed: local v%s >= seed v%s, keeping local", local_v, seed_v)
        return
    log.info("market seed: seeding market.sqlite from snapshot (seed v%s > local v%s)",
             seed_v, local_v)
    tmp = MARKET_DB_PATH.with_suffix(MARKET_DB_PATH.suffix + ".tmp")
    is_gz = str(MARKET_SEED_PATH).endswith(".gz")
    try:
        if is_gz:
            with gzip.open(MARKET_SEED_PATH, "rb") as fi, open(tmp, "wb") as fo:
                shutil.copyfileobj(fi, fo, length=1 << 20)
        else:
            shutil.copyfile(MARKET_SEED_PATH, tmp)
        with open(tmp, "rb") as f:
            os.fsync(f.fileno())
        # Drop any stale WAL/SHM from a previous market DB so the seeded file is
        # opened clean (the seed is exported VACUUMed, no sidecars).
        for suffix in ("-wal", "-shm"):
            side = MARKET_DB_PATH.parent / (MARKET_DB_PATH.name + suffix)
            if side.exists():
                side.unlink()
        os.replace(tmp, MARKET_DB_PATH)
    except OSError as exc:
        log.error("market seed: failed to seed (%s); will crawl live", exc)
        if tmp.exists():
            tmp.unlink()


def _run_user_migrations(conn: sqlite3.Connection) -> None:
    """Apply every user migration with id > user_meta.schema_version, in order, each in
    its own transaction. Back up user.sqlite before running any. Abort loudly on
    failure (loud failure > silent corruption)."""
    from .migrations_user import USER_MIGRATIONS

    row = conn.execute(
        "SELECT value FROM user_meta WHERE key='schema_version'"
    ).fetchone()
    version = int(row[0]) if row else 0
    pending = [m for m in USER_MIGRATIONS if m[0] > version]
    if not pending:
        return

    backup = USER_DB_PATH.with_suffix(USER_DB_PATH.suffix + f".bak-{version}")
    try:
        # Use SQLite's online backup so WAL content is included and the copy is consistent.
        bconn = sqlite3.connect(str(backup))
        conn.commit()
        conn.backup(bconn)
        bconn.close()
        log.info("user migrations: backed up user.sqlite -> %s", backup.name)
    except sqlite3.Error as exc:
        log.warning("user migrations: backup failed (non-fatal): %s", exc)

    for mid, desc, fn in pending:
        log.info("user migration %d: %s", mid, desc)
        try:
            fn(conn)
            conn.execute(
                "INSERT INTO user_meta(key, value) VALUES('schema_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(mid),),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            log.exception("user migration %d FAILED — aborting startup", mid)
            raise


def _boot_databases() -> None:
    # 1. Seed/replace market.sqlite from the bundled snapshot if newer.
    seed_market()
    # 2. User DB: schema + migrations (before anything reads user data).
    uconn = sqlite3.connect(str(USER_DB_PATH), timeout=30)
    try:
        uconn.execute("PRAGMA journal_mode=WAL")
        uconn.executescript(USER_SCHEMA)
        uconn.commit()
        _run_user_migrations(uconn)
    finally:
        uconn.close()
    # 3. Ensure market.sqlite exists with its schema (covers dev/server with no seed,
    #    and self-heals a missing table against an older seed).
    mconn = sqlite3.connect(str(MARKET_DB_PATH), timeout=30)
    try:
        mconn.execute("PRAGMA journal_mode=WAL")
        mconn.executescript(MARKET_SCHEMA)
        mconn.commit()
    finally:
        mconn.close()


_boot_databases()


# ---------------------------------------------------------------------------
# Per-thread connections
# ---------------------------------------------------------------------------

def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(USER_DB_PATH), check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("ATTACH DATABASE ? AS market", (str(MARKET_DB_PATH),))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA market.journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=15000")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA market.synchronous=NORMAL")
    return conn


def _conn() -> sqlite3.Connection:
    c = getattr(_local, "conn", None)
    if c is None:
        c = _local.conn = _connect()
    return c


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


def _kv_table(key: str) -> str:
    return "kv" if _is_user_kv(key) else "kv_ops"


def kv_get(key: str, default: Any = None) -> Any:
    table = _kv_table(key)
    with q() as c:
        row = c.execute(f"SELECT value FROM {table} WHERE key=?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def kv_set(key: str, value: Any) -> None:
    table = _kv_table(key)
    with tx() as c:
        c.execute(
            f"INSERT INTO {table}(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
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


def market_meta_get(key: str, default: Any = None) -> Any:
    with q() as c:
        row = c.execute("SELECT value FROM market_meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def market_meta_set(key: str, value: str) -> None:
    with tx() as c:
        c.execute(
            "INSERT INTO market_meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, str(value)),
        )
