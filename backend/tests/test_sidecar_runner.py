"""TDD for Phase 6 — the sidecar runtime loop (claim → compute → write cache).

Proves the whole transport end-to-end WITHOUT spawning a process: enqueue a job on a market DB,
run one iteration of the sidecar's runner against that same DB, and see the results land in
analytics_cache. Also proves an unknown/broken job is marked 'error' and never wedges the loop.

The runner opens market.sqlite directly (its own plain connection — it must NOT import app.db,
which would boot the backend). Here we hand it an equivalent temp DB.

Run:  python -m pytest backend/tests/test_sidecar_runner.py -q     # needs numpy + stumpy
"""
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import analytics  # noqa: E402
from sidecar import runner  # noqa: E402

DAY = 86400

_DDL = """
CREATE TABLE item_meta (item_id INTEGER PRIMARY KEY, name TEXT, category TEXT);
CREATE TABLE league_daily (league TEXT, item_id INTEGER, day TEXT, close REAL, average REAL,
                           volume INTEGER, PRIMARY KEY(league,item_id,day));
CREATE TABLE analytics_cache (kind TEXT, key TEXT, computed_at INTEGER, value_json TEXT,
                              PRIMARY KEY(kind,key));
CREATE TABLE analytics_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, params_json TEXT
                             DEFAULT '{}', state TEXT DEFAULT 'queued', enqueued_at INTEGER,
                             started_at INTEGER, finished_at INTEGER, error TEXT);
"""


def _market_db():
    c = sqlite3.connect(":memory:")
    c.executescript(_DDL)
    c.execute("INSERT INTO item_meta VALUES(1,'Divine Orb','currency')")
    # 30 calm liquid days + a recent volume-confirmed price anomaly at day 27.
    from datetime import datetime, timezone
    rows = []
    for i in range(30):
        close = 10.0 + (0.2 if i % 2 else -0.2)
        vol = 30_000
        if i == 27:
            close, vol = 30.0, 300_000
        day = datetime.fromtimestamp(1_700_000_000 + i * DAY, timezone.utc).strftime("%Y-%m-%d")
        rows.append(("Std", 1, day, close, close, vol))
    c.executemany("INSERT INTO league_daily VALUES(?,?,?,?,?,?)", rows)
    c.commit()
    return c


def test_run_once_computes_discords_into_cache():
    c = _market_db()
    analytics.enqueue(c, "discords", {"league": "Std"}); c.commit()
    did = runner.run_once(c)
    assert did is True
    # discords caches ONE blob under a fixed key with the league carried inside the value.
    blob = analytics.read_cache(c, "discords", "current")
    assert blob["league"] == "Std"
    sigs = blob["signals"]
    assert isinstance(sigs, list) and len(sigs) == 1
    assert sigs[0]["item_id"] == 1 and sigs[0]["vol_z"] >= 3.0
    # job marked done
    st = c.execute("SELECT state FROM analytics_jobs ORDER BY id DESC LIMIT 1").fetchone()[0]
    assert st == "done"


def test_run_once_computes_arc_weights_into_cache():
    c = _market_db()
    # give a second, differently-shaped league so DTW has a field to weight over.
    from datetime import datetime, timezone
    rows = []
    for i in range(20):
        close = 8.0 + 0.5 * i                              # a steadily-rising league
        day = datetime.fromtimestamp(1_600_000_000 + i * DAY, timezone.utc).strftime("%Y-%m-%d")
        rows.append(("Old", 291, day, close, close, 100))
    # the current league ("Std") needs its own Divine (item 291) arc to compare.
    for i in range(12):
        close = 10.0 + 0.4 * i
        day = datetime.fromtimestamp(1_700_000_000 + i * DAY, timezone.utc).strftime("%Y-%m-%d")
        rows.append(("Std", 291, day, close, close, 100))
    c.executemany("INSERT INTO league_daily VALUES(?,?,?,?,?,?)", rows)
    c.commit()
    analytics.enqueue(c, "arc", {"league": "Std"}); c.commit()
    assert runner.run_once(c) is True
    blob = analytics.read_cache(c, "arc", "current")
    assert blob["league"] == "Std"
    assert blob["weights"].get("Old") is not None          # weighted the one past league
    assert blob["resembles"] == "Old"
    st = c.execute("SELECT state FROM analytics_jobs ORDER BY id DESC LIMIT 1").fetchone()[0]
    assert st == "done"


def test_run_once_returns_false_when_idle():
    c = _market_db()
    assert runner.run_once(c) is False


def test_unknown_kind_is_marked_error_not_fatal():
    c = _market_db()
    analytics.enqueue(c, "no-such-kind", {}); c.commit()
    did = runner.run_once(c)
    assert did is True
    row = c.execute("SELECT state, error FROM analytics_jobs ORDER BY id DESC LIMIT 1").fetchone()
    assert row[0] == "error" and row[1]


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
