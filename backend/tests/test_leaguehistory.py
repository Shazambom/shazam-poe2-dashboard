"""The league-history crawl decides up front which items it will fetch, so the loading orb counts
fetch candidates only: a seeded client that skips a whole league shows nothing to do, not
"crawling 500/500" of bookkeeping (docs/bugs/2026-09-25-windows-seed-never-applied.md).

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_leaguehistory.py -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import leaguehistory as lh  # noqa: E402

NOW = 1_790_000_000.0


def _plan(**kw):
    args = dict(item_ids=[1, 2, 3, 4], current=False, force=False, stored=set(), complete=set(), fetched_at={}, now=NOW)
    args.update(kw)
    return lh.plan_league(**args)


def test_a_past_league_fetches_only_what_is_not_marked_complete():
    todo, tally = _plan(complete={1, 2})
    assert todo == [3, 4]
    assert tally == {"complete": 2, "fresh": 0}


def test_a_current_league_skips_items_stored_and_fetched_within_the_refresh_window():
    todo, tally = _plan(current=True, stored={1, 2, 3}, fetched_at={1: NOW - 60, 2: NOW - lh.REFRESH_S - 1})
    assert todo == [2, 3, 4], "2 is stale, 3 was never fetched here, 4 is not stored"
    assert tally == {"complete": 0, "fresh": 1}


def test_a_current_league_ignores_complete_marks_and_a_past_league_ignores_freshness():
    assert _plan(current=True, complete={1, 2, 3, 4})[0] == [1, 2, 3, 4], "a league still running is never final"
    assert _plan(current=False, stored={1, 2, 3, 4}, fetched_at={i: NOW for i in range(1, 5)})[0] == [1, 2, 3, 4]


def test_force_fetches_everything_and_keeps_the_order():
    todo, tally = _plan(item_ids=[4, 1, 3], force=True, complete={1, 3, 4})
    assert todo == [4, 1, 3] and tally == {"complete": 0, "fresh": 0}


def test_marks_read_a_league_bookkeeping_in_one_pass():
    from app import db
    db.kv_set("lh_complete:MarksTest:7", True)
    db.kv_set("lh_complete:MarksTest:8", False)
    db.kv_set("lh_fetch:MarksTest:7", 123.0)
    db.kv_set("lh_complete:MarksOther:7", True)
    complete, fetched_at = lh._marks("MarksTest")
    assert complete == {7} and fetched_at == {7: 123.0}


def test_every_fetch_is_a_heartbeat_so_a_league_with_nothing_to_do_never_reads_as_stalled(monkeypatch):
    """Between leagues the crawl only fetches item universes (no per-item ticks any more); the
    orb's stall rule (no tick for 30 s) must see those fetches."""
    import asyncio
    from app import gateway

    class R:
        def raise_for_status(self): pass
        def json(self): return {"ok": True}

    async def fake(*a, **k): return R()
    monkeypatch.setattr(gateway, "request", fake)
    lh.progress["updated"] = NOW - 999
    monkeypatch.setattr(lh.time, "time", lambda: NOW)
    assert asyncio.run(lh._get("/x")) == {"ok": True}
    assert lh.progress["updated"] == NOW


def test_the_orb_calls_a_crawl_stalled_only_past_the_longest_rate_wait(monkeypatch):
    """poe2scout allows 20 requests a minute: a league's universe fetch can wait 40 s for the
    next slot with nothing to tick. That is not a stalled crawl."""
    from app import main
    lh.progress.update({"running": True, "phase": "crawling", "updated": NOW - 45, "league_total": 0, "league_done": 0})
    monkeypatch.setattr(main.time, "time", lambda: NOW)
    assert main.backfill_status()["phase"] == "crawling"
    lh.progress["updated"] = NOW - main.STALL_S - 1
    assert main.backfill_status()["phase"] == "stalled"
