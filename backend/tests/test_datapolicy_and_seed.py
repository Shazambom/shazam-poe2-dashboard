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
    c.execute("INSERT INTO kv_ops VALUES('seed_cut:Std', ?)", (json.dumps({"day": "2026-01-01", "through": "2026-01-01", "stale": []}),))
    c.execute("INSERT INTO kv_ops VALUES('seed_poll', ?)", (json.dumps({"at": time.time(), "leagues": ["Std"]}),))
    c.execute("INSERT INTO analytics_cache VALUES('discords','current',1,'{}')")
    c.commit()
    c.close()


def _run_exporter(src: Path, out: Path, *extra) -> subprocess.CompletedProcess:
    # The publisher pipes the script into `python -` inside the backend container (cwd=/app, so
    # `app.datapolicy` is importable). Mirror that: stdin + cwd=backend/.
    return subprocess.run([sys.executable, "-", "--src", str(src), "--out", str(out), "--no-gzip",
                           "--version", "42", *extra],
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
    assert {r[0] for r in d.execute("SELECT key FROM kv_ops")} == {"digest_cursor", "lh_current", "seed_cut:Std", "seed_poll"}


# ----------------------------------------------------------------- the seed ships only verified days
# docs/bugs/2026-09-28-partial-sync-data.md: each current league ends on the day the server's seed poll
# verified final for every tracked item (kv `seed_cut:<league>`, app/seedready.py).
def _league_db(path: Path, cuts: dict, current=("Cur",), polled_at=None, stamps=()) -> None:
    _market_db(path, int(time.time()))
    c = sqlite3.connect(str(path))
    c.execute("DELETE FROM kv_ops WHERE key LIKE 'seed_cut:%' OR key IN ('lh_current', 'seed_poll')")
    c.execute("INSERT INTO kv_ops VALUES('lh_current', ?)", (json.dumps(list(current)),))
    c.execute("INSERT INTO kv_ops VALUES('seed_poll', ?)", (json.dumps({"at": polled_at or time.time(), "leagues": list(current)}),))
    for lg, item, at in stamps:
        c.execute("INSERT INTO kv_ops VALUES(?, ?)", (f"lh_fetch:{lg}:{item}", json.dumps(at)))
    for lg in ("Cur", "Old"):
        for day in ("2026-09-26", "2026-09-27", "2026-09-28"):
            for item in (1, 2):
                c.execute("INSERT INTO league_daily VALUES(?,?,?,1.0,1.0,5)", (lg, item, day))
    for lg, day in cuts.items():
        c.execute("INSERT INTO kv_ops VALUES(?,?)", (f"seed_cut:{lg}", json.dumps({"day": day, "through": day, "stale": []})))
    c.execute("INSERT INTO kv_ops VALUES('seed_fp:Cur:1', '{}')")
    c.commit()
    c.close()


def _days(out: Path, league: str) -> list:
    d = sqlite3.connect(str(out))
    return [r[0] for r in d.execute("SELECT DISTINCT day FROM league_daily WHERE league=? ORDER BY day", (league,))]


def test_a_current_league_ends_on_its_verified_day_and_a_past_league_is_untouched(tmp_path):
    src, out = tmp_path / "market.sqlite", tmp_path / "seed.sqlite"
    _league_db(src, {"Cur": "2026-09-27"})
    r = _run_exporter(src, out)
    assert r.returncode == 0, r.stdout + r.stderr
    assert _days(out, "Cur") == ["2026-09-26", "2026-09-27"]
    assert _days(out, "Old") == ["2026-09-26", "2026-09-27", "2026-09-28"]
    assert "Cur" in r.stdout and "2026-09-27" in r.stdout, "each league's cut is printed"
    assert json.loads((tmp_path / "seed.sqlite.cut").read_text())["cuts"] == {"Cur": "2026-09-27"}


def test_the_poll_bookkeeping_does_not_ship(tmp_path):
    src, out = tmp_path / "market.sqlite", tmp_path / "seed.sqlite"
    _league_db(src, {"Cur": "2026-09-27"})
    assert _run_exporter(src, out).returncode == 0
    d = sqlite3.connect(str(out))
    assert d.execute("SELECT COUNT(*) FROM kv_ops WHERE key LIKE 'seed_fp:%'").fetchone()[0] == 0


def test_a_league_with_no_verified_day_ships_none_of_its_days(tmp_path):
    src, out = tmp_path / "market.sqlite", tmp_path / "seed.sqlite"
    _league_db(src, {"Cur": None})
    assert _run_exporter(src, out).returncode == 0
    assert _days(out, "Cur") == []


def test_a_current_league_the_poll_never_checked_is_refused_loudly(tmp_path):
    """No record means the seed poll is not running on the server: a setup bug, never a silent
    partial seed."""
    src, out = tmp_path / "market.sqlite", tmp_path / "seed.sqlite"
    _league_db(src, {})
    r = _run_exporter(src, out)
    assert r.returncode != 0 and "seed_cut:Cur" in (r.stdout + r.stderr)
    assert not out.exists()


def test_an_hourly_run_publishes_only_a_newer_complete_day(tmp_path):
    src, out = tmp_path / "market.sqlite", tmp_path / "seed.sqlite"
    prev = tmp_path / "published.cut"
    _league_db(src, {"Cur": "2026-09-27"})
    assert _run_exporter(src, out).returncode == 0
    (tmp_path / "seed.sqlite.cut").rename(prev)
    out.unlink()
    r = _run_exporter(src, out, "--only-if-newer", str(prev))
    assert r.returncode == 3 and not out.exists(), "same day already published today: nothing to do"

    _league_db(src2 := tmp_path / "m2.sqlite", {"Cur": "2026-09-28"})
    r = _run_exporter(src2, out, "--only-if-newer", str(prev))
    assert r.returncode == 0 and _days(out, "Cur")[-1] == "2026-09-28"


def test_the_first_run_of_a_new_day_always_publishes(tmp_path):
    src, out = tmp_path / "market.sqlite", tmp_path / "seed.sqlite"
    prev = tmp_path / "published.cut"
    prev.write_text(json.dumps({"date": "2000-01-01", "cuts": {"Cur": "2026-09-27"}}))
    _league_db(src, {"Cur": "2026-09-27"})
    assert _run_exporter(src, out, "--only-if-newer", str(prev)).returncode == 0


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


def test_a_stale_poll_is_refused_loudly(tmp_path):
    """A poll that stopped would otherwise keep shipping a days-old cut and silently drop newer days."""
    src, out = tmp_path / "market.sqlite", tmp_path / "seed.sqlite"
    _league_db(src, {"Cur": "2026-09-27"}, polled_at=time.time() - 4 * 3600)
    r = _run_exporter(src, out)
    assert r.returncode != 0 and "seed poll" in (r.stdout + r.stderr) and not out.exists()


def test_only_the_leagues_the_poll_covered_are_cut(tmp_path):
    """A league that just ended can linger in the crawl's lh_current; the poll's own list decides."""
    src, out = tmp_path / "market.sqlite", tmp_path / "seed.sqlite"
    _league_db(src, {"Cur": "2026-09-27"})
    c = sqlite3.connect(str(src))
    c.execute("UPDATE kv_ops SET value=? WHERE key='lh_current'", (json.dumps(["Cur", "Old"]),))
    c.commit(); c.close()
    assert _run_exporter(src, out).returncode == 0
    assert _days(out, "Old") == ["2026-09-26", "2026-09-27", "2026-09-28"]


def test_fetch_stamps_never_claim_more_than_the_seed_ships(tmp_path):
    """A stamp newer than the cut would make a client drop its own newer rows on a seed replace
    (_carry_crawl keeps the seed's) and skip refetching them for 12 hours."""
    import calendar
    end_of_cut = calendar.timegm(time.strptime("2026-09-28", "%Y-%m-%d"))
    src, out = tmp_path / "market.sqlite", tmp_path / "seed.sqlite"
    _league_db(src, {"Cur": "2026-09-27"}, stamps=[("Cur", 1, end_of_cut + 5000), ("Cur", 2, end_of_cut - 5000),
                                                   ("Old", 1, end_of_cut + 5000)])
    assert _run_exporter(src, out).returncode == 0
    d = sqlite3.connect(str(out))
    st = {k: float(v) for k, v in d.execute("SELECT key, value FROM kv_ops WHERE key LIKE 'lh_fetch:%'")}
    assert st["lh_fetch:Cur:1"] == end_of_cut, "clamped to the end of the cut day"
    assert st["lh_fetch:Cur:2"] == end_of_cut - 5000, "an older stamp is left alone"
    assert st["lh_fetch:Old:1"] == end_of_cut + 5000, "a league not cut keeps its stamps"


def test_a_league_with_no_verified_day_ships_no_fetch_stamps_either(tmp_path):
    src, out = tmp_path / "market.sqlite", tmp_path / "seed.sqlite"
    _league_db(src, {"Cur": None}, stamps=[("Cur", 1, time.time())])
    assert _run_exporter(src, out).returncode == 0
    d = sqlite3.connect(str(out))
    assert d.execute("SELECT COUNT(*) FROM kv_ops WHERE key LIKE 'lh_fetch:Cur:%'").fetchone()[0] == 0
