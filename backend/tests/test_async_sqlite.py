"""Transaction checks for async callers of the synchronous SQLite helpers."""

import asyncio
import json
import sqlite3
import sys
import threading
from contextlib import contextmanager
from pathlib import Path

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
    orderbook,
    seedready,
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
