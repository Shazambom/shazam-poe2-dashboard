import gzip
import json
import logging
import os
import shutil
import sqlite3
import threading
from contextlib import contextmanager
from typing import Any, Callable, Iterator

from . import devtelemetry
from .config import MARKET_DB_PATH, MARKET_SEED_PATH, USER_DB_PATH
from .datapolicy import is_user_kv

# ⚠️  BEFORE changing any schema, kv routing, or the snapshot: READ docs/db-maintenance.md.
#     user data → numbered migration (never dropped); market data → no migration, ships in the
#     snapshot + bump snapshot_version. Getting it wrong loses user data OR forces every client to
#     re-seed. A new operational kv key needs nothing (lands in kv_ops); a user kv key must be
#     added to USER_KV in datapolicy.py. When unsure, ask — don't guess.
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
-- A league's whole window (Hold and Movers card hundreds of assets at once) carrying the five
-- columns those readers want, so the scan is answered from the index and never touches a table
-- row: 0.43s -> 0.02s over 314,000 rows. Supersedes the old idx_digest_league_hour, whose
-- (league, hour) is its prefix.
CREATE INDEX IF NOT EXISTS idx_digest_window
    ON digest_markets(league, hour, cur_a, cur_b, vol_a, vol_b);
DROP INDEX IF EXISTS idx_digest_league_hour;
-- One market across time: a card's history seeks it, and `pair_volume` (the volume rule's input,
-- read on every graph build) is answered from it without touching a table row — 0.35s -> 0.04s.
-- Supersedes the old idx_digest_pair, whose (league, cur_a, cur_b) is its prefix.
CREATE INDEX IF NOT EXISTS idx_digest_pair_hour
    ON digest_markets(league, cur_a, cur_b, hour, vol_a, vol_b);
DROP INDEX IF EXISTS idx_digest_pair;

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

-- The mod-pool tables (app/modpool.py): per item type, the pools every currency opens on it,
-- precomputed for the Mods tab, plus the orbs that carry a minimum modifier level. Rebuilt on
-- shazam before each seed publish; clients only read them.
CREATE TABLE IF NOT EXISTS mod_pools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    class TEXT NOT NULL,
    domain TEXT NOT NULL,
    keywords TEXT NOT NULL,
    data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mod_currencies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    floor INTEGER NOT NULL,
    cap INTEGER
);

