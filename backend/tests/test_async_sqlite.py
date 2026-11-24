"""Transaction checks for async callers of the synchronous SQLite helpers."""

import asyncio
import json
import sqlite3
import sys
import threading
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import (
    catalog,
    currencies,
    db,
    devtelemetry,
    diag,
    digest,
    gamedata,
    gateway,
    leaguehistory,
    main,
    migrations_user,
    modpool,
    oauth,
    orderbook,
    seedready,
    session,
    sidecar_supervisor,
)

LEAGUE = "Async Transactions"
ITEM = 1299
FIRST_DAY = "2026-09-01"
SECOND_DAY = "2026-09-02"
THIRD_DAY = "2026-09-03"


@pytest.fixture
def rollback_write(monkeypatch, tmp_path):
    monkeypatch.setattr(db, "MARKET_DB_PATH", tmp_path / "market.sqlite")
    monkeypatch.setattr(db, "USER_DB_PATH", tmp_path / "user.sqlite")
    monkeypatch.setattr(db, "MARKET_SEED_PATH", None)
    monkeypatch.setattr(migrations_user, "DB_PATH", tmp_path / "legacy.sqlite")
    monkeypatch.setattr(db, "_local", threading.local())
    monkeypatch.setattr(db, "_tx_gen", db.tx_gen())
    db._boot_databases()
    transaction = db.tx

    @contextmanager
    def reject_commit():
        with transaction() as conn:
            yield conn
            assert conn.in_transaction
            raise sqlite3.OperationalError("abort the transaction under test")

    def check(operation):
        before = db.tx_gen()
        with monkeypatch.context() as patch:
            patch.setattr(db, "tx", reject_commit)
            with pytest.raises(sqlite3.OperationalError, match="abort the transaction"):
                asyncio.run(operation())
        assert db.tx_gen() == before

    return check


def _mock_response(monkeypatch, payload):
    async def request(*_args, **_kwargs):
        return httpx.Response(
            200,
            json=payload,
            request=httpx.Request("GET", "http://127.0.0.1/fixture"),
        )

    monkeypatch.setattr(gateway, "request", request)


def test_catalog_keeps_the_previous_snapshot_on_a_failed_write(rollback_write):
    static = {"result": [{"entries": [{"id": "trial", "text": "Trial Orb"}]}]}
    db.kv_set(currencies.STATIC_CACHE_KEY, static)
    db.kv_set(catalog.KEY, {"Old": {"id": "old"}})

    async def refresh():
        return await catalog.refresh(
            {"Meta/Test": {"name": "Trial Orb"}}, metas=["Meta/Test"], categories={}
        )

    rollback_write(refresh)
    assert db.kv_get(catalog.KEY) == {"Old": {"id": "old"}}
    assert asyncio.run(refresh()) is None
    assert db.kv_get(catalog.KEY) == {"Meta/Test": {"id": "trial"}}


def test_static_registry_cache_write_commits_or_keeps_old_data(
    monkeypatch, rollback_write
):
    payload = {"result": [{"entries": [{"id": "trial", "text": "Trial Orb"}]}]}
    _mock_response(monkeypatch, payload)
    registry = currencies.Registry()
    old = {"result": []}
    db.kv_set(currencies.STATIC_CACHE_KEY, old)
    rollback_write(registry.load_static)
    assert db.kv_get(currencies.STATIC_CACHE_KEY) == old
    assert asyncio.run(registry.load_static()) is True
    saved = db.kv_get(currencies.STATIC_CACHE_KEY)
    assert saved["result"][0]["entries"] == payload["result"][0]["entries"]


def test_digest_cursor_update_rolls_back_without_advancing_the_watermark(
    monkeypatch, rollback_write
):
    monkeypatch.setattr(digest, "state", dict(digest.state))

    async def fetch(cursor):
        return {"markets": [], "next_change_id": 7200 if cursor == 3600 else cursor}

    monkeypatch.setattr(digest, "_fetch", fetch)
    db.kv_set("digest_cursor", 3600)
    rollback_write(digest.sync_once)
    assert db.kv_get("digest_cursor") == 3600
    asyncio.run(digest.sync_once())
    assert db.kv_get("digest_cursor") == 7200
    assert digest.state["last_hour"] == 7200


