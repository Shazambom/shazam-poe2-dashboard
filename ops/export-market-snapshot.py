#!/usr/bin/env python3
"""Export a market snapshot (market-seed.sqlite) from a live poe2 dashboard DB.

The snapshot is the disposable market/operational half of the DB, prebuilt so fresh
desktop installs start with a full history instead of a slow cold crawl. It carries the
crawl watermarks (operational kv) so the client catches up snapshot->now rather than
re-crawling. See docs/db-architecture.md and docs/db-maintenance.md.

Runs on shazam against the live DB (single-file legacy or split). Usage:

    python3 export-market-snapshot.py --src /data/poe2arb.sqlite --out market-seed.sqlite [--version N]

- Copies market tables (digest windowed, league_daily/item_meta full).
- Copies OPERATIONAL kv into kv_ops (everything except user keys: settings, watches,
  oauth_pending, meta_overrides, secret:*).
- Stamps market_meta.snapshot_version (default: current epoch seconds — monotonic).
- VACUUMs for a small bundle.

The output schema MUST match backend/app/db.py MARKET_SCHEMA. Keep them in sync; when
MARKET_SCHEMA changes, a version bump ships automatically (epoch grows).
"""
import argparse
import gzip
import os
import shutil
import sqlite3
import sys
import time

# Mirrors backend/app/db.py MARKET_SCHEMA. Kept inline so the script is standalone.
MARKET_SCHEMA = """
CREATE TABLE IF NOT EXISTS digest_markets (
    hour INTEGER NOT NULL, league TEXT NOT NULL, market_id TEXT NOT NULL,
    cur_a TEXT NOT NULL, cur_b TEXT NOT NULL,
    vol_a INTEGER, vol_b INTEGER,
    lo_stock_a INTEGER, lo_stock_b INTEGER, hi_stock_a INTEGER, hi_stock_b INTEGER,
    lo_ratio_a INTEGER, lo_ratio_b INTEGER, hi_ratio_a INTEGER, hi_ratio_b INTEGER,
    PRIMARY KEY (hour, league, market_id)
);
CREATE INDEX IF NOT EXISTS idx_digest_league_hour ON digest_markets(league, hour);
CREATE INDEX IF NOT EXISTS idx_digest_pair ON digest_markets(league, cur_a, cur_b);
CREATE TABLE IF NOT EXISTS orderbook (
    league TEXT NOT NULL, have TEXT NOT NULL, want TEXT NOT NULL,
    fetched_at INTEGER NOT NULL, offers TEXT NOT NULL,
    PRIMARY KEY (league, have, want)
);
CREATE TABLE IF NOT EXISTS orderbook_history (
    league TEXT NOT NULL, have TEXT NOT NULL, want TEXT NOT NULL,
    fetched_at INTEGER NOT NULL, best_rate REAL, best_stock INTEGER, depth INTEGER
);
CREATE INDEX IF NOT EXISTS idx_obh ON orderbook_history(league, have, want, fetched_at);
CREATE TABLE IF NOT EXISTS league_daily (
    league TEXT NOT NULL, item_id INTEGER NOT NULL, day TEXT NOT NULL,
    close REAL, average REAL, volume INTEGER,
    PRIMARY KEY (league, item_id, day)
);
CREATE INDEX IF NOT EXISTS idx_league_daily_item ON league_daily(item_id, day);
CREATE TABLE IF NOT EXISTS item_meta (
    item_id INTEGER PRIMARY KEY, name TEXT, category TEXT
);
CREATE TABLE IF NOT EXISTS kv_ops (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS market_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

# Keys that belong to the USER, never exported. Mirrors _USER_KV in db.py.
USER_KV = {"settings", "watches", "oauth_pending", "meta_overrides"}

# Only keep the recent digest window; it's a rolling board input, not long history.
# The board's longest horizon is 14d; digest catch-up is forward-only, so the seed must
# already contain the history the horizons render.
DIGEST_WINDOW_DAYS = 14


def _is_user_kv(key: str) -> bool:
    return key in USER_KV or key.startswith("secret:")


def _copy_table(src, dst, table, where=""):
    cols = [r[1] for r in src.execute(f"PRAGMA table_info({table})")]
    if not cols:
        print(f"  {table}: not present in source, skipping")
        return 0
    collist = ",".join(cols)
    ph = ",".join("?" * len(cols))
    rows = src.execute(f"SELECT {collist} FROM {table} {where}").fetchall()
    dst.executemany(f"INSERT INTO {table}({collist}) VALUES({ph})", rows)
    print(f"  {table}: copied {len(rows)} rows")
    return len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="live DB (poe2arb.sqlite or market.sqlite)")
    ap.add_argument("--out", required=True, help="output market-seed.sqlite")
    ap.add_argument("--version", type=int, default=None,
                    help="snapshot_version (default: current epoch seconds)")
    ap.add_argument("--all-leagues", action="store_true",
                    help="keep private/dead leagues too (default: public leagues only)")
    ap.add_argument("--no-gzip", action="store_true",
                    help="write a plain .sqlite instead of gzipping (default: gzip)")
    ap.add_argument("--max-digest-lag-h", type=float, default=3.0,
                    help="refuse to export if the digest is more than this many hours behind the "
                         "current hour (i.e. a sync is still catching up). Guards against shipping a "
                         "half-synced snapshot that would make every client re-seed into gappy data.")
    ap.add_argument("--force", action="store_true",
                    help="skip the digest freshness guard (export even if mid-sync)")
    args = ap.parse_args()

    # Digest is dominated by hundreds of tiny dead private leagues "(PLxxxxx)"; drop them
    # unless asked otherwise. Nobody trades them, and catch-up forward-fills any league.
    league_filter = "" if args.all_leagues else "AND league NOT LIKE '%(PL%'"

    version = args.version if args.version is not None else int(time.time())
    tmp = args.out + ".tmp"
    for p in (tmp, args.out):
        if os.path.exists(p):
            os.remove(p)

    src = sqlite3.connect(f"file:{args.src}?mode=ro", uri=True, timeout=30)
    dst = sqlite3.connect(tmp)
    try:
        # Guard: never publish a snapshot while the digest is mid-catch-up — a partial sync would
        # ship gappy data to every client that re-seeds from it. digest_cursor is the next hour to
        # fetch; when caught up it sits at ~the current (unpublished) hour. Live under one
        # consistent read (BEGIN) so all table copies see the same point-in-time even under writes.
        src.execute("BEGIN")
        tset = {r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        kvt = "kv_ops" if "kv_ops" in tset else ("kv" if "kv" in tset else None)
        cursor = None
        if kvt:
            row = src.execute(f"SELECT value FROM {kvt} WHERE key='digest_cursor'").fetchone()
            if row and row[0] is not None:
                try:
                    import json as _json
                    cursor = int(_json.loads(row[0]))
                except Exception:
                    try: cursor = int(row[0])
                    except Exception: cursor = None
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

        dst.executescript(MARKET_SCHEMA)

        # Digest: recent window only (bounds bundle size). `hour` is epoch seconds.
        cutoff = int(time.time()) - DIGEST_WINDOW_DAYS * 86400
        _copy_table(src, dst, "digest_markets",
                    where=f"WHERE hour >= {cutoff} {league_filter}")
        _copy_table(src, dst, "league_daily")   # full: the long price history
        _copy_table(src, dst, "item_meta")      # full: id->name mapping
        _copy_table(src, dst, "orderbook")      # usually empty/transient
        _copy_table(src, dst, "orderbook_history")

        # Operational kv -> kv_ops (drives catch-up). Split-aware: a post-split
        # market.sqlite already holds ONLY operational keys in `kv_ops` (user keys live
        # in user.sqlite.kv). A legacy single-file DB has everything in `kv`; there we
        # filter out user keys. Detect which table exists rather than assume.
        tables = {r[0] for r in src.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        if "kv_ops" in tables:                       # split market.sqlite
            ops = src.execute("SELECT key, value FROM kv_ops").fetchall()
            skipped = 0
        elif "kv" in tables:                         # legacy single-file DB
            kv_rows = src.execute("SELECT key, value FROM kv").fetchall()
            ops = [(k, v) for (k, v) in kv_rows if not _is_user_kv(k)]
            skipped = len(kv_rows) - len(ops)
        else:
            raise SystemExit(f"{args.src}: no kv/kv_ops table — is this a market DB?")
        dst.executemany("INSERT INTO kv_ops(key, value) VALUES(?, ?)", ops)
        print(f"  kv_ops: copied {len(ops)} operational keys (skipped {skipped} user keys)")

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
