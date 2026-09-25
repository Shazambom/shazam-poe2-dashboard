"""Persistence contract — the user/market split, seeding, and the legacy lift.

Pins the rules in docs/db-architecture.md + docs/db-maintenance.md so a refactor of db.py /
migrations_user.py can't silently drift:
  * kv routing: user keys land in user.sqlite.kv, everything else in market.sqlite.kv_ops,
    `secret:` keys are always user.
  * seed_market: seeds when no local market DB, replaces when the seed is newer, keeps the
    local file when it is at least as new.
  * _m1_split_from_legacy: lifts capital + user kv only (never operational kv), renames the
    legacy file to .premigration.

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_db_split.py -q
"""
import gzip
import os
import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import db, migrations_user  # noqa: E402


# ----------------------------------------------------------------- kv routing
USER_KEYS = ["settings", "watches", "oauth_pending", "meta_overrides", "trading_workspace",
             "signals_ack", "secret:poesessid", "secret:oauth"]
OPS_KEYS = ["lh_current", "meta_bridge", "digest_cursor", "trade_leagues", "lh_fetch:Standard"]


@pytest.mark.parametrize("key", USER_KEYS)
def test_user_keys_route_to_user_kv(key):
    assert db._is_user_kv(key)
    assert db._kv_table(key) == "kv"


@pytest.mark.parametrize("key", OPS_KEYS)
def test_operational_keys_route_to_kv_ops(key):
    assert not db._is_user_kv(key)
    assert db._kv_table(key) == "kv_ops"


def test_kv_roundtrip_lands_in_the_right_file():
    db.kv_set("settings", {"a": 1})
    db.kv_set("lh_current", ["X"])
    with db.q() as c:
        assert c.execute("SELECT value FROM main.kv WHERE key='settings'").fetchone()[0] == '{"a": 1}'
        assert c.execute("SELECT value FROM market.kv_ops WHERE key='lh_current'").fetchone()[0] == '["X"]'
        assert c.execute("SELECT COUNT(*) FROM main.kv WHERE key='lh_current'").fetchone()[0] == 0
        assert c.execute("SELECT COUNT(*) FROM market.kv_ops WHERE key='settings'").fetchone()[0] == 0


# ----------------------------------------------------------------- seeding
def _make_market(path: Path, version: int) -> None:
    c = sqlite3.connect(str(path))
    c.executescript(db.MARKET_SCHEMA)
    c.execute("INSERT OR REPLACE INTO market_meta(key, value) VALUES('snapshot_version', ?)", (str(version),))
    c.commit()
    c.close()


def _make_seed(dirpath: Path, version: int) -> Path:
    raw = dirpath / "seed.sqlite"
    _make_market(raw, version)
    gz = dirpath / "market-seed.sqlite.gz"
    with open(raw, "rb") as fi, gzip.open(gz, "wb") as fo:
        fo.write(fi.read())
    (dirpath / "market-seed.sqlite.gz.version").write_text(str(version))
    raw.unlink()
    return gz


@pytest.fixture
def seed_env(tmp_path, monkeypatch):
    market = tmp_path / "market.sqlite"
    monkeypatch.setattr(db, "MARKET_DB_PATH", market)
    monkeypatch.setattr(db, "MARKET_SEED_PATH", tmp_path / "market-seed.sqlite.gz")
    return tmp_path, market


def test_seed_market_seeds_when_no_local_db(seed_env):
    d, market = seed_env
    _make_seed(d, 5)
    db.seed_market()
    assert db._read_snapshot_version(market) == 5


def test_seed_market_replaces_older_local(seed_env):
    d, market = seed_env
    _make_market(market, 3)
    _make_seed(d, 7)
    db.seed_market()
    assert db._read_snapshot_version(market) == 7


def test_seed_market_keeps_newer_or_equal_local(seed_env):
    d, market = seed_env
    _make_market(market, 9)
    _make_seed(d, 9)
    db.seed_market()
    assert db._read_snapshot_version(market) == 9
    _make_seed(d, 4)
    db.seed_market()
    assert db._read_snapshot_version(market) == 9


def test_seed_market_noop_without_seed(seed_env):
    d, market = seed_env
    db.seed_market()
    assert not market.exists()


