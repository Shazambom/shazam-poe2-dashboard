"""Batch 2 — data correctness (audit F-02, F-03, F-10, F-12).

  * db.kv_update(key, fn, default): read → pure transform → write inside ONE write transaction,
    so concurrent updaters never lose each other's changes.
  * GET /api/signals never writes (pruning moved to the ack path).
  * get_settings() is read-only; the one-time liquidity-floor bake is user migration #3.
  * The legacy split (m1) renames poe2arb.sqlite only AFTER its transaction commits, and a
    fresh-install stamp refuses to mark split_done while a .premigration backup exists.
  * analytics.* helpers never commit the caller's connection (except claim, which owns its
    BEGIN IMMEDIATE); callers own the transaction.
  * user.sqlite runs synchronous=FULL; market.sqlite stays NORMAL.

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_data_correctness.py -q
"""
import json
import sqlite3
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import analytics, db, migrations_user, settings, signalsack  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)


# ----------------------------------------------------------------- kv_update
def test_kv_update_applies_transform_and_returns_new_value():
    db.kv_set("signals_ack", {})
    out = db.kv_update("signals_ack", lambda a: {**a, "k": 1}, {})
    assert out == {"k": 1}
    assert db.kv_get("signals_ack") == {"k": 1}
    # default is used when the key is absent
    db.kv_update("lh_current", lambda v: v + ["X"], [])
    assert db.kv_get("lh_current") == ["X"]


def test_kv_update_is_atomic_under_concurrent_updaters():
    db.kv_set("signals_ack", {})
    n = 40

    def worker(i):
        db.kv_update("signals_ack", lambda a: {**a, f"k{i}": i}, {})

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(db.kv_get("signals_ack")) == n


def test_kv_update_rolls_back_when_transform_raises():
    db.kv_set("signals_ack", {"a": 1})

    def boom(_):
        raise RuntimeError("nope")

    with pytest.raises(RuntimeError):
        db.kv_update("signals_ack", boom, {})
    assert db.kv_get("signals_ack") == {"a": 1}


# ----------------------------------------------------------------- signals GET never writes
def test_signals_get_does_not_write_ack_blob():
    stale = {"item:0": 1}                      # no such signal is fired → would be pruned
    db.kv_set("signals_ack", stale)
    r = client.get("/api/signals")
    assert r.status_code == 200
    assert db.kv_get("signals_ack") == stale   # untouched by a read
    r = client.post("/api/signals/ack", json={"keys": ["x:1"]})
    assert r.status_code == 200
    assert db.kv_get("signals_ack") == {}      # the WRITE path prunes (no signals fired)


# ----------------------------------------------------------------- settings read-only + m3
def test_get_settings_does_not_write():
    db.kv_set("settings", {"filters": {"min_liquidity_ref": 0}})
    before = db.kv_get("settings")
    settings.get_settings()
    assert db.kv_get("settings") == before
    db.kv_set("settings", {})


def _user_conn(tmp_path):
    c = sqlite3.connect(str(tmp_path / "u.sqlite"))
    c.executescript(db.USER_SCHEMA)
    return c


def test_m3_bakes_liquidity_floor_once(tmp_path):
    c = _user_conn(tmp_path)
    c.execute("INSERT INTO kv(key, value) VALUES('settings', ?)",
              (json.dumps({"filters": {"min_liquidity_ref": 0, "min_volume_ref_per_h": 5, "sort": "x"}}),))
    migrations_user._m3_liq_floor(c)
    s = json.loads(c.execute("SELECT value FROM kv WHERE key='settings'").fetchone()[0])
    assert s["filters"] == {"min_liquidity_ref": 50.0, "min_volume_ref_per_h": 100.0, "sort": "x"}
    assert s["_liq_floor_v1"] is True
    # idempotent + the user's later lowering sticks
    s["filters"]["min_liquidity_ref"] = 1.0
    c.execute("UPDATE kv SET value=? WHERE key='settings'", (json.dumps(s),))
    migrations_user._m3_liq_floor(c)
    assert json.loads(c.execute("SELECT value FROM kv WHERE key='settings'").fetchone()[0])["filters"]["min_liquidity_ref"] == 1.0


