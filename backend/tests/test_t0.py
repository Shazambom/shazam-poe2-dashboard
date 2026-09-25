"""T0 blockers: a full-sync fallback on a client is detected by the client itself, named as a
T0 event over beta telemetry, and classified on the server without anyone reading logs
(docs/bugs/2026-09-25-windows-seed-never-applied.md; owner: "You should be able to auto detect it
and classify it as a T0 blocker critical error").

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_t0.py -q
"""
import gzip
import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import db, devtelemetry, digest, leaguehistory  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def lines(monkeypatch):
    out = []
    monkeypatch.setattr(devtelemetry, "tlog", lambda tag, msg: out.append((tag, msg)))
    return out


# ------------------------------------------------------------------ the event
def test_t0_is_one_greppable_line_with_a_kind(lines):
    devtelemetry.t0("seed-failed", "OSError: EBADF")
    assert lines == [("T0", "seed-failed: OSError: EBADF")]
    assert devtelemetry.T0_KINDS >= {"seed-failed", "unseeded", "seed-unreadable", "digest-cold", "league-full-crawl", "mods-empty"}


# ------------------------------------------------------------------ the seed step
def _market(path: Path, version: int | None) -> None:
    c = sqlite3.connect(str(path))
    c.executescript(db.MARKET_SCHEMA)
    if version is not None:
        c.execute("INSERT OR REPLACE INTO market_meta(key, value) VALUES('snapshot_version', ?)", (str(version),))
    c.commit(); c.close()


def _seed(d: Path, version: int) -> None:
    raw = d / "seed.sqlite"; _market(raw, version)
    with open(raw, "rb") as fi, gzip.open(d / "market-seed.sqlite.gz", "wb") as fo:
        fo.write(fi.read())
    (d / "market-seed.sqlite.gz.version").write_text(str(version)); raw.unlink()


@pytest.fixture
def env(tmp_path, monkeypatch):
    market = tmp_path / "market.sqlite"
    monkeypatch.setattr(db, "MARKET_DB_PATH", market)
    monkeypatch.setattr(db, "MARKET_SEED_PATH", tmp_path / "market-seed.sqlite.gz")
    return tmp_path, market


def test_a_failed_seed_is_a_t0(env, lines, monkeypatch):
    d, market = env
    _market(market, 3); _seed(d, 7)
    import os
    monkeypatch.setattr(os, "fsync", lambda fd: (_ for _ in ()).throw(OSError(9, "Bad file descriptor")))
    db.seed_market()
    assert ("T0", "seed-failed: OSError: [Errno 9] Bad file descriptor; local v3 seed v7; crawling live") in lines


def test_a_bundled_seed_that_leaves_the_db_unseeded_is_a_t0(env, lines, monkeypatch):
    """The seed step says it kept the local DB, yet the local DB has no snapshot at all."""
    d, market = env
    _market(market, None)                      # a crawl-built DB: no snapshot_version row → v0
    _seed(d, 7)
    monkeypatch.setattr(db, "_seed_version", lambda: 0)   # a seed whose version reads as 0
    db.seed_market()
    assert any(t == "T0" and m.startswith("unseeded:") for t, m in lines), lines


def test_an_unreadable_bundled_seed_is_a_t0(env, lines):
    d, market = env
    (d / "market-seed.sqlite.gz").write_bytes(b"not a gzip")
    (d / "market-seed.sqlite.gz.version").write_text("garbage")
    db.seed_market()
    assert any(t == "T0" and m.startswith("seed-unreadable:") for t, m in lines), lines
    assert not market.exists() or db._read_snapshot_version(market) <= 0


def test_a_healthy_seed_raises_no_t0(env, lines):
    d, market = env
    _seed(d, 5)
    db.seed_market()
    assert db._read_snapshot_version(market) == 5
    assert not [m for t, m in lines if t == "T0"], lines


# ------------------------------------------------------------------ the crawls
def test_league_crawl_verdict_names_a_full_or_cold_crawl_and_nothing_else():
    v = leaguehistory.crawl_verdict
    # A past league is fetched once; a seeded client has it marked complete, so fetching it again is a full crawl.
    assert v(current=False, items=500, fetched=0, stored_hits=500) is None
    assert v(current=False, items=500, fetched=3, stored_hits=497) is None, "a few stragglers are not a crawl"
    assert v(current=False, items=500, fetched=120, stored_hits=380) == "league-full-crawl"
    # A current league refreshes every 12h: fetching it all with history present is the normal cadence.
    assert v(current=True, items=500, fetched=500, stored_hits=500) is None
    # A current league fetched wholesale with no history stored is a cold client: the seed did not land.
    assert v(current=True, items=500, fetched=400, stored_hits=10) == "league-full-crawl"
    assert v(current=True, items=0, fetched=0, stored_hits=0) is None


