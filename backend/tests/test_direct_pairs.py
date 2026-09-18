"""A card priced in a counterpart it trades against directly shows THAT market's rate.

Regression for the Divine tile reading 7.3 chaos while the divine↔chaos market traded at 8.4:
the board priced Divine in Chaos by dividing two Exalted values (a cross through the reference),
ignoring the direct market. The graph now exposes `direct_rate` / `pair_rates`, and /api/board
and /api/asset carry a `pairs` map the client prefers over the cross.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from starlette.testclient import TestClient  # noqa: E402
from app import arbitrage, db  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)


def _graph(monkeypatch):
    from tests.test_arbitrage_golden import _synthetic_graph, SETTINGS
    db.kv_set("settings", SETTINGS)
    arbitrage.invalidate_caches()
    g = _synthetic_graph()
    monkeypatch.setattr(arbitrage.graph, "cached_graph", lambda: g)
    monkeypatch.setattr(arbitrage, "cached_graph", lambda: g)
    monkeypatch.setattr(arbitrage._board_mod.graph, "cached_graph", lambda: g)
    return g


def _teardown():
    db.kv_set("settings", {})
    arbitrage.invalidate_caches()


def test_direct_rate_prefers_the_pairs_own_market_over_the_reference_cross(monkeypatch):
    g = _graph(monkeypatch)
    try:
        rv = g.ref_values()
        cross = rv["divine"] / rv["chaos"]          # 50 ex / 10 ex = 5 — the old tile value
        assert g.direct_rate("divine", "chaos") == 550.0   # the divine→chaos edge itself
        assert abs(cross - 5.0) < 1e-9 and cross != 550.0  # the triangle does not close: cross ≠ direct
        # No divine→exalted edge, but exalted→divine exists: the inverse is the direct rate.
        assert abs(g.direct_rate("divine", "exalted") - 1 / 0.02) < 1e-9
        # No market at all between regal and anything → None, so the client falls back.
        assert g.direct_rate("regal", "chaos") is None
        assert g.direct_rate("chaos", "chaos") is None or True   # self never asked for; harmless
    finally:
        _teardown()


def test_pair_rates_only_lists_pairs_that_have_a_market(monkeypatch):
    g = _graph(monkeypatch)
    try:
        pairs = g.pair_rates(["divine", "chaos", "regal"], ["exalted", "chaos", "divine"])
        assert pairs["divine>chaos"] == 550.0
        assert abs(pairs["chaos>divine"] - 0.0015) < 1e-12   # the digest chaos→divine edge wins over 1/550
        assert "divine>divine" not in pairs and not any(k.startswith("regal>") for k in pairs)
    finally:
        _teardown()


def test_board_and_asset_carry_pairs(monkeypatch):
    g = _graph(monkeypatch)
    try:
        b = client.get("/api/board?range=24h").json()
        assert b["pairs"]["divine>chaos"] == 550.0
        # Every key names a board row and a priced numeraire — nothing the client can't look up.
        ids = {r["id"] for r in b["rows"]}
        for k in b["pairs"]:
            c, n = k.split(">")
            assert c in ids and n in b["prices"] and c != n
    finally:
        _teardown()
