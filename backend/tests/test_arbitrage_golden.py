"""Golden regression tests for the arbitrage core — the safety net for splitting arbitrage.py.

Everything here runs over a deterministic fixture (a synthetic exchange graph, a synthetic
digest league in the test DB, frozen clock, no network) and compares the FULL JSON output of
the public entry points against snapshots in tests/golden/. Any refactor of the module
(package split, cache helpers, main.py extractions) must leave these byte-identical.

Regenerate deliberately (after a reviewed behaviour change) with:
    UPDATE_GOLDEN=1 DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_arbitrage_golden.py -q
"""
import json
import os
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import arbitrage, db, digest, gamedata, leaguehistory, orderbook, session, settings  # noqa: E402
from app.arbitrage import Edge, Graph  # noqa: E402

GOLDEN = Path(__file__).parent / "golden"
T0 = 1_800_000_000          # frozen "now" (UTC epoch seconds), on an hour boundary
LEAGUE = "GoldenLeague"

SETTINGS = {
    "league": LEAGUE, "reference": "exalted", "watchlist": ["chaos", "exalted", "divine", "regal"],
    "max_steps": 3, "max_start_fraction": 1.0, "step_overhead_min": 0.0, "gold_model": {},
    "routes_cache_s": 300, "allow_digest_edges": True, "allow_recipe_edges": False,
    "digest_max_age_h": 6, "live_max_age_s": 1800, "min_edge_volume_ref_per_h": 0,
    "min_edge_depth": 0, "hub_count": 2, "_hub_seed_v1": True, "_liq_floor_v1": True,
    "rank_weights": {"velocity": 0.5, "margin_per_1k_gold": 0.2, "margin_ref": 0.2, "volume": 0.1},
    "filters": {"min_margin_pct": 0.0, "min_margin_ref": 0.0, "max_gold": 0, "min_margin_per_1k_gold": 0.0,
                "min_liquidity_ref": 0.0, "min_volume_ref_per_h": 0.0, "max_fill_hours": 0,
                "min_velocity": 0.0, "live_only": False, "sort": "score", "limit": 100},
}

META = {"chaos": "Metadata/Items/Currency/CurrencyRerollRare",
        "exalted": "Metadata/Items/Currency/CurrencyAddModToRare",
        "divine": "Metadata/Items/Currency/CurrencyModValues"}


def _check(name: str, got) -> None:
    path = GOLDEN / f"{name}.json"
    text = json.dumps(got, sort_keys=True, indent=1, default=str)
    if os.environ.get("UPDATE_GOLDEN") or not path.exists():
        GOLDEN.mkdir(exist_ok=True)
        path.write_text(text)
        if os.environ.get("UPDATE_GOLDEN"):
            return
    assert json.loads(path.read_text()) == json.loads(text), f"golden {name} drifted (UPDATE_GOLDEN=1 to accept)"


@pytest.fixture
def frozen(monkeypatch):
    monkeypatch.setattr(time, "time", lambda: float(T0))
    monkeypatch.setattr(gamedata, "fees", lambda: {"by_trade": {}})
    monkeypatch.setattr(leaguehistory, "scout_prices", lambda league: {})
    monkeypatch.setattr(leaguehistory, "scout_history", lambda league, days=60: {})
    monkeypatch.setattr(session, "status", lambda: {"connected": False})
    monkeypatch.setattr(db, "get_capital", lambda: {"chaos": 100.0, "exalted": 50.0})
    db.kv_set("settings", SETTINGS)
    arbitrage.invalidate_caches()
    orderbook.state["version"] = 1
    yield
    db.kv_set("settings", {})
    arbitrage.invalidate_caches()


def _synthetic_graph() -> Graph:
    g = Graph(settings.get_settings())
    g.fee_table = {}

    def edge(a, b, rate, stock, kind="live"):
        return Edge(a, b, kind, rate, [{"rate": rate, "stock": stock}], age_s=10.0)

    g.add(edge("chaos", "exalted", 10.0, 5000))
    g.add(edge("exalted", "chaos", 0.12, 600))       # 1.2x round trip — a real loop
    g.add(edge("exalted", "divine", 0.02, 100))
    g.add(edge("divine", "chaos", 550.0, 20000))     # chaos→ex→div→chaos: 10*0.02*550 = 1.1x
    g.add(edge("chaos", "divine", 0.0015, 10, kind="digest"))
    for e in g.edges.values():
        e.vol_in_per_h = 100.0
    return g


