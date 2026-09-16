"""Batch 6 — backend duplication sand-down (audit F-07, F-08, F-17, F-18, F-19, F-20, F-21).

Behaviour is pinned by the goldens (test_arbitrage_golden) and test_pure_helpers; these tests pin
the SHAPE of the consolidation: one memo helper, one route-cache path with eviction, one league
reader, one route-filter model, one exchange POST, one home per small helper, and thin handlers.

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_sanddown_backend.py -q
"""
import asyncio
import inspect
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import (arbitrage, cache, db, diag, digest, holdscore, leaguehistory, liquidity,  # noqa: E402
                 marketseries, orderbook, session, settings)
from app.currencies import registry  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402
from app.main import app, RouteQuery  # noqa: E402

client = TestClient(app)
APP = Path(__file__).resolve().parents[1] / "app"


# ----------------------------------------------------------------- F-19 one memo helper
def test_memo_caches_by_key_ttl_and_version(monkeypatch):
    store: dict = {}
    calls = []
    build = lambda: calls.append(1) or len(calls)
    now = [1000.0]
    monkeypatch.setattr(time, "time", lambda: now[0])
    assert cache.memo(store, "k", 10, build) == 1
    assert cache.memo(store, "k", 10, build) == 1            # hit
    now[0] += 11
    assert cache.memo(store, "k", 10, build) == 2            # expired
    assert cache.memo(store, "k", 10, build, version=7) == 3  # version changed → rebuild
    assert cache.memo(store, "k", 10, build, version=7) == 3
    assert cache.memo(store, "other", 10, build) == 4
    cache.clear(store)
    assert store == {}


def test_every_module_level_ttl_cache_goes_through_memo():
    """No more hand-rolled `time.time() - hit[0] < TTL` checks outside cache.py."""
    offenders = [p.name for p in APP.glob("*.py") if p.name != "cache.py"
                 and "- hit[0] <" in p.read_text()]
    assert offenders == []


# ----------------------------------------------------------------- F-07 one route-cache path
def test_stream_routes_evicts_like_find_routes(monkeypatch):
    from tests.test_arbitrage_golden import SETTINGS, _synthetic_graph
    db.kv_set("settings", SETTINGS)
    arbitrage.invalidate_caches()
    g = _synthetic_graph()
    monkeypatch.setattr(arbitrage, "cached_graph", lambda: g)
    monkeypatch.setattr(db, "get_capital", lambda: {"chaos": 100.0})
    for i in range(40):
        list(arbitrage.stream_routes({"limit": 100 + i}, None))
    assert len(arbitrage._route_cache) <= arbitrage.ROUTE_CACHE_MAX
    db.kv_set("settings", {})
    arbitrage.invalidate_caches()


def test_stream_and_find_share_result_and_cache_helpers():
    src = (APP / "arbitrage.py").read_text()
    assert src.count('"fee_table_size": len(g.fee_table)') == 1, "graph summary built in one place"
    assert "def _cache_put(" in src and "def _cache_get(" in src and "def _result(" in src


# ----------------------------------------------------------------- F-08 one league reader
def test_build_context_reads_via_marketseries_and_is_memoized(monkeypatch):
    calls = []
    real = marketseries.read_rows

    def counting(conn, league=None):
        calls.append(league)
        return real(conn, league)
    monkeypatch.setattr(marketseries, "read_rows", counting)
    holdscore.invalidate()
    a = holdscore.build_context(291)
    b = holdscore.build_context(291)
    assert a == b and len(calls) == 1
    holdscore.build_context(295)
    assert len(calls) == 2
    src = (APP / "holdscore.py").read_text()
    assert "SELECT league, item_id, day, close, volume" not in src
    assert "lh_current" not in src   # league resolution is marketseries.pick_league's job


def test_marketcap_uses_the_shared_reader():
    src = (APP / "leaguehistory.py").read_text()
    # only the poe2scout name-joins (one with a subquery) and the crawl watermark count select league_daily
    # directly; cross()/marketcap() go through marketseries.item_rows/read_rows.
    assert src.count("FROM league_daily") == 4
    assert "SELECT league, item_id, day, close, volume FROM league_daily" not in src
    assert "SELECT league, day, close FROM league_daily" not in src


# ----------------------------------------------------------------- F-17 one route-filter model
def test_route_query_to_filters_drops_unset_and_keeps_wire_names():
    q = RouteQuery(min_margin_pct=3.0, live_only=True, sort="velocity", limit=5, start="chaos,exalted")
    assert q.to_filters() == {"min_margin_pct": 3.0, "live_only": True, "sort": "velocity", "limit": 5}
    assert q.starts() == ["chaos", "exalted"]
    assert RouteQuery().starts() is None
    with pytest.raises(ValueError):
        RouteQuery(sort="nope")


def test_route_endpoints_declare_filters_once():
    src = (APP / "main.py").read_text()
    assert src.count("min_margin_per_1k_gold: float | None") == 1
    assert "_filters_from" not in src


def test_stream_endpoint_reports_query_filters():
    from tests.test_arbitrage_golden import SETTINGS
    db.kv_set("settings", SETTINGS)
    arbitrage.invalidate_caches()
    r = client.get("/api/routes/stream", params={"min_margin_pct": 2.5, "sort": "margin_ref", "live_only": "true"})
    assert r.status_code == 200
    meta = next(l for l in r.text.splitlines() if l.startswith("data:") )
    assert '"min_margin_pct": 2.5' in meta and '"sort": "margin_ref"' in meta and '"live_only": true' in meta
    db.kv_set("settings", {})
    arbitrage.invalidate_caches()


