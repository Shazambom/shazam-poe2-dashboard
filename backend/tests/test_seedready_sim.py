"""End-to-end simulation of the seed poll against a fake poe2scout over real HTTP
(docs/bugs/2026-09-28-partial-sync-data.md). Every scenario the bug and its fix plan name: a crawl that
ran before the day closed, poe2scout stalling, thin items, items under the price floor, pagination,
errors, revised days, a league ending, a restart, and the request budget (poll slowly, never spam).

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_seedready_sim.py -q
"""
import asyncio
import sys
import uuid
from pathlib import Path

import pytest
from pyrate_limiter import Duration, Rate

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
sys.path.insert(0, str(Path(__file__).resolve().parent))
from app import db, gateway, leaguehistory as lh, seedready as sr  # noqa: E402
from fake_poe2scout import FakeScout  # noqa: E402

D1, D2, D3, D4, D5 = "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"


@pytest.fixture
def scout(monkeypatch):
    with FakeScout(today=D4) as s:
        monkeypatch.setattr(lh, "BASE", s.base)
        monkeypatch.setitem(gateway.POLICIES, "poe2scout", gateway.Policy("poe2scout", [Rate(10_000, Duration.SECOND)], ()))
        monkeypatch.setattr(lh, "ITEMS", {})            # no hard-wired anchors in a simulated league
        yield s


def run(coro):
    async def go():
        try:
            return await coro
        finally:
            if gateway._client is not None:
                await gateway._client.aclose()
                gateway._client = None
    return asyncio.run(go())


def league(scout, n=4, cat="currency", price=10.0):
    """A current league whose n items traded D1..D3 (final) and have part of D4 posted."""
    name = f"Sim {uuid.uuid4().hex[:8]}"
    scout.league(name)
    for i in range(1, n + 1):
        scout.item(name, i, cat=cat, price=price)
        for d in (D1, D2, D3):
            scout.day(name, i, d, 10.0 + i, 100 * i)
        scout.day(name, i, D4, 10.0 + i, 7 * i)        # the unfinished day
    return name


def crawl():
    return run(lh.backfill(force=True))


def poll():
    return run(sr.poll())


def cut(name):
    return (db.kv_get(f"seed_cut:{name}") or {}).get("day")


def fresh_log(scout):
    scout.log.clear()


# ---------------------------------------------------------------- the ordinary day

def test_a_crawl_after_the_day_closed_ships_it_with_no_extra_fetches(scout):
    name = league(scout)
    crawl()
    fresh_log(scout)
    res = poll()
    assert cut(name) == D3
    assert scout.count("history") == 0, "every row already matched poe2scout"
    assert res[name]["fetched"] == 0


def test_a_crawl_before_the_day_closed_is_topped_up_once_then_ships_it(scout):
    name = league(scout)
    scout.today = D3
    for i in range(1, 5):                                # the crawl sees D3 half-traded, no D4
        scout.drop_day(name, i, D4)
        scout.day(name, i, D3, 10.0 + i, 40 * i)
    crawl()
    scout.today = D4                                     # D3 closes, D4 starts
    for i in range(1, 5):
        scout.day(name, i, D3, 10.0 + i, 100 * i)
        scout.day(name, i, D4, 10.0 + i, 7 * i)
    fresh_log(scout)
    poll()
    assert cut(name) == D3
    assert scout.count("history") == 4, "only the four items whose D3 changed"
    fresh_log(scout)
    poll()
    assert scout.count("history") == 0, "the next hour fetches nothing"


# ---------------------------------------------------------------- poe2scout stalls

def test_a_stalled_day_is_never_shipped_and_waiting_costs_no_item_fetches(scout):
    name = league(scout)
    crawl()
    scout.today = D5                                     # our clock moves on; poe2scout does not
    fresh_log(scout)
    for _ in range(3):                                   # three hourly polls during the stall
        poll()
    assert cut(name) == D3, "D4 is stuck part-way: poe2scout has not moved past it"
    assert scout.count("history") == 0
    assert scout.count("listing") == 3, "one listing page per poll for a one-category league"

    for i in range(1, 5):                                # poe2scout catches up
        scout.day(name, i, D4, 10.0 + i, 100 * i)
        scout.day(name, i, D5, 10.0 + i, 3 * i)
    fresh_log(scout)
    poll()
    assert cut(name) == D4
    assert scout.count("history") == 4


def test_poe2scout_part_way_through_posting_a_day_has_not_finished_the_one_before(scout):
    name = league(scout, n=6)
    crawl()
    scout.today = D5
    for i in (1, 2):                                     # 2 of 6 items have D5 already
        scout.day(name, i, D5, 1.0, 1)
    poll()
    assert cut(name) == D3


# ---------------------------------------------------------------- thin, frozen and sticky items

def test_an_item_that_did_not_trade_on_the_newest_day_does_not_block_it(scout):
    name = league(scout, n=5)
    scout.drop_day(name, 5, D3)
    scout.drop_day(name, 5, D4)
    crawl()
    fresh_log(scout)
    poll()
    assert cut(name) == D3 and scout.count("history") == 0


