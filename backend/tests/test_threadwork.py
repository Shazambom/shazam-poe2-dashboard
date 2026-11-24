"""Cancellation and error propagation for shielded worker operations."""

from __future__ import annotations

import asyncio
import logging
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import digest, threadwork


def test_finish_write_returns_result_and_propagates_errors_without_cancel():
    def succeed(x: int) -> int:
        return x + 1

    def fail() -> None:
        raise RuntimeError("boom")

    assert asyncio.run(threadwork.finish_write(succeed, 41)) == 42
    with pytest.raises(RuntimeError, match="boom"):
        asyncio.run(threadwork.finish_write(fail))


def test_finish_write_waits_for_successful_worker_then_raises_cancelled():
    started, release, finished = (
        threading.Event(),
        threading.Event(),
        threading.Event(),
    )

    def slow_ok() -> int:
        started.set()
        assert release.wait(5)
        finished.set()
        return 7

    async def go() -> asyncio.Task[int]:
        task = asyncio.create_task(threadwork.finish_write(slow_ok))
        try:
            assert await asyncio.to_thread(started.wait, 2)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        return task

    task = asyncio.run(go())
    assert finished.is_set()
    assert task.cancelled()


def test_finish_write_preserves_cancellation_when_worker_fails(caplog):
    started, release = threading.Event(), threading.Event()

    def slow_fail() -> None:
        started.set()
        assert release.wait(5)
        raise RuntimeError("database is locked")

    async def go() -> tuple[asyncio.Task[None], BaseException | None]:
        task = asyncio.create_task(threadwork.finish_write(slow_fail))
        try:
            assert await asyncio.to_thread(started.wait, 2)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
        finally:
            release.set()
        caught: BaseException | None = None
        try:
            await task
        except BaseException as exc:
            caught = exc
        return task, caught

    with caplog.at_level(logging.WARNING, logger="app.threadwork"):
        task, caught = asyncio.run(go())

    assert task.cancelled()
    assert isinstance(caught, asyncio.CancelledError)
    assert isinstance(caught.__cause__, RuntimeError)
    assert "database is locked" in str(caught.__cause__)
    assert any(
        "database is locked" in r.getMessage() or r.exc_info for r in caplog.records
    )


def test_digest_run_forever_exits_on_one_cancel_when_shielded_write_fails(monkeypatch):
    started, release = threading.Event(), threading.Event()
    calls = 0

    async def sync_once() -> None:
        return None

    def failing_maintain(_stored: bool) -> int:
        nonlocal calls
        calls += 1
        started.set()
        assert release.wait(5)
        raise RuntimeError("database is locked")

    monkeypatch.setattr(digest, "sync_once", sync_once)
    monkeypatch.setattr(digest, "_maintain", failing_maintain)
    monkeypatch.setattr(digest, "DIGEST_POLL_SECONDS", 0.05)

    async def go() -> tuple[asyncio.Task[None], BaseException | None]:
        task = asyncio.create_task(digest.run_forever())
        try:
            assert await asyncio.to_thread(started.wait, 2)
            task.cancel()
            await asyncio.sleep(0)
        finally:
            release.set()
        results = await asyncio.wait_for(
            asyncio.gather(task, return_exceptions=True), 2
        )
        return task, results[0]

    task, outcome = asyncio.run(go())
    assert task.cancelled()
    assert isinstance(outcome, asyncio.CancelledError)
    assert calls == 1
