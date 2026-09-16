"""Batch 10 — dead code sweep + polish (audit F-26, F-27).

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_dead_sweep.py -q
"""
import inspect
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import analytics, arbitrage, centrality, config, db, gamedata, holdscore, leaguearc, liquidity, watchdog  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)
APP = Path(__file__).resolve().parents[1] / "app"


def test_zero_caller_routes_are_gone():
    for path in ("/api/account/profile", "/api/account/characters", "/api/routes"):
        assert client.get(path).status_code in (404, 405), path
    for path in ("/api/inflation/cross/refresh", "/api/market/refresh"):
        assert client.post(path).status_code in (404, 405), path
    assert client.get("/api/oauth/callback").status_code == 400   # env-configurable redirect: kept


def test_put_watches_is_gone_and_never_touches_the_workspace():
    before = {"version": 2, "tree": [{"id": "n_1", "kind": "folder", "name": "keep", "open": True, "children": []}],
              "layout": None, "openTabs": []}
    db.kv_set("trading_workspace", before)
    r = client.put("/api/watches", json={"folders": []})
    assert r.status_code == 410
    assert client.get("/api/trading/workspace").json()["workspace"] == before
    assert client.get("/api/watches").status_code == 200        # read-only legacy view stays
    assert "watches_to_workspace(legacy)" not in (APP / "main.py").read_text()   # no read-time coercion
    db.kv_set("trading_workspace", {"version": 2, "tree": [], "layout": None, "openTabs": []})


def test_dead_helpers_and_params_are_gone():
    assert not hasattr(arbitrage.Graph, "cycles")
    assert not hasattr(gamedata, "fee_for")
    assert not hasattr(db, "market_meta_get") and not hasattr(db, "market_meta_set")
    assert not hasattr(centrality, "scores")
    assert "k" not in inspect.signature(arbitrage._best_conversions).parameters
    assert "max_steps" not in inspect.signature(liquidity.realizable).parameters
    assert "horizon" not in inspect.signature(leaguearc.arc_for).parameters
    assert inspect.signature(holdscore._metrics).parameters["hz_days"].annotation in ("int", int)
    assert "hz or 30" not in (APP / "holdscore.py").read_text()
    assert not hasattr(watchdog, "_call_dead")
    assert not hasattr(config, "ORDERBOOK_MIN_GAP_SECONDS")


def test_read_cache_requires_a_key():
    assert "key: str" in inspect.getsource(analytics.read_cache).split("\n")[0]


def test_no_silent_broad_excepts_around_code_that_cannot_fail():
    graph = (APP / "arbitrage" / "graph.py").read_text()
    assert "except Exception:\n            pass" not in graph
    lh = (APP / "leaguehistory.py").read_text()
    assert "never let a cache poke break the crawl" not in lh
    sup = (APP / "sidecar_supervisor.py").read_text()
    assert "except Exception:\n                pass" not in sup