def _seed_digest_league() -> None:
    """Six hours of digest rows for chaos/exalted/divine so Graph.build + board have data."""
    with db.tx() as c:
        c.execute("DELETE FROM digest_markets WHERE league=?", (LEAGUE,))
    for i in range(6):
        hour = T0 - 3600 * (i + 1)
        drift = 1 + i * 0.01
        markets = [
            {"league": LEAGUE, "market_pair": [META["chaos"], META["exalted"]],
             "volume_traded": {META["chaos"]: int(1000 * drift), META["exalted"]: 10000},
             "highest_stock": {META["chaos"]: 500, META["exalted"]: 5000}},
            {"league": LEAGUE, "market_pair": [META["exalted"], META["divine"]],
             "volume_traded": {META["exalted"]: int(50000 * drift), META["divine"]: 1000},
             "highest_stock": {META["exalted"]: 20000, META["divine"]: 400}},
        ]
        digest._store(hour, markets)


def test_find_routes_and_stream_routes_agree(frozen, monkeypatch):
    g = _synthetic_graph()
    monkeypatch.setattr(arbitrage.graph, "cached_graph", lambda: g)
    monkeypatch.setattr(arbitrage, "cached_graph", lambda: g)
    arbitrage._route_cache.clear()
    direct = arbitrage._find_routes({}, None)
    assert direct["routes"], "fixture must produce at least one route"
    arbitrage._route_cache.clear()
    events = list(arbitrage.stream_routes({}, None))
    kinds = [k for k, _ in events]
    assert kinds[0] == "meta" and kinds[-1] == "done"
    streamed = [p for k, p in events if k == "route"]
    done = events[-1][1]
    assert done["order"] == [r["id"] for r in direct["routes"]]
    assert done["scores"] == {r["id"]: r["score"] for r in direct["routes"]}
    assert {r["id"] for r in streamed} >= set(done["order"])
    assert events[0][1]["graph"] == direct["graph"]
    assert events[0][1]["filters"] == direct["filters"]
    _check("routes", direct)


def test_stream_routes_second_call_is_served_from_cache(frozen, monkeypatch):
    g = _synthetic_graph()
    monkeypatch.setattr(arbitrage.graph, "cached_graph", lambda: g)
    monkeypatch.setattr(arbitrage, "cached_graph", lambda: g)
    arbitrage._route_cache.clear()
    first = list(arbitrage.stream_routes({"sort": "margin_ref"}, ["chaos"]))
    second = list(arbitrage.stream_routes({"sort": "margin_ref"}, ["chaos"]))
    assert second[-1][1]["cached"] is True
    assert second[-1][1]["order"] == first[-1][1]["order"]


def test_convert_golden(frozen, monkeypatch):
    g = _synthetic_graph()
    monkeypatch.setattr(arbitrage.graph, "cached_graph", lambda: g)
    monkeypatch.setattr(arbitrage, "cached_graph", lambda: g)
    out = arbitrage.convert("chaos", "divine", 100)
    assert out["best"] is not None
    _check("convert", out)


def test_board_golden_over_fixture_league(frozen):
    _seed_digest_league()
    arbitrage.invalidate_caches()
    b = arbitrage.board(24)
    assert b["league"] == LEAGUE and b["reference"] == "exalted"
    ids = [r["id"] for r in b["rows"]]
    assert "chaos" in ids and "divine" in ids
    _check("board", b)
    assert arbitrage.board(24) is b          # TTL cache hit
    b2 = arbitrage.board(72)
    assert b2 is not b                       # different window → different key
    _check("board_72h", b2)


def test_edge_table_and_board_pairs_golden(frozen):
    _seed_digest_league()
    arbitrage.invalidate_caches()
    _check("edge_table", arbitrage.edge_table())
    _check("board_pairs", sorted(arbitrage.board_pairs()))
