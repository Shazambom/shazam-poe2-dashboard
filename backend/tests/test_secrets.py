"""Concurrency and serialization checks for encrypted secret storage."""

from __future__ import annotations

import sys
import threading
from contextlib import contextmanager
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import db, migrations_user, oauth, secrets, session


@pytest.fixture
def isolated_secrets(monkeypatch, tmp_path):
    monkeypatch.setattr(db, "MARKET_DB_PATH", tmp_path / "market.sqlite")
    monkeypatch.setattr(db, "USER_DB_PATH", tmp_path / "user.sqlite")
    monkeypatch.setattr(db, "MARKET_SEED_PATH", None)
    monkeypatch.setattr(migrations_user, "DB_PATH", tmp_path / "legacy.sqlite")
    monkeypatch.setattr(db, "_local", threading.local())
    monkeypatch.setattr(db, "_tx_gen", db.tx_gen())
    db._boot_databases()
    monkeypatch.setattr(secrets, "KEY_PATH", tmp_path / "secret.key")
    monkeypatch.setattr(secrets, "_fernet_cache", None)


def test_secret_load_does_not_queue_behind_stalled_mark_ok(
    isolated_secrets, monkeypatch
):
    secrets.store("poesessid", {"cookie": "abc", "last_ok": 1.0})

    holding_write_lock = threading.Event()
    release_write_lock = threading.Event()
    mark_ok_at_tx = threading.Event()
    load_done = threading.Event()
    loaded: list[dict | None] = []
    errors: list[BaseException] = []

    orig_tx = db.tx

    @contextmanager
    def signalling_tx():
        mark_ok_at_tx.set()
        with orig_tx() as conn:
            yield conn

    monkeypatch.setattr(db, "tx", signalling_tx)

    def hold_db_write() -> None:
        with db._write_lock:
            holding_write_lock.set()
            assert release_write_lock.wait(5)

    def run_mark_ok() -> None:
        try:
            session.mark_ok()
        except BaseException as exc:
            errors.append(exc)

    def run_load() -> None:
        try:
            loaded.append(secrets.load("poesessid"))
        except BaseException as exc:
            errors.append(exc)
        finally:
            load_done.set()

    t_holder = threading.Thread(target=hold_db_write)
    t_writer = threading.Thread(target=run_mark_ok)
    t_reader = threading.Thread(target=run_load)

    t_holder.start()
    try:
        assert holding_write_lock.wait(2)
        t_writer.start()
        assert mark_ok_at_tx.wait(2)
        t_reader.start()
        completed_while_locked = load_done.wait(0.1)
    finally:
        release_write_lock.set()
        t_holder.join(5)
        if t_writer.ident is not None:
            t_writer.join(5)
        if t_reader.ident is not None:
            t_reader.join(5)

    assert errors == []
    assert completed_while_locked, (
        "secrets.load stalled behind session.mark_ok waiting on db._write_lock"
    )
    assert loaded == [{"cookie": "abc", "last_ok": 1.0}]
    updated = secrets.load("poesessid")
    assert updated is not None
    assert updated["last_ok"] > 1.0


def test_concurrent_secret_updates_do_not_lose_updates(isolated_secrets):
    assert not hasattr(secrets, "write_lock")
    update = getattr(secrets, "update", None)
    assert callable(update)
    secrets.store("rmw", {"a": 0, "b": 0})

    in_first = threading.Event()
    second_started = threading.Event()
    release = threading.Event()
    errors: list[BaseException] = []

    def first() -> None:
        try:

            def apply_a(rec: dict | None) -> dict:
                in_first.set()
                assert release.wait(5)
                return {**(rec or {}), "a": 1}

            update("rmw", apply_a)
        except BaseException as exc:
            errors.append(exc)

    def second() -> None:
        try:
            second_started.set()
            update("rmw", lambda rec: {**(rec or {}), "b": 2})
        except BaseException as exc:
            errors.append(exc)

    t1 = threading.Thread(target=first)
    t2 = threading.Thread(target=second)
    t1.start()
    try:
        assert in_first.wait(2)
        t2.start()
        assert second_started.wait(2)
        t2.join(0.05)
        assert t2.is_alive()
    finally:
        release.set()
        t1.join(5)
        if t2.ident is not None:
            t2.join(5)

    assert errors == []
    assert secrets.load("rmw") == {"a": 1, "b": 2}


def test_oauth_save_preserves_refresh_token_across_refresh(isolated_secrets):
    initial, renewed, refresh_val = "fixture-1", "fixture-2", "fixture-r1"
    oauth._save(
        {
            "access_token": initial,
            "refresh_token": refresh_val,
            "expires_in": 3600,
            "username": "exile",
        }
    )
    first = secrets.load("oauth")
    assert first is not None
    oauth._save({"access_token": renewed, "expires_in": 3600, "username": "exile"})
    second = secrets.load("oauth")
    assert second is not None
    assert (second["access_token"], second["refresh_token"]) == (renewed, refresh_val)
    assert second["refresh_expires_at"] == first["refresh_expires_at"]