# ----------------------------------------------------------------- legacy lift (m1)
def _legacy_db(path: Path) -> None:
    c = sqlite3.connect(str(path))
    c.executescript(db.USER_SCHEMA)
    c.execute("INSERT INTO capital(currency, qty) VALUES('chaos', 12.5), ('divine', 3)")
    for k, v in [("settings", {"league": "L"}), ("secret:poesessid", {"cookie": "x"}),
                 ("lh_current", ["L"]), ("meta_bridge", {"a": "b"})]:
        c.execute("INSERT INTO kv(key, value) VALUES(?, ?)", (k, json.dumps(v)))
    c.commit()
    c.close()


@pytest.fixture
def user_conn(tmp_path):
    c = sqlite3.connect(str(tmp_path / "user.sqlite"))
    c.executescript(db.USER_SCHEMA)
    c.commit()
    yield c
    c.close()


def test_m1_lifts_user_rows_only_and_renames_legacy(tmp_path, monkeypatch, user_conn):
    legacy = tmp_path / "poe2arb.sqlite"
    _legacy_db(legacy)
    monkeypatch.setattr(migrations_user, "DB_PATH", legacy)
    after = migrations_user._m1_split_from_legacy(user_conn)
    user_conn.commit()
    after()                                   # the runner calls this post-commit hook
    keys = {r[0] for r in user_conn.execute("SELECT key FROM kv")}
    assert keys == {"settings", "secret:poesessid"}
    caps = dict(user_conn.execute("SELECT currency, qty FROM capital").fetchall())
    assert caps == {"chaos": 12.5, "divine": 3}
    assert user_conn.execute("SELECT value FROM user_meta WHERE key='split_done'").fetchone()[0] == "1"
    assert not legacy.exists()
    assert (tmp_path / "poe2arb.sqlite.premigration").exists()


def test_m1_fresh_install_marks_done_without_legacy(tmp_path, monkeypatch, user_conn):
    monkeypatch.setattr(migrations_user, "DB_PATH", tmp_path / "poe2arb.sqlite")
    migrations_user._m1_split_from_legacy(user_conn)
    assert user_conn.execute("SELECT value FROM user_meta WHERE key='split_done'").fetchone()[0] == "1"


def test_m1_is_idempotent(tmp_path, monkeypatch, user_conn):
    legacy = tmp_path / "poe2arb.sqlite"
    _legacy_db(legacy)
    monkeypatch.setattr(migrations_user, "DB_PATH", legacy)
    migrations_user._m1_split_from_legacy(user_conn)()
    _legacy_db(legacy)   # a legacy file reappears — must NOT be re-lifted
    user_conn.execute("UPDATE capital SET qty=99 WHERE currency='chaos'")
    migrations_user._m1_split_from_legacy(user_conn)
    assert user_conn.execute("SELECT qty FROM capital WHERE currency='chaos'").fetchone()[0] == 99


# ----------------------------------------------------------------- m2 watches → workspace
def test_m2_derives_workspace_once(user_conn):
    folders = [{"id": 1, "title": "F", "searches": [{"id": 7, "title": "S", "type": "search", "slug": "abc", "live": True}]}]
    user_conn.execute("INSERT INTO kv(key, value) VALUES('watches', ?)", (json.dumps(folders),))
    migrations_user._m2_watches_to_workspace(user_conn)
    ws = json.loads(user_conn.execute("SELECT value FROM kv WHERE key='trading_workspace'").fetchone()[0])
    assert ws["version"] == 2
    assert ws["tree"][0]["children"][0]["slug"] == "abc"
    user_conn.execute("UPDATE kv SET value='{\"version\":2,\"tree\":[]}' WHERE key='trading_workspace'")
    migrations_user._m2_watches_to_workspace(user_conn)   # idempotent: does not overwrite
    ws2 = json.loads(user_conn.execute("SELECT value FROM kv WHERE key='trading_workspace'").fetchone()[0])
    assert ws2["tree"] == []


def test_seed_market_syncs_through_the_write_handle(seed_env, monkeypatch):
    """Windows rejects os.fsync on a read-only handle (EBADF), which left every Windows install
    unseeded until beta telemetry showed it (2026-09-25). The seed must be synced through the
    handle it was written with."""
    import fcntl
    d, market = seed_env
    _make_seed(d, 9)
    modes = []
    real = os.fsync
    def spy(fd):
        modes.append(fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE)
        real(fd)
    monkeypatch.setattr(os, "fsync", spy)
    db.seed_market()
    assert db._read_snapshot_version(market) == 9
    assert modes and all(m != os.O_RDONLY for m in modes), modes
