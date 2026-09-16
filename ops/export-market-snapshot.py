#!/usr/bin/env python3
"""Export a market snapshot (market-seed.sqlite) from the live dashboard's market.sqlite.

The snapshot is the disposable market/operational half of the DB, prebuilt so fresh desktop
installs start with a full history instead of a slow cold crawl. It carries the crawl
watermarks (kv_ops) so the client catches up snapshot->now rather than re-crawling. See
docs/db-architecture.md and docs/db-maintenance.md.

Runs ON shazam, INSIDE the backend container (cwd=/app, so `app.datapolicy` is importable —
that module is dependency-free and triggers no DB boot). The publisher pipes this file into
`python -`:

    python3 - --src /data/market.sqlite --out /data/market-seed.sqlite.gz [--version N] < export-market-snapshot.py

What ships (datapolicy.SEED_TABLES): digest_markets (windowed to MARKET_RETENTION_DAYS, public
leagues only), league_daily + item_meta (full history), kv_ops (crawl watermarks + bridge).
NOT shipped: orderbook/orderbook_history (session-bound, re-accrue live in minutes) and the
analytics_* runtime tables (the sidecar recomputes). The DDL of every shipped table — and its
indices — is copied from the SOURCE's sqlite_master, so the seed schema is the live schema by
construction and a MARKET_SCHEMA change in db.py needs no edit here. Only the exporter-owned
`market_meta` (snapshot_version) is defined inline.
"""
import argparse
import gzip
import json
import os
import shutil
import sqlite3
import sys
import time

try:
    from app.datapolicy import MARKET_RETENTION_DAYS, SEED_TABLES
except ImportError as exc:                     # pragma: no cover — misuse, not a code path
    raise SystemExit(f"run this from the backend directory / container (cwd=/app): {exc}")

MARKET_META_DDL = "CREATE TABLE IF NOT EXISTS market_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"


def _copy_ddl(src, dst, table):
    """Recreate `table` (+ its indices) in dst exactly as the source defines it."""
    rows = src.execute(
        "SELECT type, sql FROM sqlite_master WHERE tbl_name=? AND sql IS NOT NULL "
        "ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END", (table,)).fetchall()
    if not rows:
        raise SystemExit(f"{table}: not present in source — not a market.sqlite?")
    for _type, sql in rows:
        dst.execute(sql)


def _copy_rows(src, dst, table, where=""):
    cols = [r[1] for r in src.execute(f"PRAGMA table_info({table})")]
    collist = ",".join(cols)
    ph = ",".join("?" * len(cols))
    rows = src.execute(f"SELECT {collist} FROM {table} {where}").fetchall()
    dst.executemany(f"INSERT INTO {table}({collist}) VALUES({ph})", rows)
    print(f"  {table}: copied {len(rows)} rows")
    return len(rows)


def _digest_cursor(src):
    row = src.execute("SELECT value FROM kv_ops WHERE key='digest_cursor'").fetchone()
    if not row or row[0] is None:
        return None
    try:
        return int(json.loads(row[0]))
    except (ValueError, TypeError):
        try:
            return int(row[0])
        except (ValueError, TypeError):
            return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="live market.sqlite")
    ap.add_argument("--out", required=True, help="output market-seed.sqlite[.gz]")
    ap.add_argument("--version", type=int, default=None,
                    help="snapshot_version (default: current epoch seconds — monotonic)")
    ap.add_argument("--all-leagues", action="store_true",
                    help="keep private/dead leagues too (default: public leagues only)")
    ap.add_argument("--no-gzip", action="store_true",
                    help="write a plain .sqlite instead of gzipping (default: gzip)")
    ap.add_argument("--max-digest-lag-h", type=float, default=3.0,
                    help="refuse to export if the digest is more than this many hours behind the "
                         "current hour (a sync is still catching up) — guards against shipping a "
                         "half-synced snapshot that would make every client re-seed into gappy data.")
    ap.add_argument("--force", action="store_true",
                    help="skip the digest freshness guard (export even if mid-sync)")
    args = ap.parse_args()

    # Digest is dominated by hundreds of tiny dead private leagues "(PLxxxxx)"; drop them from
    # the SEED unless asked otherwise (the client itself keeps whatever league it is configured
    # for — a private-league user is not filtered at ingest).
    league_filter = "" if args.all_leagues else "AND league NOT LIKE '%(PL%'"

    version = args.version if args.version is not None else int(time.time())
    tmp = args.out + ".tmp"
    for p in (tmp, args.out):
        if os.path.exists(p):
            os.remove(p)

    src = sqlite3.connect(f"file:{args.src}?mode=ro", uri=True, timeout=30)
    dst = sqlite3.connect(tmp)
    try:
        # One consistent read (BEGIN) so every copy sees the same point-in-time under writes.
        src.execute("BEGIN")
        tables = {r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "kv_ops" not in tables:
            raise SystemExit(f"{args.src}: no kv_ops table — this exporter reads the split "
                             f"market.sqlite only (the legacy single-file DB is gone post-split)")

        # Guard: never publish while the digest is mid-catch-up. digest_cursor is the next hour
        # to fetch; when caught up it sits at ~the current (unpublished) hour.
        cursor = _digest_cursor(src)
        now_hour = int(time.time()) - int(time.time()) % 3600
        if cursor is not None:
            lag_h = (now_hour - cursor) / 3600.0
            print(f"  digest_cursor lag: {lag_h:.1f}h (cursor={cursor}, now_hour={now_hour})")
            if lag_h > args.max_digest_lag_h and not args.force:
                raise SystemExit(
                    f"ABORT: digest is {lag_h:.1f}h behind (> {args.max_digest_lag_h}h) — a sync is "
                    f"still catching up. Refusing to publish a half-synced snapshot. Re-run when "
                    f"caught up, or pass --force.")
        elif not args.force:
            raise SystemExit("ABORT: no digest_cursor found — can't confirm the sync is complete. "
                             "Pass --force to override.")

        for t in SEED_TABLES:
            _copy_ddl(src, dst, t)
        dst.execute(MARKET_META_DDL)

        cutoff = int(time.time()) - MARKET_RETENTION_DAYS * 86400   # `hour` is epoch seconds
        _copy_rows(src, dst, "digest_markets", where=f"WHERE hour >= {cutoff} {league_filter}")
        for t in SEED_TABLES:
            if t != "digest_markets":
                _copy_rows(src, dst, t)

        dst.execute("INSERT OR REPLACE INTO market_meta(key, value) VALUES('snapshot_version', ?)",
                    (str(version),))
        dst.commit()
        dst.execute("VACUUM")
        dst.commit()
    finally:
        src.close()
        dst.close()

    if args.no_gzip:
        os.replace(tmp, args.out)
        out_path = args.out
    else:
        # Ship gzipped: a mostly-integer sqlite compresses ~8x, keeping the installer small.
        # The backend decompresses once during seeding. A plaintext .version sidecar lets
        # the backend compare snapshot_version WITHOUT decompressing on every launch.
        out_path = args.out if args.out.endswith(".gz") else args.out + ".gz"
        with open(tmp, "rb") as fi, gzip.open(out_path, "wb", compresslevel=6) as fo:
            shutil.copyfileobj(fi, fo)
        os.remove(tmp)
        with open(out_path + ".version", "w") as vf:
            vf.write(str(version))

    size_mb = os.path.getsize(out_path) / 1e6
    print(f"snapshot written: {out_path} (v{version}, {size_mb:.1f} MB)")


if __name__ == "__main__":
    sys.exit(main())
