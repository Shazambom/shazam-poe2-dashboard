"""A newer seed replaces market.sqlite, but the client's own crawl that is newer than the seed's
survives it (owner, 2026-09-28). Beta telemetry: the Windows client had refetched 183 of
Forbidden Rites' 527 items on 0.3.6-beta.3; the update to beta.4 replaced the DB with a seed whose
crawl stamps were older, and the crawl restarted at 2/527.

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_seed_carryover.py -q
"""
import gzip
import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import db  # noqa: E402

LG = "Forbidden Rites"


def _market(path: Path, version: int, daily=(), stamps=(), complete=(), wal=False) -> None:
    c = sqlite3.connect(str(path))
    if wal:
        c.execute("PRAGMA journal_mode=WAL")
    c.executescript(db.MARKET_SCHEMA)
    c.execute("INSERT OR REPLACE INTO market_meta(key, value) VALUES('snapshot_version', ?)", (str(version),))
    c.executemany("INSERT INTO league_daily VALUES (?,?,?,?,?,?)", daily)
    c.executemany("INSERT INTO kv_ops(key, value) VALUES (?,?)",
                  [(f"lh_fetch:{lg}:{i}", json.dumps(t)) for lg, i, t in stamps]
                  + [(f"lh_complete:{lg}:{i}", "true") for lg, i in complete])
    c.commit()
    if not wal:
        c.close()
    return c


def _seed(d: Path, version: int, **kw) -> None:
    raw = d / "seed.sqlite"
    _market(raw, version, **kw)
    with open(raw, "rb") as fi, gzip.open(d / "market-seed.sqlite.gz", "wb") as fo:
        fo.write(fi.read())
    (d / "market-seed.sqlite.gz.version").write_text(str(version))
    raw.unlink()


def _rows(path: Path, sql: str, *p):
    c = sqlite3.connect(str(path))
    try:
        return c.execute(sql, p).fetchall()
    finally:
        c.close()


@pytest.fixture
def env(tmp_path, monkeypatch):
    market = tmp_path / "market.sqlite"
    monkeypatch.setattr(db, "MARKET_DB_PATH", market)
    monkeypatch.setattr(db, "MARKET_SEED_PATH", tmp_path / "market-seed.sqlite.gz")
    lines = []
    monkeypatch.setattr(db.devtelemetry, "tlog", lambda tag, msg: lines.append(f"[{tag}] {msg}"))
    return tmp_path, market, lines


def test_items_the_client_crawled_after_the_seed_keep_their_rows_and_stamps(env):
    d, market, lines = env
    # The seed's crawl: items 1 and 2 fetched at t=100, history through 09-26.
    _seed(d, 20, daily=[(LG, 1, "2026-09-26", 1.0, 1.0, 5), (LG, 2, "2026-09-26", 2.0, 2.0, 5)],
          stamps=[(LG, 1, 100.0), (LG, 2, 100.0)])
    # The client's older DB: item 1 refetched at t=500 (09-26 final, 09-27 new); item 2 last seen at t=50.
    _market(market, 10,
            daily=[(LG, 1, "2026-09-26", 1.5, 1.5, 9), (LG, 1, "2026-09-27", 1.7, 1.7, 3), (LG, 2, "2026-09-25", 9.0, 9.0, 1)],
            stamps=[(LG, 1, 500.0), (LG, 2, 50.0)])
    db.seed_market()
    assert db._read_snapshot_version(market) == 20
    assert _rows(market, "SELECT day, close FROM league_daily WHERE item_id=1 ORDER BY day") == [("2026-09-26", 1.5), ("2026-09-27", 1.7)]
    assert _rows(market, "SELECT value FROM kv_ops WHERE key=?", f"lh_fetch:{LG}:1") == [("500.0",)]
    # The seed crawled item 2 more recently: its rows and stamp are the seed's.
    assert _rows(market, "SELECT day, close FROM league_daily WHERE item_id=2 ORDER BY day") == [("2026-09-26", 2.0)]
    assert _rows(market, "SELECT value FROM kv_ops WHERE key=?", f"lh_fetch:{LG}:2") == [("100.0",)]
    assert "[seed] carried over 1 crawled item(s), 2 row(s), newer than the seed" in lines, lines


def test_an_item_the_seed_never_crawled_comes_over_with_its_complete_mark(env):
    d, market, lines = env
    _seed(d, 20)
    _market(market, 10, daily=[("Dawn of the Hunt", 7, "2025-06-01", 3.0, 3.0, 1)],
            stamps=[("Dawn of the Hunt", 7, 42.0)], complete=[("Dawn of the Hunt", 7)])
    db.seed_market()
    assert _rows(market, "SELECT close FROM league_daily WHERE league='Dawn of the Hunt' AND item_id=7") == [(3.0,)]
    assert _rows(market, "SELECT value FROM kv_ops WHERE key='lh_complete:Dawn of the Hunt:7'") == [("true",)]


