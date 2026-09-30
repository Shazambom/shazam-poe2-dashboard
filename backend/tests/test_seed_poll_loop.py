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


def test_the_next_poll_is_at_five_past_the_hour_before_the_17_past_publish():
    """A fixed minute, not an hour after the last poll ended: that drifted a minute an hour until the
    :17 publisher read an answer almost an hour old (2026-09-29)."""
    hour = 1790694000  # 2026-09-29 15:00:00 UTC
    assert main.seconds_to_next_poll(hour) == 5 * 60
    assert main.seconds_to_next_poll(hour + 2 * 60 + 30) == 2 * 60 + 30
    assert main.seconds_to_next_poll(hour + 5 * 60) == 3600          # just polled: wait the full hour
    assert main.seconds_to_next_poll(hour + 7 * 60 + 12) == 3600 - 2 * 60 - 12
    assert main.seconds_to_next_poll(hour + 27 * 60) == 38 * 60


def test_the_loop_polls_then_waits_for_the_next_slot_and_survives_a_failed_poll(monkeypatch):
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
    monkeypatch.setattr(main.time, "time", lambda: 1790694000 + 27 * 60)   # a poll that ended at :27
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main._seed_poll_loop())
    assert calls == [1, 1] and sleeps == [38 * 60, 38 * 60]


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


@pytest.mark.parametrize("outcome", [{"error": "ConnectError: poe2scout unreachable"}, RuntimeError("boom")])
def test_a_failed_crawl_retries_in_30_minutes_not_12_hours(monkeypatch, outcome):
    """An app started before the network is up kept stale current-league data for 12 hours of awake
    time (audit 2026-09-29, S1). Owner: retry about every 30 minutes, never more often."""
    from app import leaguehistory
    sleeps = []

    async def fake_backfill():
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    async def fake_sleep(s):
        sleeps.append(s)
        raise asyncio.CancelledError
    monkeypatch.setattr(leaguehistory, "backfill", fake_backfill)
    monkeypatch.setattr(main.asyncio, "sleep", fake_sleep)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main._league_history_loop())
    assert sleeps == [30 * 60]


@pytest.mark.parametrize("res,wait", [
    ({"fetched": {}, "leagues": 5, "errors": 40, "attempted": 40}, 30 * 60),   # every item fetch failed
    ({"fetched": {"L/1": 3}, "leagues": 5, "errors": 2, "attempted": 40}, 12 * 3600),   # a few blips
    ({"fetched": {}, "leagues": 5, "errors": 0, "attempted": 0}, 12 * 3600),   # nothing was due
])
def test_a_crawl_whose_every_fetch_failed_retries_in_30_minutes(monkeypatch, res, wait):
    """/Leagues answered but poe2scout's history endpoint failed every item (network dropped, 5xx):
    the same stale-for-12-hours symptom as a failed /Leagues (code review 2026-09-29)."""
    from app import leaguehistory
    sleeps = []

    async def fake_backfill():
        return res

    async def fake_sleep(s):
        sleeps.append(s)
        raise asyncio.CancelledError
    monkeypatch.setattr(leaguehistory, "backfill", fake_backfill)
    monkeypatch.setattr(main.asyncio, "sleep", fake_sleep)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main._league_history_loop())
    assert sleeps == [wait]


def test_the_server_compose_turns_it_on():
    assert 'ARBITER_SEED_POLL: "1"' in (ROOT / "docker-compose.yml").read_text()
