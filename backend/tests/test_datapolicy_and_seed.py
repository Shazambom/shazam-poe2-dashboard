"""Batch 3 — one source of truth for data classification + the seed exporter (audit F-04, F-11).

  * app.datapolicy: the ONLY definition of the user-kv allow-list and market retention;
    db.py and migrations_user.py import it (no hand-mirrored copies anywhere).
  * ops/export-market-snapshot.py derives the seed DDL from the source DB's sqlite_master for
    an explicit export-table list (no inline schema copy, no legacy single-file branch), never
    ships the transient orderbook tables, and windows digest rows by MARKET_RETENTION_DAYS.
  * digest / orderbook prune their unbounded tables by age (called from loops that already run).

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_datapolicy_and_seed.py -q
"""
import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import datapolicy, db, digest, migrations_user, orderbook  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
EXPORTER = ROOT / "ops" / "export-market-snapshot.py"


# ----------------------------------------------------------------- single source of truth
def test_datapolicy_is_dependency_free():
    src = (ROOT / "backend" / "app" / "datapolicy.py").read_text()
    assert "from ." not in src and "import app" not in src


def test_db_and_migrations_use_datapolicy():
    assert db._is_user_kv is datapolicy.is_user_kv
    assert migrations_user._is_user_kv is datapolicy.is_user_kv
    assert not hasattr(migrations_user, "_LEGACY_USER_KV")
    assert datapolicy.is_user_kv("signals_ack") and datapolicy.is_user_kv("secret:x")
    assert not datapolicy.is_user_kv("digest_cursor")


def test_exporter_has_no_mirrored_schema_or_kv_list():
    src = EXPORTER.read_text()
    assert "CREATE TABLE IF NOT EXISTS digest_markets" not in src
    assert "USER_KV" not in src
    assert "FROM kv " not in src and "FROM kv\n" not in src   # legacy single-file branch is gone


def test_retention_covers_the_longest_reader_window():
    # inflation reads 336h of digest; orderbook history readers use 48h.
    assert datapolicy.MARKET_RETENTION_DAYS * 24 >= 336
    assert datapolicy.ORDERBOOK_HISTORY_RETENTION_H >= 48