def test_an_item_that_fell_under_the_price_floor_keeps_being_crawled(scout):
    name = league(scout, n=4)
    crawl()
    scout.item(name, 4, price=0.5)                       # spot price drops under 5 ex
    scout.day(name, 4, D4, 0.5, 900)
    fresh_log(scout)
    crawl()
    assert any("/Items/4/" in p for p in scout.log), "a tracked item stays in the crawl below the floor"


def test_an_untracked_cheap_item_is_neither_crawled_nor_fetched_by_the_poll(scout):
    name = league(scout, n=3)
    scout.item(name, 9, price=0.2)
    for d in (D1, D2, D3, D4):
        scout.day(name, 9, d, 0.2, 5)
    crawl()
    poll()
    assert not any("/Items/9/" in p for p in scout.log)
    assert cut(name) == D3


def test_a_frozen_item_from_before_the_fix_is_topped_up_by_the_poll(scout):
    name = league(scout, n=3)
    crawl()
    with db.tx() as c:                                   # an old client/server: item 3 froze after D1
        c.execute("DELETE FROM league_daily WHERE league=? AND item_id=3 AND day>?", (name, D1))
    fresh_log(scout)
    poll()
    assert cut(name) == D3
    assert scout.count("history") == 1


# ---------------------------------------------------------------- pagination

def test_a_category_bigger_than_one_page_is_read_in_full(scout):
    scout.page_size = 2
    name = league(scout, n=5)
    crawl()
    assert all(any(f"/Items/{i}/" in p for p in scout.log) for i in range(1, 6)), "the crawl follows Pages"
    with db.tx() as c:
        c.execute("UPDATE league_daily SET volume=volume+1 WHERE league=? AND item_id=5 AND day=?", (name, D3))
    fresh_log(scout)
    poll()
    assert scout.count("listing") == 3 and scout.count("history") == 1, "item 5 is on page 3"
    assert cut(name) == D3


# ---------------------------------------------------------------- errors

def test_a_failed_listing_page_leaves_the_league_alone(scout):
    name = league(scout)
    crawl()
    poll()
    assert cut(name) == D3
    with db.tx() as c:
        c.execute("UPDATE league_daily SET volume=1 WHERE league=? AND day=?", (name, D3))
    scout.fail["ByCategory"] = [500]
    fresh_log(scout)
    res = poll()
    assert res[name]["error"]
    assert scout.count("history") == 0, "no fetches from a half-read listing"
    assert cut(name) == D3, "the last verified cut stands"


def test_a_failed_item_fetch_is_retried_next_hour_and_holds_the_cut(scout):
    name = league(scout)
    scout.today = D3
    for i in range(1, 5):
        scout.drop_day(name, i, D4)
        scout.day(name, i, D3, 10.0 + i, 40 * i)
    crawl()
    scout.today = D4
    for i in range(1, 5):
        scout.day(name, i, D3, 10.0 + i, 100 * i)
        scout.day(name, i, D4, 10.0 + i, 7 * i)
    scout.fail["/Items/2/"] = [500]
    poll()
    assert cut(name) == D2, "item 2's D3 is not final yet"
    fresh_log(scout)
    poll()
    assert cut(name) == D3
    assert scout.count("history") == 1, "only item 2 is retried"


def test_a_rate_limited_fetch_backs_off_and_still_completes(scout):
    name = league(scout)
    crawl()
    with db.tx() as c:
        c.execute("UPDATE league_daily SET volume=1 WHERE league=? AND item_id=1 AND day=?", (name, D3))
    scout.fail["/Items/1/"] = [429]
    poll()
    assert cut(name) == D3


# ---------------------------------------------------------------- revisions and disagreements

def test_poe2scout_revising_an_old_day_pulls_the_cut_back_until_refetched(scout):
    name = league(scout)
    crawl()
    poll()
    scout.day(name, 3, D1, 13.0, 999)                    # poe2scout revises D1 for item 3
    fresh_log(scout)
    res = poll()
    assert res[name]["revised"] == [3], "a change to a finished day is reported, not just repaired"
    assert scout.count("history") == 1
    assert cut(name) == D3


def test_an_item_whose_history_never_matches_its_listing_is_fetched_once(scout, monkeypatch):
    name = league(scout)
    crawl()
    real = scout._route

    def skewed(path):                                    # item 2's history always disagrees
        status, body = real(path)
        if "/Items/2/DailyStatsHistory" in path:
            for s in body["DailyStats"]:
                s["Volume"] += 1
        return status, body
    monkeypatch.setattr(scout, "_route", skewed)
    crawl()
    fresh_log(scout)
    poll()
    assert scout.count("history") == 1 and cut(name) == D3
    for i in range(1, 5):                                # the unfinished day keeps trading
        scout.day(name, i, D4, 10.0 + i, 9 * i)
    fresh_log(scout)
    poll()
    assert scout.count("history") == 0, "not fetched again while poe2scout's finished days are unchanged"