def test_gold_fee_refresh_keeps_the_previous_cache_on_a_failed_write(
    monkeypatch, rollback_write
):
    monkeypatch.setattr(gamedata, "state", dict(gamedata.state))
    _mock_response(monkeypatch, {"version": "test"})
    columns = [
        {"name": "Item", "type": "row"},
        {"name": "Category", "type": "row"},
        {"name": "SubCategory", "type": "row"},
        {"name": "GoldPurchaseFee", "type": "i32"},
        {"name": "EnabledInStandardLeague", "type": "bool"},
        {"name": "EnabledInChallengeLeague", "type": "bool"},
    ]
    schema = {
        "tables": [
            {"name": "CurrencyExchange", "validFor": 2, "columns": columns},
            {
                "name": "CurrencyExchangeCategories",
                "validFor": 3,
                "columns": [{"name": "Name", "type": "string"}],
            },
        ]
    }

    async def get(_url, name, _max_age):
        return (
            json.dumps(schema).encode() if name == "schema.min.json" else name.encode()
        )

    class FixtureDat:
        def __init__(self, name):
            self.name = name
            self.count = 1
            self.row_width = 54

        def row(self, _index):
            return self.name

    def read(_dat, row, _offset, kind):
        if kind == "string":
            return "Meta/Test" if row == b"baseitemtypes.datc64" else "Currency"
        if kind == "i32":
            return 8
        if kind == "bool":
            return True
        return 0

    monkeypatch.setattr(gamedata, "_get", get)
    monkeypatch.setattr(gamedata, "Dat", FixtureDat)
    monkeypatch.setattr(gamedata, "read", read)
    db.kv_set("gold_fees_meta", {"Old": {"fee": 5}})
    rollback_write(gamedata.refresh)
    assert db.kv_get("gold_fees_meta") == {"Old": {"fee": 5}}
    asyncio.run(gamedata.refresh())
    assert db.kv_get("gold_fees_meta")["Meta/Test"] == {
        "fee": 8,
        "category": "Currency",
        "subcategory": "Currency",
        "standard": True,
        "challenge": True,
    }


def test_universe_item_metadata_inserts_have_one_transaction(
    monkeypatch, rollback_write
):
    async def categories(_league):
        return ["Currency"]

    async def listed(_league, _category):
        return [{"ItemId": ITEM, "Text": "Trial Orb", "CurrentPrice": 1_000_000}]

    def item_names():
        with db.q() as conn:
            return [
                row[0]
                for row in conn.execute(
                    "SELECT name FROM item_meta WHERE item_id=?", (ITEM,)
                )
            ]

    monkeypatch.setattr(leaguehistory, "_category_apiids", categories)
    monkeypatch.setattr(leaguehistory, "category_items", listed)

    async def collect():
        return await leaguehistory._universe(LEAGUE)

    rollback_write(collect)
    assert item_names() == []
    assert ITEM in asyncio.run(collect())
    assert item_names() == ["Trial Orb"]


def test_item_fetch_keeps_withdrawn_days_and_stamps_on_rollback(
    monkeypatch, rollback_write
):
    async def get(_path):
        return {
            "DailyStats": [
                {"Time": FIRST_DAY, "Close": 3, "Average": 3, "Volume": 10},
                {"Time": THIRD_DAY, "Close": 5, "Average": 5, "Volume": 13},
            ]
        }

    monkeypatch.setattr(leaguehistory, "_get", get)
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO league_daily VALUES (?, ?, ?, 1, 1, 5)",
            (LEAGUE, ITEM, SECOND_DAY),
        )

    def days():
        with db.q() as conn:
            return [
                row[0]
                for row in conn.execute(
                    "SELECT day FROM league_daily WHERE league=? AND item_id=? ORDER BY day",
                    (LEAGUE, ITEM),
                )
            ]

    async def fetch():
        return await leaguehistory.fetch_item(LEAGUE, ITEM, current=True)

    stamp = f"lh_fetch:{LEAGUE}:{ITEM}"
    rollback_write(fetch)
    assert days() == [SECOND_DAY]
    assert db.kv_get(stamp) is None
    assert asyncio.run(fetch()) == 2
    assert days() == [FIRST_DAY, THIRD_DAY]
    assert db.kv_get(stamp) > 0


def test_backfill_keeps_the_previous_current_league_if_the_write_fails(
    monkeypatch, rollback_write
):
    async def leagues():
        return [{"Value": LEAGUE, "IsCurrent": True}]

    monkeypatch.setattr(leaguehistory, "_leagues", leagues)
    monkeypatch.setattr(leaguehistory, "_backfill_lock", asyncio.Lock())
    monkeypatch.setattr(leaguehistory, "progress", dict(leaguehistory.progress))
    monkeypatch.setattr(leaguehistory, "ITEMS", {})
    db.kv_set("lh_current", ["Old"])

    async def backfill():
        return await leaguehistory.backfill(full=False)

    rollback_write(backfill)
    assert db.kv_get("lh_current") == ["Old"]
    assert asyncio.run(backfill()) == {
        "leagues": 1,
        "fetched": {},
        "attempted": 0,
        "errors": 0,
    }
    assert db.kv_get("lh_current") == [LEAGUE]


