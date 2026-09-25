"""Reproduction of docs/bugs/2026-09-25-windows-seed-never-applied.md.

On Windows `os.fsync` rejects a handle opened read-only (EBADF). `db.seed_market` used to copy the
seed, reopen the copy read-only and fsync it, so on Windows every seed attempt failed and the
client fell back to a live crawl with no mod tables. POSIX allows the read-only fsync, so the
Mac never saw it. These tests run the seed step under a Windows-like fsync on any platform.

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_seed_windows.py -q
"""
import errno
import fcntl
import gzip
import os
import shutil
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import db  # noqa: E402


def _make_market(path: Path, version: int) -> None:
    c = sqlite3.connect(str(path))
    c.executescript(db.MARKET_SCHEMA)
    c.execute("INSERT OR REPLACE INTO market_meta(key, value) VALUES('snapshot_version', ?)", (str(version),))
    c.execute("INSERT INTO mod_pools(id, name, class, domain, keywords, data) VALUES('ring','Rings','Rings','item','[]','{}')")
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


def _windows_fsync(real):
    """What Windows does: sync a writable handle, refuse a read-only one with EBADF."""
    def fsync(fd):
        if fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE == os.O_RDONLY:
            raise OSError(errno.EBADF, "Bad file descriptor")
        real(fd)
    return fsync


@pytest.fixture
def env(tmp_path, monkeypatch):
    market = tmp_path / "market.sqlite"
    monkeypatch.setattr(db, "MARKET_DB_PATH", market)
    monkeypatch.setattr(db, "MARKET_SEED_PATH", tmp_path / "market-seed.sqlite.gz")
    monkeypatch.setattr(os, "fsync", _windows_fsync(os.fsync))
    lines = []
    monkeypatch.setattr(db.devtelemetry, "tlog", lambda tag, msg: lines.append(f"[{tag}] {msg}"))
    return tmp_path, market, lines


def _legacy_seed_copy(seed_gz: Path, tmp: Path) -> None:
    """The seed copy as it was before the fix (copy, then reopen read-only to fsync)."""
    with gzip.open(seed_gz, "rb") as fi, open(tmp, "wb") as fo:
        shutil.copyfileobj(fi, fo, length=1 << 20)
    with open(tmp, "rb") as f:
        os.fsync(f.fileno())


def test_the_old_copy_fails_on_windows_like_fsync(env):
    d, market, _ = env
    seed = _make_seed(d, 5)
    with pytest.raises(OSError) as exc:
        _legacy_seed_copy(seed, d / "market.sqlite.tmp")
    assert exc.value.errno == errno.EBADF, "the reproduction: EBADF from fsync on a read-only handle"


def test_a_fresh_install_seeds_under_windows_like_fsync_and_reports_it(env):
    d, market, lines = env
    _make_seed(d, 5)
    db.seed_market()
    assert db._read_snapshot_version(market) == 5
    c = sqlite3.connect(str(market))
    assert c.execute("SELECT count(*) FROM mod_pools").fetchone()[0] == 1, "the seed's mod tables arrive with it"
    c.close()
    assert any(l.startswith("[seed] replacing local v-1 with seed v5") for l in lines), lines
    assert any(l.startswith("[seed] replaced: now v5") for l in lines), lines
    assert not (d / "market.sqlite.tmp").exists()


def test_an_unseeded_crawl_built_db_is_replaced_under_windows_like_fsync(env):
    """The Windows client's state: a local DB with no snapshot version (v0) and no mod tables."""
    d, market, lines = env
    c = sqlite3.connect(str(market))
    c.executescript(db.MARKET_SCHEMA)
    c.commit(); c.close()
    assert db._read_snapshot_version(market) == 0
    _make_seed(d, 1790363310)
    db.seed_market()
    assert db._read_snapshot_version(market) == 1790363310
    c = sqlite3.connect(str(market))
    assert c.execute("SELECT count(*) FROM mod_pools").fetchone()[0] == 1
    c.close()
    assert any("replacing local v0 with seed v1790363310" in l for l in lines), lines


def test_a_failed_seed_keeps_the_old_db_and_reports_the_failure(env, monkeypatch):
    d, market, lines = env
    _make_market(market, 3)
    _make_seed(d, 7)
    def broken(fd):
        raise OSError(errno.EIO, "disk says no")
    monkeypatch.setattr(os, "fsync", broken)
    db.seed_market()
    assert db._read_snapshot_version(market) == 3, "the previous DB survives a failed seed"
    assert not (d / "market.sqlite.tmp").exists(), "no half-written temp file is left behind"
    assert any(l.startswith("[seed] FAILED (OSError:") and "crawling live" in l for l in lines), lines


def test_a_newer_local_db_is_kept_and_says_so(env):
    d, market, lines = env
    _make_market(market, 9)
    _make_seed(d, 7)
    db.seed_market()
    assert db._read_snapshot_version(market) == 9
    assert any(l == "[seed] kept local v9 (seed v7)" for l in lines), lines
