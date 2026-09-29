"""The seed poll runs hourly on the server that publishes the seed and nowhere else: a desktop app
never sets ARBITER_SEED_POLL (the desktop contract: its only outbound calls are updates and beta
telemetry; its own crawl is enough). docs/bugs/2026-09-28-partial-sync-data.md.

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_seed_poll_loop.py -q
"""
import asyncio
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app import main, seedready  # noqa: E402


def test_it_is_off_unless_the_server_turns_it_on(monkeypatch):
    monkeypatch.delenv("ARBITER_SEED_POLL", raising=False)
    assert not main.seed_poll_enabled()
    monkeypatch.setenv("ARBITER_SEED_POLL", "1")
    assert main.seed_poll_enabled()


def test_the_loop_polls_then_waits_an_hour_and_survives_a_failed_poll(monkeypatch):
    calls, sleeps = [], []

    async def fake_poll():
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("poe2scout down")
        return {}

    async def fake_sleep(s):
        sleeps.append(s)
        if len(sleeps) == 2:
            raise asyncio.CancelledError
    monkeypatch.setattr(seedready, "poll", fake_poll)
    monkeypatch.setattr(main.asyncio, "sleep", fake_sleep)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main._seed_poll_loop())
    assert calls == [1, 1] and sleeps == [3600, 3600]


def test_a_crawl_skipped_for_the_seed_poll_retries_soon_not_in_12_hours(monkeypatch):
    """The poll and the crawl share one lock; a crawl that finds it held must not lose its turn."""
    from app import leaguehistory
    results, sleeps = [{"skipped": "backfill already running"}, {"fetched": {}}], []

    async def fake_backfill():
        return results.pop(0)

    async def fake_sleep(s):
        sleeps.append(s)
        if len(sleeps) == 2:
            raise asyncio.CancelledError
    monkeypatch.setattr(leaguehistory, "backfill", fake_backfill)
    monkeypatch.setattr(main.asyncio, "sleep", fake_sleep)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main._league_history_loop())
    assert sleeps[0] <= 300 and sleeps[1] == 12 * 3600


def test_the_server_compose_turns_it_on():
    assert 'ARBITER_SEED_POLL: "1"' in (ROOT / "docker-compose.yml").read_text()