def test_diagnostics_uses_stored_current_leagues_without_writing(
    monkeypatch, rollback_write
):
    async def connectivity():
        return {"fixture": "offline"}

    monkeypatch.setattr(diag, "_connectivity", connectivity)
    monkeypatch.setattr(
        diag,
        "get_settings",
        lambda: {"league": LEAGUE, "reference": "exalted", "watchlist": []},
    )
    db.kv_set("lh_current", [LEAGUE])
    before = db.tx_gen()
    report = asyncio.run(diag.collect())
    assert report["leaguehistory_current"] == [LEAGUE]
    assert report["connectivity"] == {"fixture": "offline"}
    assert db.tx_gen() == before


def test_leagues_cache_preserves_the_prior_value_on_rollback(
    monkeypatch, rollback_write
):
    _mock_response(monkeypatch, {"result": [{"id": LEAGUE}]})
    old = {"at": 0, "leagues": [{"id": "Old"}]}
    db.kv_set("trade_leagues", old)

    async def refresh():
        return await orderbook.leagues(force=True)

    rollback_write(refresh)
    assert db.kv_get("trade_leagues") == old
    assert asyncio.run(refresh()) == [{"id": LEAGUE, "text": LEAGUE}]
    assert db.kv_get("trade_leagues")["leagues"] == [{"id": LEAGUE, "text": LEAGUE}]


def test_tablet_refresh_preserves_the_last_good_rows_if_the_write_fails(
    monkeypatch, rollback_write
):
    async def page(_slug, _max_age):
        return "<html>fixture</html>"

    rows = [{"name": None, "base": "Trial Tablet", "uses": 10}]
    monkeypatch.setattr(modpool, "_page", page)
    monkeypatch.setattr(modpool, "tablet_bases_from", lambda _listing: rows)
    monkeypatch.setattr(modpool, "tablet_unique_pages", lambda _listing: [])
    old = [{"name": None, "base": "Old Tablet", "uses": 5}]
    db.kv_set(modpool.TABLET_USES, old)

    async def refresh():
        return await modpool.refresh_tablet_uses(0)

    rollback_write(refresh)
    assert db.kv_get(modpool.TABLET_USES) == old
    assert asyncio.run(refresh()) is None
    assert db.kv_get(modpool.TABLET_USES) == rows


def test_mod_refresh_keeps_the_previous_bench_if_its_write_fails(
    monkeypatch, rollback_write
):
    async def raw(*_args):
        return b"{}"

    async def page(*_args):
        return "<html>fixture</html>"

    monkeypatch.setattr(gamedata, "_get", raw)
    monkeypatch.setattr(modpool, "state", dict(modpool.state))
    monkeypatch.setattr(modpool, "_page", page)
    monkeypatch.setattr(modpool, "currencies_from", lambda _p: [{"id": "example"}])
    monkeypatch.setattr(modpool, "grant_slugs", lambda _p: [])
    recipe = {
        "from": "Trial Orb",
        "from_qty": 3,
        "to": "Greater Trial Orb",
        "to_qty": 1,
    }
    monkeypatch.setattr(modpool, "bench_recipes_from", lambda _p: [recipe])
    monkeypatch.setattr(modpool, "tablet_bases_from", lambda _p: [])
    db.kv_set("bench_recipes", [])

    rollback_write(modpool.refresh)
    assert db.kv_get("bench_recipes") == []
    report = asyncio.run(modpool.refresh())
    assert db.kv_get("bench_recipes") == [recipe]
    assert "kept the last good tables" in report["last_error"]


def test_seed_poll_preserves_prior_cut_and_fingerprints_on_rollback(
    monkeypatch, rollback_write
):
    async def listing(_name):
        return {ITEM: {FIRST_DAY: (1, 10), SECOND_DAY: (1, 10)}}

    async def fetch(_name, _item_id, current):
        assert current
        return 1

    monkeypatch.setattr(seedready, "_listing", listing)
    monkeypatch.setattr(leaguehistory, "fetch_item", fetch)
    key = f"seed_cut:{LEAGUE}"
    mark = f"seed_fp:{LEAGUE}:{ITEM}"
    db.kv_set(key, {"day": FIRST_DAY})
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO league_daily VALUES (?, ?, ?, 2, 2, 10)",
            (LEAGUE, ITEM, FIRST_DAY),
        )
    rollback_write(lambda: seedready.poll_league(LEAGUE))
    assert db.kv_get(key) == {"day": FIRST_DAY}
    assert db.kv_get(mark) is None
    result = asyncio.run(seedready.poll_league(LEAGUE))
    assert result["fetched"] == 1
    assert db.kv_get(mark)["vouch"] is True
    assert db.kv_get(key)["day"] == result["cut"]