def test_a_row_poe2scout_withdraws_is_removed_not_shipped(scout):
    name = league(scout)
    crawl()
    scout.drop_day(name, 2, D2)                          # poe2scout withdraws item 2's D2
    poll()
    with db.q() as c:
        assert c.execute("SELECT COUNT(*) FROM league_daily WHERE league=? AND item_id=2 AND day=?", (name, D2)).fetchone()[0] == 0
    assert cut(name) == D3


# ---------------------------------------------------------------- leagues coming and going

def test_a_league_that_ended_is_not_polled(scout):
    name = league(scout)
    crawl()
    scout.league(name, current=False)
    fresh_log(scout)
    res = poll()
    assert name not in res
    assert not any(name.replace(" ", "%20") in p for p in scout.log)


def test_a_brand_new_league_ships_no_day_until_poe2scout_finishes_one(scout):
    name = f"Sim {uuid.uuid4().hex[:8]}"
    scout.league(name)
    scout.item(name, 1)
    scout.day(name, 1, D4, 10.0, 5)
    crawl()
    poll()
    assert db.kv_get(f"seed_cut:{name}") is not None and cut(name) is None


# ---------------------------------------------------------------- restarts and budget

def test_a_restart_between_polls_repeats_no_work(scout):
    name = league(scout)
    scout.today = D3
    for i in range(1, 5):
        scout.drop_day(name, i, D4)
    crawl()
    scout.today = D4
    for i in range(1, 5):
        scout.day(name, i, D3, 10.0 + i, 101 * i)
        scout.day(name, i, D4, 10.0 + i, 7 * i)
    poll()                                               # each poll is its own event loop and client
    fresh_log(scout)
    poll()
    assert scout.count("history") == 0 and cut(name) == D3


def test_a_poll_costs_the_listing_plus_only_the_items_holding_the_seed_back(scout):
    name = league(scout, n=12)
    crawl()
    with db.tx() as c:
        c.execute("UPDATE league_daily SET volume=1 WHERE league=? AND item_id IN (3, 7) AND day=?", (name, D3))
    fresh_log(scout)
    poll()
    assert scout.count("history") == 2
    assert scout.count("listing") + scout.count("categories") + scout.count("leagues") <= 3


# ---------------------------------------------------------------- code review 2026-09-29

def test_an_empty_refetch_is_not_final_and_is_not_fetched_again(scout, monkeypatch):
    name = league(scout)
    crawl()
    with db.tx() as c:
        c.execute("UPDATE league_daily SET volume=1 WHERE league=? AND item_id=2 AND day=?", (name, D3))
    real = scout._route

    def empty(path):
        status, body = real(path)
        if "/Items/2/DailyStatsHistory" in path:
            body["DailyStats"] = []
        return status, body
    monkeypatch.setattr(scout, "_route", empty)
    poll()
    assert cut(name) == D2, "item 2's D3 is still partial: not shippable"
    fresh_log(scout)
    poll()
    assert scout.count("history") == 0, "not re-fetched while poe2scout is unchanged"
    monkeypatch.setattr(scout, "_route", real)
    scout.day(name, 2, D3, 12.0, 201)                    # poe2scout changes it: worth a fetch again
    poll()
    assert cut(name) == D3


def test_an_item_poe2scout_no_longer_has_is_confirmed_gone_not_retried_forever(scout):
    name = league(scout)
    crawl()
    del scout.leagues[name]["items"][4]                  # delisted: no listing entry, history 404s
    poll()
    assert cut(name) == D3
    fresh_log(scout)
    poll()
    assert scout.count("history") == 0


def test_a_failed_fetch_never_pulls_the_cut_back(scout):
    """A transient failure would otherwise drop up to a week of days for every item in the seed."""
    name = league(scout)
    crawl()
    poll()
    assert cut(name) == D3
    scout.day(name, 3, D1, 13.0, 999)                    # a revision makes item 3 stale...
    scout.fail["/Items/3/"] = [500]                      # ...and its refetch fails this hour
    res = poll()
    assert res[name]["failed"] == 1 and cut(name) == D3
    poll()                                               # next hour it succeeds
    assert cut(name) == D3 and not (db.kv_get(f"seed_cut:{name}") or {}).get("stale")


def test_an_empty_listing_keeps_the_last_cut(scout, monkeypatch):
    """poe2scout answering 200 with nothing (an outage) must not wipe a league from the seed."""
    name = league(scout)
    crawl()
    poll()
    real = scout._route

    def hollow(path):
        status, body = real(path)
        if path.endswith("/Items/Categories"):
            body = {"CurrencyCategories": []}
        return status, body
    monkeypatch.setattr(scout, "_route", hollow)
    res = poll()
    assert res[name]["error"] and cut(name) == D3


def test_the_poll_records_which_leagues_it_covered_and_when(scout):
    name = league(scout)
    crawl()
    poll()
    rec = db.kv_get("seed_poll")
    assert name in rec["leagues"] and rec["at"] > 0


def test_the_quick_anchor_pull_stays_quick(scout, monkeypatch):
    name = league(scout, n=4)
    crawl()
    scout.today = D5
    fresh_log(scout)
    run(lh.backfill(force=True, full=False))
    assert scout.count("history") == 0, "full=False fetches the named anchors only (none here)"