# ----------------------------------------------------------------- F-20 one exchange POST
def test_exchange_post_flips_url_form_once_on_404(monkeypatch):
    asyncio.run(_exchange_post_case(monkeypatch))


async def _exchange_post_case(monkeypatch):
    from app import gateway
    calls = []

    class R:
        def __init__(self, code):
            self.status_code = code

        def raise_for_status(self):
            pass

        def json(self):
            return {"ok": 1}

    async def fake_request(method, url, **kw):
        calls.append((url, kw.get("headers", {}).get("Referer")))
        return R(404 if len(calls) == 1 else 200)
    monkeypatch.setattr(gateway, "request", fake_request)
    orderbook.state["url_form"] = "poe2/{league}"
    r = await orderbook.exchange_post("Std", {"q": 1}, "cookie", retries=0)
    assert r.status_code == 200 and len(calls) == 2
    assert calls[0][0].endswith("/poe2/Std") and calls[1][0].endswith("/Std")
    assert calls[0][1].endswith("/exchange/poe2/Std")
    assert orderbook.state["url_form"] == "{league}"
    orderbook.state["url_form"] = "poe2/{league}"


def test_session_validate_and_orderbook_share_the_post():
    src = (APP / "session.py").read_text()
    assert "_headers" not in src and "url_form" not in src
    assert "exchange_post" in src


# ----------------------------------------------------------------- F-21 small helpers, one home each
def test_change_over_matches_the_board_and_movers_rule():
    pts = [{"t": 0, "v": 10.0}, {"t": 3600, "v": 12.0}, {"t": 7200, "v": 15.0}, {"t": 10800, "v": 20.0}]
    base, pct = marketseries.change_over(pts, 3600)
    assert base == pts[2] and pct == pytest.approx(100 * 5 / 15)
    base, pct = marketseries.change_over(pts, 10 * 3600)
    assert base == pts[0] and pct == pytest.approx(100.0)
    assert marketseries.change_over(pts[:1], 3600) == (None, None)
    assert marketseries.change_over([{"t": 0, "v": 0}, {"t": 1, "v": 1}], 1) == (pts[0] | {"v": 0}, None)


def test_day_helpers_have_one_home():
    assert marketseries.day_to_epoch("1970-01-02") == 86400
    assert marketseries.league_age("2026-01-11", "2026-01-01") == 10
    assert not hasattr(leaguehistory, "_age") and not hasattr(leaguehistory, "_epoch")
    for name in ("holdscore.py", "leaguehistory.py", "leaguearc.py"):
        assert "strptime" not in (APP / name).read_text()


def test_registry_metas_and_scout_lookup():
    registry._link("Metadata/Items/Currency/Test", "testcur")
    assert registry.metas("testcur") == ["Metadata/Items/Currency/Test"]
    assert registry.metas("nope") == []
    assert "meta_to_trade.items()" not in (APP / "digest.py").read_text()
    table = {"divine orb": 5.0, "divine-orb": 5.0, "chaos": 1.0}
    assert leaguehistory.scout_lookup(table, "divine") == 5.0      # by registry name
    assert leaguehistory.scout_lookup(table, "chaos") == 1.0       # by id
    assert leaguehistory.scout_lookup(table, "nope") is None
    assert "scout.get(str(" not in (APP / "arbitrage.py").read_text()


def test_settings_clamps_have_one_home():
    assert settings.gold_value_per_1k({"gold_value_per_1k": 0}) == arbitrage.GOLD_VALUE_DIVINE_PER_1K
    assert settings.gold_value_per_1k({"gold_value_per_1k": "0.02"}) == 0.02
    assert settings.hub_count({"hub_count": 0}) >= 1
    assert settings.hub_count({"hub_count": 3}) == 3
    for name in ("arbitrage.py", "main.py", "liquidity.py"):
        src = (APP / name).read_text()
        assert 'or GOLD_VALUE_DIVINE_PER_1K' not in src.replace("def gold_value_per_1k", "")
        assert 'or centrality.HUB_N' not in src


# ----------------------------------------------------------------- F-18 thin handlers
def test_main_handlers_delegate_domain_work():
    src = (APP / "main.py").read_text()
    assert "httpx" not in src                       # diag probes via the gateway
    assert "liquidity.realizable(" not in src       # capital rows are built in liquidity
    assert 'r["value_ex"]' not in src               # market/top valuation lives in digest
    assert "signalsack.prune(" not in src           # ack workflow lives in signalsack
    assert '"/data/install-reports.log"' not in src


def test_capital_rows_and_top_markets_valued_exist():
    assert callable(liquidity.capital_rows) and callable(digest.top_markets_valued)
    sig = inspect.signature(diag.collect)
    assert sig.parameters == {} or "probe" in sig.parameters


def test_diag_probes_through_the_gateway(monkeypatch):
    asyncio.run(_diag_case(monkeypatch))


async def _diag_case(monkeypatch):
    from app import gateway
    seen = []

    class R:
        status_code = 200

    async def fake_request(method, url, **kw):
        seen.append((url, kw.get("policy")))
        return R()
    monkeypatch.setattr(gateway, "request", fake_request)
    out = await diag.collect()
    assert set(out["connectivity"].values()) == {200}
    assert len(seen) == 3 and all(p for _u, p in seen)


def test_install_log_path_follows_data_dir():
    from app import config
    assert str(config.INSTALL_LOG_PATH).startswith(str(config.DATA_DIR))