def test_seed_poll_records_leagues_after_the_last_poll_finishes(
    monkeypatch, rollback_write
):
    async def leagues():
        return [{"Value": LEAGUE, "IsCurrent": True}]

    async def one(league):
        return {"league": league}

    monkeypatch.setattr(leaguehistory, "_backfill_lock", asyncio.Lock())
    monkeypatch.setattr(leaguehistory, "_leagues", leagues)
    monkeypatch.setattr(seedready, "poll_league", one)
    db.kv_set("seed_poll", {"leagues": ["Old"]})
    rollback_write(seedready.poll)
    assert db.kv_get("seed_poll") == {"leagues": ["Old"]}
    assert asyncio.run(seedready.poll()) == {LEAGUE: {"league": LEAGUE}}
    assert db.kv_get("seed_poll")["leagues"] == [LEAGUE]


def test_lifespan_reports_the_mod_metadata_from_the_db(monkeypatch, rollback_write):
    reports = []

    async def idle():
        await asyncio.sleep(60)

    async def close_client():
        return None

    monkeypatch.setattr(main.registry, "load_static_cache", lambda: None)
    monkeypatch.setattr(main.registry, "keep_static_fresh", idle)
    monkeypatch.setattr(sidecar_supervisor, "start", lambda: None)
    monkeypatch.setattr(sidecar_supervisor, "stop", lambda: None)
    monkeypatch.setattr(digest, "run_forever", idle)
    monkeypatch.setattr(gateway, "aclose", close_client)
    monkeypatch.setattr(main, "_gold_fee_loop", idle)
    monkeypatch.setattr(main, "_league_history_loop", idle)
    monkeypatch.setattr(main, "_analytics_loop", idle)
    monkeypatch.setattr(main, "seed_poll_enabled", lambda: False)
    monkeypatch.setattr(devtelemetry, "enabled", lambda: True)
    monkeypatch.setattr(
        devtelemetry, "tlog", lambda tag, msg: reports.append((tag, msg))
    )
    monkeypatch.setattr(modpool, "pools", lambda: [{"id": "trial"}])
    monkeypatch.setattr(modpool, "currencies", list)
    db.kv_set("mods_meta", {"pools": 1})
    before = db.tx_gen()

    async def boot():
        async with main.lifespan(main.app):
            assert reports == [("mods", "snapshot v0 pools=1 currencies=0 meta=1")]

    asyncio.run(boot())
    assert db.tx_gen() == before


def test_install_log_preserves_one_complete_record_per_request(monkeypatch, tmp_path):
    from starlette.requests import Request

    log_path = tmp_path / "install-reports.log"
    log_path.write_text("existing\n")
    monkeypatch.setattr(main, "_INSTALL_LOG", log_path)

    async def submit(body: bytes):
        async def receive():
            return {"type": "http.request", "body": body}

        request = Request({"type": "http", "client": ("127.0.0.1", 0)}, receive)
        return await main.install_log(request)

    async def send_both():
        return await asyncio.gather(submit(b"first report"), submit(b"second report"))

    assert asyncio.run(send_both()) == [{"ok": True}, {"ok": True}]
    before, *records = log_path.read_text().split("\n===== ")
    assert before == "existing\n"
    assert len(records) == 2
    assert {record.partition(" =====\n")[2].strip() for record in records} == {
        "first report",
        "second report",
    }
    assert all("from 127.0.0.1 =====\n" in record for record in records)


def test_cancelled_seed_poll_keeps_the_crawl_lock_until_its_write_finishes(
    monkeypatch, rollback_write
):
    async def leagues():
        return [{"Value": LEAGUE, "IsCurrent": True}]

    async def one(league):
        return {"league": league}

    started, release = threading.Event(), threading.Event()
    lock = asyncio.Lock()
    commit = db.kv_set

    def blocked_commit(key, value):
        started.set()
        assert release.wait(5), "the commit blocked the event loop"
        commit(key, value)

    monkeypatch.setattr(leaguehistory, "_backfill_lock", lock)
    monkeypatch.setattr(leaguehistory, "_leagues", leagues)
    monkeypatch.setattr(seedready, "poll_league", one)
    monkeypatch.setattr(db, "kv_set", blocked_commit)

    async def stop_poll():
        task = asyncio.create_task(seedready.poll())
        try:
            assert await asyncio.to_thread(started.wait, 2)
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0)
            assert lock.locked()
            assert not task.done()
        finally:
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await task

    asyncio.run(stop_poll())
    assert not lock.locked()
    assert db.kv_get("seed_poll")["leagues"] == [LEAGUE]