def test_m3_noop_without_settings_row(tmp_path):
    c = _user_conn(tmp_path)
    migrations_user._m3_liq_floor(c)
    assert c.execute("SELECT COUNT(*) FROM kv").fetchone()[0] == 0


def test_m3_is_registered():
    assert [m[0] for m in migrations_user.USER_MIGRATIONS][:3] == [1, 2, 3]


# ----------------------------------------------------------------- m1 rename after commit
def _legacy(path):
    c = sqlite3.connect(str(path))
    c.executescript(db.USER_SCHEMA)
    c.execute("INSERT INTO capital(currency, qty) VALUES('chaos', 5)")
    c.execute("INSERT INTO kv(key, value) VALUES('settings', '{}')")
    c.commit()
    c.close()


class _FailOnceCommit:
    """Wraps a connection so the migration's commit raises (simulates disk-full / crash at commit).
    The runner commits once for the pre-migration backup, so the failure is armed on the 2nd."""
    def __init__(self, conn, fail_at=2):
        self._c = conn
        self.calls = 0
        self.fail_at = fail_at

    def commit(self):
        self.calls += 1
        if self.calls == self.fail_at:
            raise sqlite3.OperationalError("simulated commit failure")
        return self._c.commit()

    def __getattr__(self, name):
        return getattr(self._c, name)


def test_m1_leaves_legacy_in_place_when_commit_fails(tmp_path, monkeypatch):
    legacy = tmp_path / "poe2arb.sqlite"
    _legacy(legacy)
    monkeypatch.setattr(migrations_user, "DB_PATH", legacy)
    monkeypatch.setattr(db, "USER_DB_PATH", tmp_path / "user.sqlite")
    raw = _user_conn(tmp_path)
    conn = _FailOnceCommit(raw)
    with pytest.raises(sqlite3.OperationalError):
        db._run_user_migrations(conn)
    assert legacy.exists(), "legacy DB must not be renamed before the lift is committed"
    assert not (tmp_path / "poe2arb.sqlite.premigration").exists()
    assert raw.execute("SELECT COUNT(*) FROM capital").fetchone()[0] == 0
    # second boot: the lift succeeds and only then is the file renamed
    db._run_user_migrations(raw)
    assert raw.execute("SELECT qty FROM capital WHERE currency='chaos'").fetchone()[0] == 5
    assert not legacy.exists() and (tmp_path / "poe2arb.sqlite.premigration").exists()


def test_m1_fresh_install_refuses_to_stamp_over_a_premigration_backup(tmp_path, monkeypatch):
    legacy = tmp_path / "poe2arb.sqlite"
    _legacy(tmp_path / "poe2arb.sqlite.premigration")   # backup exists, live file gone: a half-run
    monkeypatch.setattr(migrations_user, "DB_PATH", legacy)
    c = _user_conn(tmp_path)
    with pytest.raises(RuntimeError):
        migrations_user._m1_split_from_legacy(c)
    assert c.execute("SELECT COUNT(*) FROM user_meta WHERE key='split_done'").fetchone()[0] == 0


# ----------------------------------------------------------------- analytics helpers are commit-free
def _market_conn(tmp_path):
    p = tmp_path / "m.sqlite"
    c = sqlite3.connect(str(p), isolation_level=None)   # autocommit off via explicit BEGIN below
    c.executescript(db.MARKET_SCHEMA)
    c.close()
    a = sqlite3.connect(str(p), timeout=5)
    b = sqlite3.connect(str(p), timeout=5)
    a.execute("PRAGMA journal_mode=WAL")
    return a, b