def test_digest_cold_start_with_a_seed_bundled_is_a_t0(monkeypatch, lines):
    monkeypatch.setattr(db, "kv_get", lambda key, default=None: None)
    monkeypatch.setattr(db, "kv_set", lambda key, value: None)
    monkeypatch.setattr(db, "MARKET_SEED_PATH", Path("/nonexistent-but-configured/market-seed.sqlite.gz"))
    assert digest.cold_start_reason(cursor=None, seed_bundled=True) == "digest-cold"
    assert digest.cold_start_reason(cursor=None, seed_bundled=False) is None, "a dev/server DB builds itself: not a fallback"
    assert digest.cold_start_reason(cursor=1790362800, seed_bundled=True) is None


# ------------------------------------------------------------------ the server-side classifier
def _load_scan():
    spec = importlib.util.spec_from_file_location("t0scan", ROOT / "ops" / "t0-scan.py")
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod


LOG = """===== 2026-09-25 19:24:19 from 172.25.0.3 =====
v0.3.6-beta.2 win32 frozen=True [seed]: replacing local v0 with seed v1790363310 (88 MB gz)
===== 2026-09-25 19:24:19 from 172.25.0.3 =====
v0.3.6-beta.2 win32 frozen=True [T0]: seed-failed: OSError: [Errno 9] Bad file descriptor; local v0 seed v1790363310; crawling live
===== 2026-09-25 19:24:20 from 172.25.0.3 =====
v0.3.6-beta.2 win32 frozen=True [mods]: snapshot v0 pools=0 currencies=0 meta=None
===== 2026-09-25 19:24:20 from 172.25.0.3 =====
v0.3.6-beta.2 win32 frozen=True [T0]: mods-empty: seed bundled, snapshot v0, pools=0
===== 2026-09-25 19:30:00 from 172.25.0.3 =====
v0.3.6-beta.3 win32 frozen=True [seed]: replaced: now v1790363310 (800 MB)
===== 2026-09-25 19:30:01 from 172.25.0.3 =====
v0.3.6-beta.3 win32 frozen=True [mods]: snapshot v1790363310 pools=94 currencies=16 meta=94
===== 2026-09-25 19:23:00 from 172.25.0.3 =====
v0.3.6-beta.1 win32 frozen=True [seed]: FAILED (OSError: [Errno 9] Bad file descriptor); crawling live
===== 2026-09-24 10:00:00 from 10.0.0.9 =====
v0.3.5 darwin frozen=True [T0]: digest-cold: cursor missing with a seed bundled
"""


def test_t0_scan_groups_events_by_version_platform_and_kind_with_times():
    scan = _load_scan()
    events = scan.parse(LOG.splitlines())
    assert [(e["version"], e["platform"], e["kind"]) for e in events] == [
        ("0.3.6-beta.2", "win32", "seed-failed"), ("0.3.6-beta.2", "win32", "mods-empty"), ("0.3.6-beta.2", "win32", "mods-empty"),
        ("0.3.6-beta.3", "win32", "ok"), ("0.3.6-beta.1", "win32", "seed-failed"), ("0.3.5", "darwin", "digest-cold")]
    assert events[4]["msg"].startswith("OSError: [Errno 9]"), "the pre-T0 failure line is the same event"
    assert events[0]["at"] == "2026-09-25 19:24:19" and events[0]["msg"].startswith("OSError")
    summary = scan.summarize(events)
    assert summary["0.3.6-beta.2"]["win32"]["seed-failed"]["count"] == 1
    assert summary["0.3.6-beta.2"]["win32"]["mods-empty"]["count"] == 2, "the explicit T0 and the [mods] pools=0 line"
    assert "0.3.6-beta.3" not in summary, "a healthy startup is not a blocker"
    assert summary["0.3.6-beta.2"]["win32"]["seed-failed"]["last"] == "2026-09-25 19:24:19"
    assert set(summary["0.3.6-beta.2"]["win32"]) == {"seed-failed", "mods-empty"}


def test_t0_scan_blocks_a_stable_release_whose_beta_line_has_a_t0():
    scan = _load_scan()
    events = scan.parse(LOG.splitlines())
    assert scan.blockers(events, "0.3.6") == [("0.3.6-beta.2", "win32", "seed-failed"), ("0.3.6-beta.2", "win32", "mods-empty"), ("0.3.6-beta.1", "win32", "seed-failed")]
    assert scan.blockers(events, "0.3.6", since="2026-09-25 19:25:00") == [], "only events after the cut-off count (a fixed beta clears the line)"
    assert scan.blockers(events, "0.3.7") == []
    assert scan.blockers(events, "0.3.5") == [("0.3.5", "darwin", "digest-cold")]
    # Silence is not validation: the line needs a healthy client since the cut-off.
    assert scan.validated(events, "0.3.6", since="2026-09-25 19:25:00") == [("0.3.6-beta.3", "win32", "2026-09-25 19:30:01")]
    assert scan.validated(events, "0.3.6", since="2026-09-25 19:31:00") == []
    assert scan.validated(events, "0.3.7") == []