def test_a_league_name_with_a_colon_is_keyed_by_its_last_segment(env):
    d, market, _ = env
    _seed(d, 20)
    _market(market, 10, daily=[("A: B", 3, "2026-09-27", 4.0, 4.0, 1)], stamps=[("A: B", 3, 9.0)])
    db.seed_market()
    assert _rows(market, "SELECT close FROM league_daily WHERE league='A: B' AND item_id=3") == [(4.0,)]


def test_rows_still_in_the_old_db_wal_are_carried(env):
    """The previous run's last writes can sit in market.sqlite-wal; the replace deletes the WAL,
    so the carry-over must read through it first."""
    d, market, _ = env
    _seed(d, 20)
    held = _market(market, 10, daily=[(LG, 4, "2026-09-27", 6.0, 6.0, 1)], stamps=[(LG, 4, 7.0)], wal=True)
    try:
        assert (d / "market.sqlite-wal").exists(), "the fixture must leave the rows in the WAL"
        db.seed_market()
    finally:
        held.close()
    assert _rows(market, "SELECT close FROM league_daily WHERE item_id=4") == [(6.0,)]


def test_the_replaced_file_holds_the_carried_rows_without_a_sidecar(env):
    """A seed exported in WAL mode would leave the merge in market.sqlite.tmp-wal, which the rename
    does not move: the merge must land in the main file."""
    d, market, _ = env
    raw = d / "seed.sqlite"
    c = _market(raw, 20, wal=True)
    c.close()
    with open(raw, "rb") as fi, gzip.open(d / "market-seed.sqlite.gz", "wb") as fo:
        fo.write(fi.read())
    (d / "market-seed.sqlite.gz.version").write_text("20")
    raw.unlink()
    _market(market, 10, daily=[(LG, 5, "2026-09-27", 8.0, 8.0, 1)], stamps=[(LG, 5, 7.0)])
    db.seed_market()
    assert not (d / "market.sqlite.tmp-wal").exists() and not (d / "market.sqlite.tmp").exists()
    assert _rows(market, "SELECT close FROM league_daily WHERE item_id=5") == [(8.0,)]


def test_an_unreadable_old_db_takes_the_seed_with_nothing_to_carry_and_no_t0(env):
    """A corrupt local DB is often why it is being replaced: there is no crawl anyone could read, so
    nothing is lost. The seed applies; one plain line says so; no T0 blocks the stable release."""
    d, market, lines = env
    _seed(d, 20, daily=[(LG, 1, "2026-09-26", 1.0, 1.0, 5)])
    market.write_bytes(b"not a database, but it has a snapshot version of 0")
    db.seed_market()
    assert db._read_snapshot_version(market) == 20, "the seed applies"
    assert not any(l.startswith("[T0]") for l in lines), lines
    assert any(l.startswith("[seed] local DB unreadable (v-1); nothing to carry") for l in lines), lines


def test_an_old_layout_without_the_crawl_tables_has_nothing_to_carry(env):
    d, market, lines = env
    _seed(d, 20)
    c = sqlite3.connect(str(market))
    c.execute("CREATE TABLE market_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    c.execute("INSERT INTO market_meta VALUES ('snapshot_version', '3')")
    c.commit(); c.close()
    db.seed_market()
    assert db._read_snapshot_version(market) == 20
    assert not any(l.startswith("[T0]") for l in lines), lines


def test_a_carry_that_fails_on_a_readable_db_is_still_a_t0(env, monkeypatch):
    """A readable client crawl the replace could not keep IS lost: that stays a T0."""
    d, market, lines = env
    _seed(d, 20)
    _market(market, 10, daily=[(LG, 1, "2026-09-27", 1.0, 1.0, 1)], stamps=[(LG, 1, 9.0)])
    def boom(new, old):
        raise sqlite3.OperationalError("disk I/O error")
    monkeypatch.setattr(db, "_carry_crawl", boom)
    db.seed_market()
    assert db._read_snapshot_version(market) == 20
    assert any(l.startswith("[T0] crawl-lost: OperationalError: disk I/O error") for l in lines), lines


def test_a_first_install_has_nothing_to_carry(env):
    d, market, lines = env
    _seed(d, 20, daily=[(LG, 1, "2026-09-26", 1.0, 1.0, 5)])
    db.seed_market()
    assert db._read_snapshot_version(market) == 20
    assert not any("carried over" in l or "crawl-lost" in l for l in lines), lines