def test_analytics_helpers_do_not_commit_callers_connection(tmp_path):
    a, b = _market_conn(tmp_path)
    analytics.enqueue(a, "discords", {"league": "L"})
    assert b.execute("SELECT COUNT(*) FROM analytics_jobs").fetchone()[0] == 0, "enqueue committed"
    a.commit()
    assert b.execute("SELECT COUNT(*) FROM analytics_jobs").fetchone()[0] == 1
    job = analytics.claim(a)                              # claim owns its own transaction
    assert b.execute("SELECT state FROM analytics_jobs").fetchone()[0] == "running"
    analytics.complete(a, job["id"], "discords", "current", {"x": 1})
    assert b.execute("SELECT COUNT(*) FROM analytics_cache").fetchone()[0] == 0, "complete committed"
    a.commit()
    assert b.execute("SELECT state FROM analytics_jobs").fetchone()[0] == "done"
    analytics.fail(a, job["id"], "e")
    assert b.execute("SELECT state FROM analytics_jobs").fetchone()[0] == "done", "fail committed"
    a.rollback()
    analytics.requeue_stale(a, older_than_s=0)
    analytics.prune_jobs(a, keep=0)
    assert b.execute("SELECT COUNT(*) FROM analytics_jobs").fetchone()[0] == 1, "prune committed"
    a.commit()
    assert b.execute("SELECT COUNT(*) FROM analytics_jobs").fetchone()[0] == 0


def test_backend_has_no_private_conn_callers_outside_db():
    root = Path(__file__).resolve().parents[1] / "app"
    hits = [p.name for p in root.glob("*.py") if p.name != "db.py" and "db._conn()" in p.read_text()]
    assert hits == []


# ----------------------------------------------------------------- durability pragmas
def test_user_db_is_synchronous_full_and_market_normal():
    c = db._conn()
    assert c.execute("PRAGMA main.synchronous").fetchone()[0] == 2      # FULL
    assert c.execute("PRAGMA market.synchronous").fetchone()[0] == 1    # NORMAL


def test_m6_raises_the_saved_liquidity_floor_to_200_once(tmp_path):
    """Owner mandate 2026-09-17: loops need real liquidity — the floor goes 50 -> 200 ex, and it
    must reach installs whose SAVED filter still says 50 (a new default alone never would)."""
    c = _user_conn(tmp_path)
    c.execute("INSERT INTO kv(key, value) VALUES('settings', ?)",
              (json.dumps({"_liq_floor_v1": True, "filters": {"min_liquidity_ref": 50.0, "min_volume_ref_per_h": 100.0}}),))
    migrations_user._m6_liq_floor_200(c)
    s = json.loads(c.execute("SELECT value FROM kv WHERE key='settings'").fetchone()[0])
    assert s["filters"] == {"min_liquidity_ref": 200.0, "min_volume_ref_per_h": 100.0}
    assert s["_liq_floor_v2"] is True
    # idempotent; a user who later chooses another value keeps it; a HIGHER saved floor is never lowered
    s["filters"]["min_liquidity_ref"] = 120.0
    c.execute("UPDATE kv SET value=? WHERE key='settings'", (json.dumps(s),))
    migrations_user._m6_liq_floor_200(c)
    assert json.loads(c.execute("SELECT value FROM kv WHERE key='settings'").fetchone()[0])["filters"]["min_liquidity_ref"] == 120.0


def test_m6_keeps_a_higher_floor_and_is_registered(tmp_path):
    c = _user_conn(tmp_path)
    c.execute("INSERT INTO kv(key, value) VALUES('settings', ?)", (json.dumps({"filters": {"min_liquidity_ref": 900}}),))
    migrations_user._m6_liq_floor_200(c)
    assert json.loads(c.execute("SELECT value FROM kv WHERE key='settings'").fetchone()[0])["filters"]["min_liquidity_ref"] == 900
    assert (6, migrations_user._m6_liq_floor_200) in [(n, fn) for n, _, fn in migrations_user.USER_MIGRATIONS]


def test_liquidity_floor_default_is_200():
    from app import arbitrage, settings
    assert settings.DEFAULTS["filters"]["min_liquidity_ref"] == 200.0
    assert arbitrage.RECOMMENDED_MIN_LIQUIDITY_REF == 200.0