@pytest.fixture
def worker_calls(monkeypatch):
    loop_thread = threading.get_ident()
    calls = []

    def record(owner, name, replacement=None):
        target = getattr(owner, name) if replacement is None else replacement

        def tracked(*args, **kwargs):
            calls.append((name, threading.get_ident()))
            return target(*args, **kwargs)

        monkeypatch.setattr(owner, name, tracked)

    def check(*names):
        assert {name for name, _ in calls} == set(names)
        assert [name for name, ident in calls if ident == loop_thread] == []

    return record, check


def test_digest_pages_and_cursor_writes_run_off_loop(monkeypatch, worker_calls):
    record, check = worker_calls
    record(digest, "_store", lambda _cursor, _markets: 1)
    record(db, "kv_set", lambda _key, _value: None)
    monkeypatch.setattr(db, "kv_get", lambda _key: 3600)

    async def fetch(_cursor):
        return {"markets": [], "next_change_id": 7200 if _cursor == 3600 else None}

    monkeypatch.setattr(digest, "_fetch", fetch)
    monkeypatch.setattr(digest, "state", dict(digest.state))
    asyncio.run(digest.sync_once())
    check("_store", "kv_set")


@pytest.mark.parametrize("fail", [False, True])
def test_digest_cursor_is_durable_before_each_next_fetch(
    monkeypatch, rollback_write, fail
):
    db.kv_set("digest_cursor", 3600)
    monkeypatch.setattr(digest, "state", dict(digest.state))
    writes, fetched = [], []
    commit = db.kv_set

    def write(key, value):
        writes.append((key, value))
        commit(key, value)

    async def fetch(cursor):
        assert await asyncio.to_thread(db.kv_get, "digest_cursor") == cursor
        fetched.append(cursor)
        if fail and cursor == 7200:
            raise RuntimeError("page two failed")
        return {
            "next_change_id": cursor + 3600 if cursor < 10800 else None,
            "markets": [{"league": LEAGUE, "market_pair": ["chaos", "divine"]}],
        }

    monkeypatch.setattr(db, "kv_set", write)
    monkeypatch.setattr(digest, "_fetch", fetch)
    if fail:
        with pytest.raises(RuntimeError, match="page two failed"):
            asyncio.run(digest.sync_once())
        assert fetched == [3600, 7200]
        assert writes == [("digest_cursor", 7200)]
        assert db.kv_get("digest_cursor") == 7200
    else:
        asyncio.run(digest.sync_once())
        assert fetched == [3600, 7200, 10800]
        assert writes == [("digest_cursor", 7200), ("digest_cursor", 10800)]
        assert db.kv_get("digest_cursor") == 10800
    with db.q() as conn:
        rows = conn.execute(
            "SELECT hour FROM digest_markets WHERE league=? ORDER BY hour", (LEAGUE,)
        )
        assert [row[0] for row in rows] == ([3600] if fail else fetched)


def test_cancelled_digest_finishes_page_and_cursor_before_releasing_writer(
    monkeypatch, rollback_write
):
    db.kv_set("digest_cursor", 3600)
    lock = asyncio.Lock()
    monkeypatch.setattr(digest, "_sync_lock", lock)
    monkeypatch.setattr(digest, "state", dict(digest.state))
    started, release = threading.Event(), threading.Event()

    async def fetch(_cursor):
        return {"next_change_id": 7200}

    def store(_cursor, _markets):
        started.set()
        assert release.wait(5), "the page write blocked the loop"
        return 1

    monkeypatch.setattr(digest, "_fetch", fetch)
    monkeypatch.setattr(digest, "_store", store)

    async def cancel():
        task = asyncio.create_task(digest.sync_once())
        try:
            assert await asyncio.to_thread(started.wait, 2)
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0)
            assert lock.locked()
            assert not task.done()
        finally:
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await task

    asyncio.run(cancel())
    assert not lock.locked()
    assert db.kv_get("digest_cursor") == 7200