# ----------------------------------------------------------------- exporter end-to-end
def _market_db(path: Path, now: int) -> None:
    c = sqlite3.connect(str(path))
    c.executescript(db.MARKET_SCHEMA)
    hour = now - now % 3600
    old = hour - (datapolicy.MARKET_RETENTION_DAYS + 2) * 86400
    rows = [(hour - 3600, "Std", "m1", "A", "B", 1, 2, 0, 0, 0, 0, 0, 0, 0, 0),
            (old, "Std", "m1", "A", "B", 1, 2, 0, 0, 0, 0, 0, 0, 0, 0),
            (hour - 3600, "Dead (PL12345)", "m2", "A", "B", 1, 2, 0, 0, 0, 0, 0, 0, 0, 0)]
    c.executemany("INSERT INTO digest_markets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    c.execute("INSERT INTO league_daily VALUES('Std', 291, '2026-01-01', 1.0, 1.0, 10)")
    c.execute("INSERT INTO item_meta VALUES(291, 'Divine Orb', 'currency')")
    c.execute("INSERT INTO orderbook VALUES('Std','a','b',?, '[]')", (now,))
    c.execute("INSERT INTO orderbook_history VALUES('Std','a','b',?, 1.0, 1, 1)", (now,))
    c.execute("INSERT INTO kv_ops VALUES('digest_cursor', ?)", (json.dumps(hour),))
    c.execute("INSERT INTO kv_ops VALUES('lh_current', '[\"Std\"]')")
    c.execute("INSERT INTO analytics_cache VALUES('discords','current',1,'{}')")
    c.commit()
    c.close()


def _run_exporter(src: Path, out: Path) -> subprocess.CompletedProcess:
    # The publisher pipes the script into `python -` inside the backend container (cwd=/app, so
    # `app.datapolicy` is importable). Mirror that: stdin + cwd=backend/.
    return subprocess.run([sys.executable, "-", "--src", str(src), "--out", str(out), "--no-gzip",
                           "--version", "42"],
                          input=EXPORTER.read_text(), text=True, capture_output=True,
                          cwd=str(ROOT / "backend"))


def test_exporter_derives_schema_from_source_and_windows_data(tmp_path):
    now = int(time.time())
    src, out = tmp_path / "market.sqlite", tmp_path / "seed.sqlite"
    _market_db(src, now)
    r = _run_exporter(src, out)
    assert r.returncode == 0, r.stdout + r.stderr
    s = sqlite3.connect(str(src))
    d = sqlite3.connect(str(out))
    for t in ("digest_markets", "league_daily", "item_meta", "kv_ops"):
        assert d.execute("SELECT sql FROM sqlite_master WHERE name=?", (t,)).fetchone() == \
               s.execute("SELECT sql FROM sqlite_master WHERE name=?", (t,)).fetchone(), t
    # indices come along with their tables
    src_idx = {r[0] for r in s.execute("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='digest_markets'")}
    dst_idx = {r[0] for r in d.execute("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='digest_markets'")}
    assert src_idx == dst_idx
    names = {r[0] for r in d.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "orderbook" not in names and "orderbook_history" not in names
    assert "analytics_cache" not in names and "analytics_jobs" not in names
    assert "market_meta" in names
    assert d.execute("SELECT COUNT(*) FROM digest_markets").fetchone()[0] == 1   # old + private dropped
    assert d.execute("SELECT value FROM market_meta WHERE key='snapshot_version'").fetchone()[0] == "42"
    assert {r[0] for r in d.execute("SELECT key FROM kv_ops")} == {"digest_cursor", "lh_current"}


def test_exporter_refuses_a_legacy_single_file_db(tmp_path):
    src, out = tmp_path / "poe2arb.sqlite", tmp_path / "seed.sqlite"
    c = sqlite3.connect(str(src))
    c.executescript(db.USER_SCHEMA)          # has `kv`, no `kv_ops`
    c.commit()
    c.close()
    r = _run_exporter(src, out)
    assert r.returncode != 0 and "kv_ops" in (r.stdout + r.stderr)


# ----------------------------------------------------------------- retention pruning
def test_digest_prune_old_removes_rows_past_retention():
    now = int(time.time())
    keep = now - (datapolicy.MARKET_RETENTION_DAYS - 1) * 86400
    drop = now - (datapolicy.MARKET_RETENTION_DAYS + 1) * 86400
    with db.tx() as c:
        c.execute("DELETE FROM digest_markets WHERE league='PruneL'")
        c.executemany("INSERT INTO digest_markets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      [(keep, "PruneL", "m", "A", "B", 1, 1, 0, 0, 0, 0, 0, 0, 0, 0),
                       (drop, "PruneL", "m", "A", "B", 1, 1, 0, 0, 0, 0, 0, 0, 0, 0)])
    assert digest.prune_old() == 1
    with db.q() as c:
        hours = [r[0] for r in c.execute("SELECT hour FROM digest_markets WHERE league='PruneL'")]
    assert hours == [keep]


def test_orderbook_prune_history_removes_rows_past_retention():
    now = int(time.time())
    keep = now - (datapolicy.ORDERBOOK_HISTORY_RETENTION_H - 1) * 3600
    drop = now - (datapolicy.ORDERBOOK_HISTORY_RETENTION_H + 1) * 3600
    with db.tx() as c:
        c.execute("DELETE FROM orderbook_history WHERE league='PruneL'")
        c.executemany("INSERT INTO orderbook_history VALUES(?,?,?,?,?,?,?)",
                      [("PruneL", "a", "b", keep, 1.0, 1, 1), ("PruneL", "a", "b", drop, 1.0, 1, 1)])
    assert orderbook.prune_history() == 1
    with db.q() as c:
        ts = [r[0] for r in c.execute("SELECT fetched_at FROM orderbook_history WHERE league='PruneL'")]
    assert ts == [keep]
