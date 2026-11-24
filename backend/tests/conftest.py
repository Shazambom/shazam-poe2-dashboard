"""Shared pytest fixtures for backend tests.

Event-loop SQLite guard: catches production code calling into SQLite (via `db._conn()`,
which backs `db.tx`, `db.q` and every `db.*` helper) directly on a running asyncio event
loop, while allowing worker threads and direct test-body DB setup inside `async def` tests.

Known limits:
- Memoized readers (e.g. `get_settings()`, `gamedata.fees()`) skip `db._conn()` on a warm
  cache hit, so a regression is only caught when a test exercises a cold read on the loop.
- Untyped `Path` / filesystem I/O does not go through `db._conn()` and is not covered here.
"""

from __future__ import annotations

import asyncio
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import db

BACKEND_DIR = Path(__file__).resolve().parents[1]
APP_DIR = (BACKEND_DIR / "app").resolve()
DB_FILE = (APP_DIR / "db.py").resolve()
_APP_FILE_CACHE: dict[str, bool] = {}


def _is_production_caller(filename: str) -> bool:
    cached = _APP_FILE_CACHE.get(filename)
    if cached is not None:
        return cached
    try:
        resolved = Path(filename).resolve()
        inside = resolved != DB_FILE and resolved.is_relative_to(APP_DIR)
    except OSError:
        inside = False
    _APP_FILE_CACHE[filename] = inside
    return inside


def _find_production_frame() -> str | None:
    frame = sys._getframe(2)
    while frame is not None:
        filename = frame.f_code.co_filename
        if _is_production_caller(filename):
            rel = Path(filename).resolve().relative_to(BACKEND_DIR)
            return f"{rel}:{frame.f_lineno} in {frame.f_code.co_name}()"
        frame = frame.f_back
    return None


@pytest.fixture(autouse=True)
def forbid_production_sqlite_on_event_loop(monkeypatch):
    orig_conn = db._conn

    def guarded_conn() -> sqlite3.Connection:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return orig_conn()
        caller = _find_production_frame()
        if caller is not None:
            raise AssertionError(
                f"blocking SQLite call on the running event loop from {caller}"
            )
        return orig_conn()

    monkeypatch.setattr(db, "_conn", guarded_conn)