def test_seed_listing_assessment_runs_off_loop(monkeypatch, worker_calls):
    record, check = worker_calls

    async def listing(_league):
        return {ITEM: {FIRST_DAY: (1, 10), SECOND_DAY: (1, 10)}}

    async def fetch(*_args, **_kwargs):
        return 1

    monkeypatch.setattr(seedready, "_listing", listing)
    monkeypatch.setattr(leaguehistory, "fetch_item", fetch)
    monkeypatch.setattr(db, "kv_get", lambda _key: None)
    monkeypatch.setattr(db, "kv_set", lambda _key, _value: None)
    record(seedready, "_fingerprints", lambda _league: {})
    record(seedready, "_stored", lambda _league, _since: {ITEM: {}})
    record(leaguehistory, "_marks", lambda _league: (set(), {}))
    assert asyncio.run(seedready.poll_league(LEAGUE))["fetched"] == 1
    check("_fingerprints", "_stored", "_marks")


def test_crawl_reads_and_metadata_bridge_run_off_loop(monkeypatch, worker_calls):
    record, check = worker_calls

    async def leagues():
        return [{"Value": LEAGUE, "IsCurrent": True}]

    async def category_ids(_league):
        return ["fixture"]

    async def category_items(*_args):
        return [{"ItemId": ITEM, "BaseItemTypeId": "fixture", "ApiId": "fixture"}]

    monkeypatch.setattr(leaguehistory, "_backfill_lock", asyncio.Lock())
    monkeypatch.setattr(leaguehistory, "ITEMS", {})
    monkeypatch.setattr(leaguehistory, "progress", dict(leaguehistory.progress))
    monkeypatch.setattr(leaguehistory, "_leagues", leagues)
    monkeypatch.setattr(leaguehistory, "_category_apiids", category_ids)
    monkeypatch.setattr(leaguehistory, "category_items", category_items)
    monkeypatch.setattr(leaguehistory, "_record_current_leagues", lambda _rows: set())
    record(leaguehistory, "_has_history", lambda: True)
    record(leaguehistory, "_stored_counts", dict)
    record(leaguehistory, "_marks", lambda _league: (set(), {}))
    record(leaguehistory, "_merge_meta_bridge", lambda _bridge: None)
    record(leaguehistory, "_store_item_metadata", lambda _metadata: None)
    assert asyncio.run(leaguehistory.backfill()).get("attempted") == 0
    check(
        "_has_history",
        "_stored_counts",
        "_marks",
        "_merge_meta_bridge",
        "_store_item_metadata",
    )


def test_diagnostics_collects_sqlite_queries_off_loop(monkeypatch, worker_calls):
    record, check = worker_calls

    async def connectivity():
        return {}

    monkeypatch.setattr(diag, "_connectivity", connectivity)
    monkeypatch.setattr(db, "kv_get", lambda _key, default=None: default)
    record(
        diag,
        "get_settings",
        lambda: {"league": LEAGUE, "reference": "", "watchlist": []},
    )
    record(diag, "_db_counts", lambda _league: {})
    record(diag, "_league_history", dict)
    record(diag, "_unknown_traded", lambda _league: [])
    record(diag, "_analytics", lambda _league: {})
    record(session, "status", dict)
    assert asyncio.run(diag.collect())["settings"]["league"] == LEAGUE
    check(
        "get_settings",
        "_db_counts",
        "_league_history",
        "_unknown_traded",
        "_analytics",
        "status",
    )


@pytest.mark.parametrize("page", [False, True])
def test_static_file_cache_reads_and_writes_run_off_loop(
    monkeypatch, tmp_path, worker_calls, page
):
    record, check = worker_calls
    monkeypatch.setattr(gamedata, "CACHE", tmp_path)
    content = "fixture"

    async def request(*_args, **_kwargs):
        return httpx.Response(
            200, text=content, request=httpx.Request("GET", "http://127.0.0.1/fixture")
        )

    monkeypatch.setattr(gateway, "request", request)
    record(Path, "write_bytes")
    record(Path, "read_text" if page else "read_bytes")

    async def load():
        if page:
            return await modpool._page("fixture", 3600)
        return (
            await gamedata._get("http://127.0.0.1/fixture", "fixture", 3600)
        ).decode()

    async def check_cache():
        assert await load() == content
        assert await load() == content

    asyncio.run(check_cache())
    check("write_bytes", "read_text" if page else "read_bytes")


def test_fee_refresh_failure_loads_last_good_fees_off_loop(monkeypatch, worker_calls):
    record, check = worker_calls

    async def fail(*_args, **_kwargs):
        raise ValueError("offline")

    monkeypatch.setattr(gateway, "request", fail)
    monkeypatch.setattr(gamedata, "_get", fail)
    monkeypatch.setattr(gamedata, "state", dict(gamedata.state))
    record(gamedata, "fees", dict)
    assert asyncio.run(gamedata.refresh()) == {}
    check("fees")