CREATE TABLE IF NOT EXISTS kv_ops (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Sidecar analytics transport (docs/db-architecture.md "Heavy analytics"). Both tables
-- are additive, empty, and RUNTIME-only: they are NOT copied into the exported snapshot
-- (ops/export-market-snapshot.py builds from its own explicit table list), and the boot
-- self-heal above (executescript(MARKET_SCHEMA) after seeding) recreates them against any
-- older seed. So adding them needs NO snapshot rebuild — the snapshot's data is unchanged.
--   analytics_cache: the sidecar is the SOLE writer; the backend/endpoints only READ it, so
--     the sidecar can never take down a request (graceful degrade when it's down).
--   analytics_jobs: the control channel — the backend enqueues 'queued' rows; the sidecar
--     claims them (queued->running), runs the compute, writes analytics_cache, marks done/error.
CREATE TABLE IF NOT EXISTS analytics_cache (
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    computed_at INTEGER NOT NULL,
    value_json TEXT NOT NULL,
    PRIMARY KEY (kind, key)
);

CREATE TABLE IF NOT EXISTS analytics_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    params_json TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | error
    enqueued_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_analytics_jobs_state ON analytics_jobs(state, id);
"""

# kv routing (user vs operational) is defined ONCE in datapolicy.py — add new user keys there.
_is_user_kv = is_user_kv


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
        devtelemetry.tlog("seed", f"no seed bundled (path={MARKET_SEED_PATH})")
        return
    seed_v = _seed_version()
    local_v = _read_snapshot_version(MARKET_DB_PATH)
    if MARKET_DB_PATH.exists() and seed_v <= local_v:
        log.info("market seed: local v%s >= seed v%s, keeping local", local_v, seed_v)
        devtelemetry.tlog("seed", f"kept local v{local_v} (seed v{seed_v})")
        return
    log.info("market seed: seeding market.sqlite from snapshot (seed v%s > local v%s)",
             seed_v, local_v)
    devtelemetry.tlog("seed", f"replacing local v{local_v} with seed v{seed_v} ({MARKET_SEED_PATH.stat().st_size >> 20} MB gz)")
    tmp = MARKET_DB_PATH.with_suffix(MARKET_DB_PATH.suffix + ".tmp")
    is_gz = str(MARKET_SEED_PATH).endswith(".gz")
    try:
        # Sync through the WRITE handle: on Windows os.fsync on a read-only handle fails with
        # EBADF, which silently left every Windows install unseeded (beta telemetry, 2026-09-25).
        with open(tmp, "wb") as fo:
            if is_gz:
                with gzip.open(MARKET_SEED_PATH, "rb") as fi:
                    shutil.copyfileobj(fi, fo, length=1 << 20)
            else:
                with open(MARKET_SEED_PATH, "rb") as fi:
                    shutil.copyfileobj(fi, fo, length=1 << 20)
            fo.flush()
            os.fsync(fo.fileno())
        # Drop any stale WAL/SHM from a previous market DB so the seeded file is
        # opened clean (the seed is exported VACUUMed, no sidecars).
        for suffix in ("-wal", "-shm"):
            side = MARKET_DB_PATH.parent / (MARKET_DB_PATH.name + suffix)
            if side.exists():
                side.unlink()
        os.replace(tmp, MARKET_DB_PATH)
        devtelemetry.tlog("seed", f"replaced: now v{_read_snapshot_version(MARKET_DB_PATH)} ({MARKET_DB_PATH.stat().st_size >> 20} MB)")
    except OSError as exc:
        log.error("market seed: failed to seed (%s); will crawl live", exc)
        devtelemetry.tlog("seed", f"FAILED ({type(exc).__name__}: {str(exc)[:160]}); crawling live")
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
            # A migration may return a callable to run AFTER its transaction is durable (file
            # moves etc. that must never precede the commit — see m1).
            after = fn(conn)
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
        if callable(after):
            after()


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
        # 4. Planner statistics. Without them SQLite can't tell that idx_digest_pair_hour is
        #    selective and reads the whole window for one market's history (~50ms a query,
        #    and the board asks two dozen). Measured once, when an index has none — a seeded
        #    install starts from zero, and step 3 may have just built one — so a warm start
        #    pays nothing and a cold one pays ~1s on a 500MB DB.
        has = mconn.execute("SELECT 1 FROM sqlite_master WHERE name='sqlite_stat1'").fetchone()
        measured = has and mconn.execute(
            "SELECT 1 FROM sqlite_stat1 WHERE idx IN ('idx_digest_window','idx_digest_pair_hour')").fetchone()
        if not measured:
            mconn.execute("ANALYZE")
            mconn.commit()
    finally:
        mconn.close()


_boot_databases()


def analyze() -> None:
    """Re-measure the market tables so the query planner keeps choosing the right index.
    Cheap (a few hundred ms on a full year of digest rows) and off the request path: the
    background digest loop calls it after the row count has moved."""
    with tx() as c:
        c.execute("ANALYZE market")


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
    # user.sqlite must survive power loss ("never lose user data"); its writes are rare, debounced
    # single-row upserts, so FULL costs nothing a user can feel. Market data is disposable: NORMAL.
    conn.execute("PRAGMA main.synchronous=FULL")
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


def kv_update(key: str, fn: Callable[[Any], Any], default: Any = None) -> Any:
    """Read-modify-write a kv blob inside ONE write transaction: `fn(current) -> new` runs while
    the app-wide write lock is held, so concurrent updaters (a polled GET and a POST, two threadpool
    requests) can never overwrite each other. `fn` must be pure and quick — it runs under the lock
    and must not touch the DB itself (tx() is not reentrant). Returns the stored value."""
    table = _kv_table(key)
    with tx() as c:
        row = c.execute(f"SELECT value FROM {table} WHERE key=?", (key,)).fetchone()
        value = fn(json.loads(row["value"]) if row else default)
        c.execute(
            f"INSERT INTO {table}(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )
    return value


def get_capital() -> dict[str, float]:
    with q() as c:
        rows = c.execute("SELECT currency, qty FROM capital").fetchall()
    return {r["currency"]: r["qty"] for r in rows}


# ---------------------------------------------------------------- sales ledger (user data)
def sales_upsert(league: str, rows: list[dict]) -> list[dict]:
    """Upsert Merchant History rows by (item_id, time); returns the rows that were NEW. Never deletes."""
    new: list[dict] = []
    with tx() as c:
        for r in rows:
            item_id, t = r.get("item_id"), r.get("time")
            if not item_id or not t:
                continue
            price = r.get("price") or {}
            if not c.execute("SELECT 1 FROM sales WHERE item_id=? AND time=?", (str(item_id), str(t))).fetchone():
                new.append(r)
            c.execute(
                "INSERT INTO sales(item_id, time, league, price_amount, price_currency, item_json) VALUES(?,?,?,?,?,?) "
                "ON CONFLICT(item_id, time) DO UPDATE SET price_amount=excluded.price_amount, price_currency=excluded.price_currency, item_json=excluded.item_json",
                (str(item_id), str(t), league, price.get("amount"), price.get("currency"), json.dumps(r.get("item") or {})),
            )
    return new


def capital_add(currency: str, qty: float) -> None:
    """Credit a holding in place (a sale just paid out): the row is created when absent."""
    if not currency or not qty or float(qty) <= 0:
        return
    with tx() as c:
        c.execute("INSERT INTO capital(currency, qty) VALUES(?, ?) ON CONFLICT(currency) DO UPDATE SET qty = qty + excluded.qty",
                  (currency, float(qty)))


def sales_list(league: str | None = None) -> list[dict]:
    with q() as c:
        if league:
            rows = c.execute("SELECT * FROM sales WHERE league=? ORDER BY time DESC", (league,)).fetchall()
        else:
            rows = c.execute("SELECT * FROM sales ORDER BY time DESC").fetchall()
    out = []
    for r in rows:
        try:
            item = json.loads(r["item_json"])
        except (TypeError, ValueError):
            item = {}
        out.append({"item_id": r["item_id"], "time": r["time"], "league": r["league"],
                    "price": {"amount": r["price_amount"], "currency": r["price_currency"]} if r["price_currency"] else None, "item": item})
    return out


def sales_leagues() -> list[str]:
    with q() as c:
        return [r[0] for r in c.execute("SELECT league FROM sales GROUP BY league ORDER BY MAX(time) DESC").fetchall()]


def sales_count(league: str | None = None) -> int:
    with q() as c:
        return c.execute("SELECT COUNT(*) FROM sales" + (" WHERE league=?" if league else ""), (league,) if league else ()).fetchone()[0]


def set_capital(entries: dict[str, float]) -> None:
    with tx() as c:
        c.execute("DELETE FROM capital")
        c.executemany(
            "INSERT INTO capital(currency, qty) VALUES(?, ?)",
            [(k, float(v)) for k, v in entries.items() if float(v) > 0],
        )
