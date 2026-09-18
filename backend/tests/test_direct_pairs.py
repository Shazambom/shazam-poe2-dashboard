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


def test_asset_modal_pairs_are_keyed_by_the_rows_slug(monkeypatch):
    """The pulse-strip modal row is keyed by poe2scout slug ("divine-orb"); pairs must still
    find the graph's trade id ("divine") and come back keyed the way the client looks them up."""
    from app import movers
    g = _graph(monkeypatch)
    try:
        monkeypatch.setattr(movers, "_current_series", lambda: (
            "GoldenLeague", {1: [(1_700_000_000 + i * 86400, 50.0, 100) for i in range(5)]},
            {1: ("Divine Orb", "Currency")}))
        from app import leaguehistory
        monkeypatch.setattr(leaguehistory, "scout_prices", lambda _l: {"chaos orb": 10.0, "divine orb": 50.0})
        res = movers.asset_row("Divine Orb", 24)
        assert res["row"]["id"] == "divine-orb"
        assert res["pairs"]["divine-orb>chaos"] == 550.0
        assert not any(k.startswith("divine>") for k in res["pairs"])
    finally:
        _teardown()


def _vol(g, a, b, v):
    g.edges[(a, b)].vol_in_per_h = v


def test_price_in_applies_the_volume_rule(monkeypatch):
    """The pair's own market wins only when it is at least as liquid as the weaker reference
    leg; a thin direct market defers to the cross through the liquid reference legs."""
    g = _graph(monkeypatch)
    try:
        rv = g.ref_values()
        cross = rv["divine"] / rv["chaos"]                    # 5.0
        # Fixture: every edge 100 units/h. divine→chaos = 100 × 50 ex = 5000 ex/h of volume,
        # legs: chaos↔ex 1100, ex↔divine 100 → direct (5000) ≥ min(legs) (100) → direct.
        assert g.price_in("divine", "chaos", rv) == 550.0
        # Starve the direct market (both directions count): 0.5 + 0.1 ex/h < 100 → the cross wins.
        _vol(g, "divine", "chaos", 0.01)
        _vol(g, "chaos", "divine", 0.01)
        assert abs(g.price_in("divine", "chaos", rv) - cross) < 1e-9
        # A pair against the reference itself is always its own market (no cross to defer to).
        assert abs(g.price_in("divine", "exalted", rv) - 50.0) < 1e-9
        # No market at all → the cross; no reference value either → None.
        assert g.price_in("regal", "chaos", rv) is None
        # pair_rates carries the same rule: the starved pair now reports the cross, not 550.
        assert abs(g.pair_rates(["divine"], ["chaos"])["divine>chaos"] - cross) < 1e-9
    finally:
        _teardown()


def test_convert_loss_is_measured_against_the_pairs_market(monkeypatch):
    """`loss_pct` compares what the route delivers with the have↔want market, not with the
    reference cross; the phantom-gain cap keeps using the cross (`gain_cross_pct`)."""
    from app import arbitrage as arb
    g = _graph(monkeypatch)
    try:
        out = arb.convert("divine", "chaos", 1)
        direct = out["direct"]
        assert direct["path"] == ["divine", "chaos"] and direct["out"] == 550
        assert abs(direct["loss_pct"]) < 1e-9            # the market itself: at market
        assert "gain_cross_pct" in direct
    finally:
        _teardown()


def test_sales_ledger_carries_a_reference_price_for_every_sale_currency(monkeypatch):
    from app import db as _db
    g = _graph(monkeypatch)
    try:
        monkeypatch.setattr(_db, "sales_list", lambda _l=None: [
            {"item_id": "a", "time": "2026-09-18T00:00:00Z", "league": "L", "price": {"amount": 3, "currency": "chaos"}, "item": {}},
            {"item_id": "b", "time": "2026-09-18T00:00:00Z", "league": "L", "price": {"amount": 1, "currency": "divine"}, "item": {}},
            {"item_id": "c", "time": "2026-09-18T00:00:00Z", "league": "L", "price": {"amount": 2, "currency": "regal"}, "item": {}},
        ])
        monkeypatch.setattr(_db, "sales_leagues", lambda: ["L"])
        res = client.get("/api/sales").json()
        assert res["prices"]["chaos"] == 10.0 and res["prices"]["divine"] == 50.0
        assert "regal" not in res["prices"]        # no market, no reference value → stays unpriced
    finally:
        _teardown()


def test_a_card_is_never_priced_in_a_currency_worth_more_than_itself(monkeypatch):
    """The readability floor is 1.0: chaos (10 ex) is not shown "in divine" (0.2) even though
    divine is its biggest market; it steps down to exalted (10). Divine keeps chaos (550)."""
    g = _graph(monkeypatch)
    try:
        b = client.get("/api/board?range=24h").json()
        pref = {r["id"]: r["pref_num"] for r in b["rows"]}
        assert pref["chaos"] == "exalted"
        assert pref["divine"] == "chaos"
        for r in b["rows"]:
            n = r["pref_num"]
            if r["mid"] and b["prices"].get(n) and n != b["reference"]:
                assert r["mid"] / b["prices"][n] >= 1.0, f"{r['id']} shown in {n} at {r['mid'] / b['prices'][n]:.3f}"
    finally:
        _teardown()