def test_registry_fallback_loads_cached_static_off_loop(monkeypatch, worker_calls):
    record, check = worker_calls
    registry = currencies.Registry()
    _mock_response(monkeypatch, {})
    record(db, "kv_get", lambda _key: {"result": [{"entries": [{"id": "fixture"}]}]})
    assert asyncio.run(registry.load_static()) is False
    assert "fixture" in registry.by_id
    check("kv_get")


def test_orderbook_batch_persists_books_off_loop(monkeypatch, worker_calls):
    record, check = worker_calls

    async def post(*_args):
        return {}

    monkeypatch.setattr(orderbook, "_post", post)
    record(orderbook, "_store", lambda *_args: None)
    record(session, "mark_ok", lambda: None)
    assert asyncio.run(
        orderbook._fetch_batch(LEAGUE, ["chaos"], "divine", "fixture", {"chaos"})
    ) == ({"chaos": []}, [])
    check("_store", "mark_ok")


def test_session_validation_and_connect_use_worker_for_credentials(
    monkeypatch, worker_calls
):
    record, check = worker_calls

    async def exchange(*_args, **_kwargs):
        return httpx.Response(200)

    monkeypatch.setattr(orderbook, "exchange_post", exchange)
    record(session, "get_settings", lambda: {"league": LEAGUE})
    record(session.secrets, "store", lambda *_args: None)
    record(session, "status", lambda: {"connected": True})
    assert asyncio.run(session.connect("fixture"))["connected"]
    check("get_settings", "store", "status")


def test_oauth_completion_and_refresh_use_worker_for_credentials(
    monkeypatch, worker_calls
):
    record, check = worker_calls

    async def request(_form):
        return {"access_token": "fixture"}

    monkeypatch.setattr(oauth, "_token_request", request)
    record(
        db,
        "kv_update",
        lambda _key, apply, _default: apply(
            {"state": {"redirect_uri": "fixture", "verifier": "fixture"}}
        ),
    )
    record(oauth, "_save", lambda _token: None)
    record(oauth, "status", dict)
    record(
        oauth.secrets,
        "load",
        lambda _name: {"expires_at": 0, "refresh_token": "fixture"},
    )

    async def use_oauth():
        assert await oauth.complete("code", "state") == {}
        assert await oauth.token() == "fixture"

    asyncio.run(use_oauth())
    check("kv_update", "_save", "status", "load")


def test_mod_refresh_reads_and_replaces_tables_off_loop(monkeypatch, worker_calls):
    record, check = worker_calls

    async def raw(*_args):
        return b"{}"

    async def page(*_args):
        raise ValueError("offline")

    async def catalog_refresh(*_args, **_kwargs):
        return None

    monkeypatch.setattr(gamedata, "_get", raw)
    monkeypatch.setattr(modpool, "_page", page)
    monkeypatch.setattr(modpool, "state", dict(modpool.state))
    monkeypatch.setattr(
        modpool, "derive", lambda _export: SimpleNamespace(families=[{}])
    )
    monkeypatch.setattr(
        modpool, "assemble", lambda *_args, **_kwargs: {"pools": [{}], "currencies": []}
    )
    monkeypatch.setattr(catalog, "refresh", catalog_refresh)
    record(modpool, "stored_grants", lambda: ([], []))
    record(modpool, "store", lambda _result: None)
    assert "offline" in asyncio.run(modpool.refresh())["last_error"]
    check("stored_grants", "store")


def test_orderbook_worker_prepares_db_dependent_batch_off_loop(
    monkeypatch, worker_calls
):
    record, check = worker_calls

    async def fetch(*_args):
        return {"chaos": []}, []

    monkeypatch.setattr(orderbook, "state", dict(orderbook.state))
    monkeypatch.setattr(orderbook, "_queue", asyncio.PriorityQueue())
    monkeypatch.setattr(orderbook, "_pending", {})
    monkeypatch.setattr(orderbook, "_fetch_batch", fetch)
    record(session, "get_cookie", lambda: "fixture")
    record(orderbook, "get_settings", lambda: {"league": LEAGUE})
    record(orderbook, "_pad", lambda haves, *_args: haves)

    async def work():
        future = asyncio.get_running_loop().create_future()
        orderbook._pending[("chaos", "divine")] = [future]
        orderbook._queue.put_nowait((0, 0, 0, "chaos", "divine"))
        task = asyncio.create_task(orderbook.worker())
        try:
            assert await asyncio.wait_for(future, 2) == []
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    asyncio.run(work())
    check("get_cookie", "get_settings", "_pad")


def test_orderbook_sweeper_prepares_watchlist_off_loop(monkeypatch, worker_calls):
    record, check = worker_calls
    monkeypatch.setattr(orderbook, "prune_history", lambda: 0)
    monkeypatch.setattr(orderbook, "BULK_EXCHANGE_ENABLED", True)
    record(
        orderbook,
        "get_settings",
        lambda: {
            "league": LEAGUE,
            "background_sweep": True,
            "watchlist": ["chaos", "divine"],
            "live_max_age_s": 100,
        },
    )
    record(session, "get_cookie", lambda: "fixture")
    record(orderbook, "cached_at", lambda *_args: 3)
    monkeypatch.setattr(orderbook, "_queue", asyncio.PriorityQueue())
    monkeypatch.setattr(orderbook, "_pending", {})
    monkeypatch.setattr(orderbook, "_queued_priority", {})
    monkeypatch.setattr(orderbook, "_seq", 0)
    monkeypatch.setattr(orderbook.pairscore, "score", lambda *_args: 0)
    monkeypatch.setattr(orderbook, "state", dict(orderbook.state))

    async def sweep():
        task = asyncio.create_task(orderbook.sweeper())
        try:
            assert (await asyncio.wait_for(orderbook._queue.get(), 2))[0] == 2
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    asyncio.run(sweep())
    check("get_settings", "get_cookie", "cached_at")


@pytest.mark.parametrize("route", ["board", "top", "one"])
def test_live_refresh_preflight_runs_off_loop(monkeypatch, worker_calls, route):
    record, check = worker_calls
    record(session, "get_cookie", lambda: "fixture")
    record(main, "get_settings", lambda: {"live_min_age_s": 1, "live_top_n": 0})
    monkeypatch.setattr(main.arbitrage, "board_pairs", list)
    monkeypatch.setattr(main.arbitrage, "board", lambda _window: {})
    monkeypatch.setattr(main.arbitrage, "find_routes", lambda *_args: {"routes": []})
    if route == "board":
        result = asyncio.run(main.board_refresh())
    elif route == "top":
        result = asyncio.run(main.routes_refresh_top(main.RefreshTopBody()))
    else:
        result = asyncio.run(
            main.routes_refresh_one(main.RefreshRouteBody(id="fixture"))
        )
    assert result["refresh"]["waited"] == 0
    check("get_cookie", *([] if route == "one" else ["get_settings"]))


def test_empty_hold_reads_crawl_league_off_loop(monkeypatch, worker_calls):
    record, check = worker_calls
    monkeypatch.setattr(main.holdscore, "leaderboard", lambda *_args: {"assets": []})
    monkeypatch.setattr(main, "_ask_backfill", lambda _league: False)
    record(main, "get_settings", lambda: {"league": LEAGUE})
    assert not asyncio.run(main.hold())["building"]
    check("get_settings")


def test_lifespan_loads_static_and_session_off_loop(monkeypatch, worker_calls):
    record, check = worker_calls

    async def idle():
        return None

    record(main.registry, "load_static_cache", lambda: True)
    record(session, "get_cookie", lambda: "fixture")
    record(sidecar_supervisor, "stop", lambda: None)
    monkeypatch.setattr(sidecar_supervisor, "start", lambda: None)
    monkeypatch.setattr(main.registry, "keep_static_fresh", idle)
    monkeypatch.setattr(digest, "run_forever", idle)
    monkeypatch.setattr(gateway, "aclose", idle)
    monkeypatch.setattr(main, "_gold_fee_loop", idle)
    monkeypatch.setattr(main, "_league_history_loop", idle)
    monkeypatch.setattr(main, "_analytics_loop", idle)
    monkeypatch.setattr(main, "seed_poll_enabled", lambda: False)
    monkeypatch.setattr(devtelemetry, "enabled", lambda: False)

    async def boot():
        async with main.lifespan(main.app):
            pass

    asyncio.run(boot())
    check("load_static_cache", "get_cookie", "stop")


def test_event_loop_guard_blocks_production_sqlite_on_loop():
    from app import cache, settings

    cache.clear(settings._settings_cache)

    def direct_test_setup() -> dict:
        return db.kv_get("settings", {}) or {}

    async def on_loop() -> None:
        # Direct test-body DB setup is allowed (no non-db backend/app frame between test and _conn).
        assert isinstance(direct_test_setup(), dict)
        # Worker-thread calls are allowed.
        cache.clear(settings._settings_cache)
        assert isinstance(await asyncio.to_thread(settings.get_settings), dict)
        # Cold production helper on the running event loop must trip the guard.
        cache.clear(settings._settings_cache)
        with pytest.raises(AssertionError, match="event loop"):
            settings.get_settings()

    asyncio.run(on_loop())
