"""One value table: a card shows the market that actually prices it, and nothing contradicts it.

Regression for the Divine tile reading 7.3 chaos while the divine↔chaos market traded at 8.4: the
board priced Divine in Chaos by dividing two Exalted values (a cross through the reference),
ignoring the market doing the trading. The rule now runs once for the whole market —
`Graph.values()` prices each currency through its DEEPEST chain of markets by traded value — and
every screen divides two numbers out of that one table (board `prices`, `/api/asset`, `/api/sales`,
the wealth anchors, Capital, cash-out, Convert and the Arbitrage routes).

The fixture is the shape that broke it again on 2026-09-19 (owner report): Divine's deep market is
Chaos, and its DIRECT Exalted market is thin and 10% low — the Preserved Cranium case, where the
thin direct market said 9.8 div and the deep one said 16.77 div.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from starlette.testclient import TestClient  # noqa: E402
from app import arbitrage, db  # noqa: E402
from app.arbitrage import Edge, Graph  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)

SETTINGS = {
    "league": "PairsLeague", "reference": "exalted", "watchlist": ["chaos", "divine", "regal"],
    "max_steps": 3, "max_start_fraction": 1.0, "step_overhead_min": 0.0, "gold_model": {},
    "routes_cache_s": 300, "allow_digest_edges": True, "allow_recipe_edges": False,
    "digest_max_age_h": 6, "live_max_age_s": 1800, "min_edge_volume_ref_per_h": 0,
    "min_edge_depth": 0, "hub_count": 2, "_hub_seed_v1": True, "_liq_floor_v1": True,
    "filters": {"limit": 100},
}


def _edge(a, b, rate, stock, kind="live", vol=0.0):
    return Edge(a, b, kind, rate, [{"rate": rate, "stock": stock}], age_s=10.0, vol_in_per_h=vol)


def _graph(monkeypatch):
    """Chaos is the deep market for both Exalted and Divine; Divine's direct Exalted market is
    thin and 10% low. Volumes are units/hour, so a market's size is units × what they are worth."""
    db.kv_set("settings", SETTINGS)
    arbitrage.invalidate_caches()
    g = Graph(dict(SETTINGS))
    g.fee_table = {}
    g.add(_edge("chaos", "exalted", 10.0, 500_000, vol=20_000))          # 1 chaos = 10 ex   (200k ex/h)
    g.add(_edge("exalted", "chaos", 0.1, 500_000, vol=200_000))
    g.add(_edge("divine", "chaos", 55.0, 20_000, vol=3_000))             # 1 divine = 55 chaos (1.6M ex/h)
    g.add(_edge("chaos", "divine", 1 / 55.0, 20_000, vol=150_000))
    g.add(_edge("divine", "exalted", 500.0, 40, kind="digest", vol=8))   # thin, and 10% low (4k ex/h)
    g.add(_edge("regal", "chaos", 0.2, 5_000, vol=900))                  # 1 regal = 2 ex, via chaos
    g.add(_edge("chaos", "regal", 5.0, 5_000, vol=4_500))
    monkeypatch.setattr(arbitrage.graph, "cached_graph", lambda: g)
    monkeypatch.setattr(arbitrage, "cached_graph", lambda: g)
    monkeypatch.setattr(arbitrage._board_mod.graph, "cached_graph", lambda: g)
    return g


def _teardown():
    db.kv_set("settings", {})
    arbitrage.invalidate_caches()


# ------------------------------------------------------------------ the rule
def test_a_currency_is_priced_by_its_deepest_market(monkeypatch):
    """Divine trades ~1.6M ex/h against Chaos and 4k ex/h against Exalted, and the two disagree by
    10%. The deep market wins: 55 chaos × 10 ex = 550, not the thin market's 500."""
    g = _graph(monkeypatch)
    try:
        V = g.values()
        assert V["exalted"] == 1.0
        assert abs(V["chaos"] - 10.0) < 1e-9
        assert abs(V["divine"] - 550.0) < 1e-9              # through Chaos
        assert g.direct_rate("divine", "exalted") == 500.0  # the thin market still exists, unused
        assert abs(V["regal"] - 2.0) < 1e-9                 # priced through its only market
    finally:
        _teardown()


def test_a_card_shows_the_rate_of_the_market_that_prices_it(monkeypatch):
    """The original regression: Divine shown in Chaos reads 55 — that market's own rate — because
    the price IS that market, not a cross through the reference."""
    g = _graph(monkeypatch)
    try:
        V = g.values()
        assert abs(V["divine"] / V["chaos"] - g.direct_rate("divine", "chaos")) < 1e-9
        b = client.get("/api/board?window_h=24").json()
        rows = {r["id"]: r for r in b["rows"]}
        assert rows["divine"]["pref_num"] == "chaos"
        assert abs(rows["divine"]["mid"] / b["prices"]["chaos"] - 55.0) < 1e-9
    finally:
        _teardown()


def test_one_table_leaves_no_second_rate_to_disagree_with(monkeypatch):
    """Board and asset carry ONE price table and no per-pair rates, so every number on a card is a
    ratio of two of its prices (a cranium once read 16.77 div and 4,620 ex on the same card), and
    the wealth anchors agree with it."""
    g = _graph(monkeypatch)
    try:
        b = client.get("/api/board?window_h=24").json()
        assert "pairs" not in b          # no per-pair rates ship at all any more
        V = g.values()
        for r in b["rows"]:
            assert r["mid"] == V[r["id"]] and b["prices"][r["pref_num"]]
        a = client.get("/api/asset?q=Divine Orb&window_h=24").json()
        assert "pairs" not in a and abs(a["row"]["mid"] - V["divine"]) < 1e-9
        assert abs(arbitrage.anchor_prices()["divine"] - V["divine"]) < 1e-9
    finally:
        _teardown()


def test_a_deep_market_takes_over_when_it_becomes_the_deepest(monkeypatch):
    """The rule is traded value, not which market faces the reference: deepen Divine↔Exalted past
    the Chaos market and Divine prices there instead."""
    g = _graph(monkeypatch)
    try:
        assert abs(g.values()["divine"] - 550.0) < 1e-9
        g.add(_edge("divine", "exalted", 500.0, 40_000, kind="digest", vol=40_000))   # 20M ex/h
        assert abs(g.values()["divine"] - 500.0) < 1e-9
    finally:
        _teardown()


def test_a_one_sided_fat_finger_is_not_a_price(monkeypatch):
    """Someone moving 2,000 Divine an hour for a handful of Regals is deep in Divine and nothing
    in Regals. poe2scout says a Regal is worth ~2 exalted, and a market that disagrees with the
    outside world by four orders of magnitude does not get to price it."""
    from app import leaguehistory
    g = _graph(monkeypatch)
    try:
        monkeypatch.setattr(type(g), "_scout_values", lambda self: {"regal": 2.0}, raising=False)
        g.add(_edge("divine", "regal", 0.02, 50, kind="digest", vol=2_000))   # 1 regal = 50 divine?!
        assert abs(g.values()["regal"] - 2.0) < 1e-9
    finally:
        _teardown()


def test_a_card_is_never_priced_in_a_currency_worth_more_than_itself(monkeypatch):
    """The readability floor is 1.0: chaos (10 ex) is not shown "in divine" (550) even though
    divine is its biggest market; it steps down to exalted. Divine keeps chaos (55)."""
    g = _graph(monkeypatch)
    try:
        b = client.get("/api/board?window_h=24").json()
        pref = {r["id"]: r["pref_num"] for r in b["rows"]}
        assert pref["chaos"] == "exalted"
        assert pref["divine"] == "chaos"
        for r in b["rows"]:
            n = r["pref_num"]
            if r["mid"] and b["prices"].get(n) and n != b["reference"]:
                assert r["mid"] / b["prices"][n] >= 1.0, f"{r['id']} shown in {n} at {r['mid'] / b['prices'][n]:.3f}"
    finally:
        _teardown()


# ------------------------------------------------------------------ the line under the number
def test_board_trend_and_change_follow_the_market_the_price_comes_from(monkeypatch):
    """The sparkline and the % on a card are the history of the SAME market as the number. Divine
    is priced by its Chaos market, so its line is the divine↔chaos history in chaos (`trend_num`),
    not the thin divine↔exalted history — which once drew −29% under a card whose own market
    moved −12%."""
    from app import arbitrage as arb
    g = _graph(monkeypatch)
    try:
        t0 = 1_700_000_000
        def hist(_league, a, b, hours):
            if (a, b) == ("divine", "chaos"):
                return [{"hour": t0 + i * 3600, "rate": 50.0 + i} for i in range(6)]        # +10%
            if (a, b) == ("divine", "exalted"):
                return [{"hour": t0 + i * 3600, "rate": 600.0 - i * 20} for i in range(6)]  # −16.7%
            if (a, b) == ("chaos", "exalted"):
                return [{"hour": t0 + i * 3600, "rate": 9.0 + i * 0.2} for i in range(6)]
            return []
        monkeypatch.setattr(arb._board_mod.digest, "pair_history", hist)
        rows = {r["id"]: r for r in client.get("/api/board?window_h=24").json()["rows"]}
        d = rows["divine"]
        assert d["pref_num"] == "chaos" and d["trend_num"] == "chaos"
        assert d["trend"][-1]["v"] == 55.0 and abs(d["change_pct"] - 10.0) < 1e-9
        c = rows["chaos"]                                    # priced against the reference itself
        assert c["pref_num"] == "exalted" and c["trend_num"] == "exalted"
        assert abs(c["trend"][0]["v"] - 9.0) < 1e-9
    finally:
        _teardown()


def test_a_priced_in_pick_moves_the_trend_to_that_market(monkeypatch):
    """`nums` (the client's per-card "priced in" picks) changes which market's history the card's
    line and % come from."""
    from app import arbitrage as arb
    g = _graph(monkeypatch)
    try:
        t0 = 1_700_000_000
        def hist(_league, a, b, hours):
            if (a, b) == ("divine", "chaos"):
                return [{"hour": t0 + i * 3600, "rate": 50.0 + i} for i in range(6)]
            if (a, b) == ("divine", "exalted"):
                return [{"hour": t0 + i * 3600, "rate": 600.0 - i * 20} for i in range(6)]
            return []
        monkeypatch.setattr(arb._board_mod.digest, "pair_history", hist)
        by = {r["id"]: r for r in client.get("/api/board?window_h=24&nums=divine:exalted").json()["rows"]}
        assert by["divine"]["pref_num"] == "chaos"           # the default is unchanged
        assert by["divine"]["trend_num"] == "exalted" and abs(by["divine"]["change_pct"] + 100 / 6) < 1e-9
        by = {r["id"]: r for r in client.get("/api/board?window_h=24&nums=divine:divine,chaos:nope").json()["rows"]}
        assert by["divine"]["trend_num"] == "chaos"          # a pick it can't price falls back
    finally:
        _teardown()


def test_bid_ask_and_source_describe_the_shown_market(monkeypatch):
    """Once the card's own market prices it, its bid/ask come from THAT market's edges (scaled
    into reference units by the client's factor, so `value / factor` is the market's own
    bid/ask), not from the reference market."""
    g = _graph(monkeypatch)
    try:
        b = client.get("/api/board?window_h=24").json()
        d = {r["id"]: r for r in b["rows"]}["divine"]
        factor = b["prices"]["chaos"]                        # what the client divides by
        assert abs(d["sell"] / factor - 55.0) < 1e-9         # the divine→chaos edge
        assert abs(d["buy"] / factor - 55.0) < 1e-9          # the chaos→divine edge, inverted
        assert d["source"] == "live"
    finally:
        _teardown()


# ------------------------------------------------------------------ the same table everywhere else
def test_convert_loss_is_measured_against_the_pairs_market(monkeypatch):
    """`loss_pct` compares what the route delivers with the have↔want market, not with a cross."""
    from app import arbitrage as arb
    g = _graph(monkeypatch)
    try:
        direct = arb.convert("divine", "chaos", 1)["direct"]
        assert direct["path"] == ["divine", "chaos"] and direct["out"] == 55
        assert abs(direct["loss_pct"]) < 1e-9                # sold at exactly the market rate
        assert "gain_cross_pct" in direct
    finally:
        _teardown()


def test_sales_ledger_carries_a_reference_price_for_every_sale_currency(monkeypatch):
    """Sales prices come from the same table, so the Sales total agrees with the board and the
    top bar."""
    from app import db as _db
    g = _graph(monkeypatch)
    try:
        monkeypatch.setattr(_db, "sales_list", lambda _l=None: [
            {"item_id": "a", "time": "2026-09-18T00:00:00Z", "league": "L", "price": {"amount": 3, "currency": "chaos"}, "item": {}},
            {"item_id": "b", "time": "2026-09-18T00:00:00Z", "league": "L", "price": {"amount": 1, "currency": "divine"}, "item": {}},
        ])
        monkeypatch.setattr(_db, "sales_leagues", lambda: ["L"])
        res = client.get("/api/sales").json()
        V = g.values()
        assert res["prices"]["chaos"] == V["chaos"] and res["prices"]["divine"] == V["divine"]
    finally:
        _teardown()


# ------------------------------------------------------------------ the zoomed card's two sources
def test_asset_modal_is_one_source_in_the_shown_numeraire(monkeypatch):
    """An asset the exchange does NOT trade is served from the poe2scout dailies, expressed in the
    numeraire the card is shown in by dividing by THAT currency's dailies. An omen flat in Divine
    while Divine rose vs Exalted reads 0% in Divine, not +25%.

    Both series are median-smoothed exactly as the Hold board smooths them (movers._median3 /
    holdscore._smooth), so a card and a Hold row never disagree about the same asset — one read
    +2,467% where the other read +4,935%. Smoothing damps the ends, so Divine's raw +25% over
    these five closes reads +19.5%."""
    from app import movers
    g = _graph(monkeypatch)
    try:
        t0 = 1_700_000_000
        days = [t0 + i * 86400 for i in range(5)]
        div = [400.0, 420.0, 450.0, 480.0, 500.0]              # divine +25% in exalted
        monkeypatch.setattr(movers, "_current_series", lambda: (
            "PairsLeague",
            {291: [(t, d, 1_000_000) for t, d in zip(days, div)],       # marketseries.ANCHORS id
             2: [(t, 2 * d, 200_000) for t, d in zip(days, div)]},      # the omen: always 2 divine
            {291: ("Divine Orb", "Currency"), 2: ("Omen of Light", "Omen")}))
        res = movers.asset_row("Omen of Light", 24 * 7)
        row = res["row"]
        assert row["source"] == "scout"                          # the exchange doesn't trade it
        assert row["pref_num"] == "divine" and row["trend_num"] == "divine"
        assert all(abs(p["v"] - 2.0) < 1e-9 for p in row["trend"]) and row["change_pct"] == 0.0
        assert "pairs" not in res                                # no second rate in the headline
        # The client's contract: mid / prices[num] is the shown price = the last trend point.
        assert abs(row["mid"] / res["prices"]["divine"] - row["trend"][-1]["v"]) < 1e-9
        # Shown in Exalted, the same asset rose 25%.
        ex = movers.asset_row("Omen of Light", 24 * 7, "exalted")["row"]
        assert ex["trend_num"] == "exalted" and abs(ex["change_pct"] - 19.5) < 0.05
        # An anchor missing the asset's latest day carries its previous close forward.
        monkeypatch.setattr(movers, "_current_series", lambda: (
            "PairsLeague",
            {291: [(t, d, 1_000_000) for t, d in zip(days[:-1], div[:-1])],
             2: [(t, 2 * d, 200_000) for t, d in zip(days, div)]},
            {291: ("Divine Orb", "Currency"), 2: ("Omen of Light", "Omen")}))
        late = movers.asset_row("Omen of Light", 24 * 7)
        assert late["prices"]["divine"] == 480.0 and late["row"]["pref_num"] == "divine"
        # the carried-forward day lifts the omen to 1000/480 = 2.083, damped by the smoothing to
        # the median of it and the day before (2.0)
        assert abs(late["row"]["trend"][-1]["v"] - (2 + 1000 / 480) / 2) < 1e-9
    finally:
        _teardown()


def test_an_exchange_asset_is_served_from_the_exchange_not_the_dailies(monkeypatch):
    """The same modal for something the exchange DOES trade: this hour's price from the one table,
    not yesterday's close (Preserved Cranium read 17.53 on Hold and 15.71 on the Board because the
    modal served a ~30h-old daily close)."""
    from app import arbitrage as arb, movers
    g = _graph(monkeypatch)
    try:
        t0 = 1_700_000_000
        monkeypatch.setattr(arb._board_mod.digest, "pair_history",
                            lambda _l, a, b, h: ([{"hour": t0 + i * 3600, "rate": 50.0 + i} for i in range(6)]
                                                 if (a, b) == ("divine", "chaos") else []))
        monkeypatch.setattr(movers, "_current_series", lambda: (
            "PairsLeague", {291: [(t0, 1.0, 1.0)]}, {291: ("Divine Orb", "Currency")}))
        row = movers.asset_row("Divine Orb", 24)["row"]
        assert row["source"] in ("live", "digest") and row["id"] == "divine"
        assert abs(row["mid"] - g.values()["divine"]) < 1e-9
        assert row["trend_num"] == "chaos" and abs(row["change_pct"] - 10.0) < 1e-9
    finally:
        _teardown()


# ------------------------------------------------------------------ what the review found
def test_own_market_survives_a_spread(monkeypatch):
    """Which market prices a card is `Graph.priced_by`'s answer, not a float identity. Live books
    quote each direction independently, so a 1.8% spread used to read as "this is not the market
    that prices it" and the card silently fell back to the reference market for its bid/ask,
    source, freshness AND its line — on exactly the liquid pairs that matter most."""
    from app import arbitrage as arb
    g = _graph(monkeypatch)
    try:
        g.add(_edge("chaos", "divine", 1 / 56.0, 20_000, vol=150_000))   # 1.8% off the other side
        t0 = 1_700_000_000
        monkeypatch.setattr(arb._board_mod.digest, "pair_history",
                            lambda _l, a, b, h: ([{"hour": t0 + i * 3600, "rate": 50.0 + i} for i in range(6)]
                                                 if (a, b) == ("divine", "chaos") else []))
        d = {r["id"]: r for r in client.get("/api/board?window_h=24").json()["rows"]}["divine"]
        assert g.priced_by["divine"] == "chaos"
        assert d["trend_num"] == "chaos" and abs(d["change_pct"] - 10.0) < 1e-9
        assert d["source"] == "live" and d["sell"] is not None
    finally:
        _teardown()


def test_a_stale_conversion_leg_does_not_fake_a_line(monkeypatch):
    """Converting a line into another currency carries the conversion rate forward over gaps. Past
    a few hours that is not trading any more, and the "converted" line would be the first leg
    scaled by a constant — reporting the first leg's move as the move in the shown currency."""
    from app import arbitrage as arb
    g = _graph(monkeypatch)
    try:
        t0 = 1_700_000_000
        fresh = [{"hour": t0 + i * 3600, "rate": 50.0 + i} for i in range(24)]     # regal↔chaos, hourly
        stale = [{"hour": t0, "rate": 10.0}]                                       # chaos↔exalted: one point
        def hist(_l, a, b, _h):
            if (a, b) == ("regal", "chaos"):
                return fresh
            if (a, b) == ("chaos", "exalted"):
                return stale
            return []
        monkeypatch.setattr(arb._board_mod.digest, "pair_history", hist)
        r = {x["id"]: x for x in client.get("/api/board?window_h=24&nums=regal:exalted").json()["rows"]}["regal"]
        # Only the hours the stale leg can honestly cover are drawn; the rest is not invented.
        assert all(p["t"] <= t0 + arb._board_mod.CARRY_MAX_H * 3600 for p in r["trend"])
    finally:
        _teardown()


def test_hold_never_reports_a_return_against_the_wrong_currency(monkeypatch):
    """A Hold board labelled "vs Divine" must not take its return from a card whose line fell back
    to the reference: Exalted inflates over a league, so those rows would rank on that alone."""
    from app import holdscore, movers
    g = _graph(monkeypatch)
    try:
        # two assets, both flat in Divine; their cards' lines are in different currencies
        cur = {7: {a: (2.0, 1e9) for a in range(6)},      # "Right": card line in divine
               8: {a: (3.0, 1e9) for a in range(6)}}      # "Wrong": card line fell back to exalted
        meta = {291: ("Divine Orb", "Currency"), 7: ("Right", "Currency"), 8: ("Wrong", "Currency")}
        monkeypatch.setattr(holdscore, "build_context", lambda num_id: ("PairsLeague", cur, [], meta))
        monkeypatch.setattr(holdscore, "_arc_weights", lambda _lg: None)
        monkeypatch.setattr(movers, "exchange_cards", lambda names, w, num=None: {
            "Right": {"change_pct": 11.0, "trend_num": num, "source": "digest"},
            "Wrong": {"change_pct": 25.0, "trend_num": "exalted", "source": "digest"}})
        holdscore.invalidate()
        rows = {a["name"]: a for a in holdscore.leaderboard("3d", "all", "divine")["assets"]}
        assert abs(rows["Right"]["ret_pct"] - 11.0) < 1e-6          # measured in divine: used
        assert abs(rows["Wrong"]["ret_pct"] - 25.0) > 1e-6          # measured in exalted: not used
        assert abs(rows["Wrong"]["ret_pct"]) < 1e-6                 # falls back to the daily series
    finally:
        holdscore.invalidate()
        _teardown()


def test_a_card_shown_in_a_currency_that_does_not_price_it_still_draws_that_currency(monkeypatch):
    """Regal is priced through Chaos and Divine through Chaos, so neither prices the other. Shown
    in Divine, Regal's line must still be regal-in-divine, built from both pricing chains hour by
    hour — not the reference market's line (a Preserved Cranium priced in Chaos drew its thin
    Exalted market at −19.9% while its own markets moved −17.2% and −18.2%)."""
    from app import arbitrage as arb
    g = _graph(monkeypatch)
    try:
        t0 = 1_700_000_000
        def hist(_l, a, b, _h):
            if (a, b) == ("regal", "chaos"):                       # regal: 0.20 → 0.24 chaos (+20%)
                return [{"hour": t0 + i * 3600, "rate": 0.20 + i * 0.008} for i in range(6)]
            if (a, b) == ("divine", "chaos"):                      # divine: 50 → 55 chaos (+10%)
                return [{"hour": t0 + i * 3600, "rate": 50.0 + i} for i in range(6)]
            if (a, b) == ("chaos", "exalted"):
                return [{"hour": t0 + i * 3600, "rate": 10.0} for i in range(6)]
            return []
        monkeypatch.setattr(arb._board_mod.digest, "pair_history", hist)
        r = {x["id"]: x for x in client.get("/api/board?window_h=24&nums=regal:divine").json()["rows"]}["regal"]
        assert r["trend_num"] == "divine", r["trend_num"]
        # regal/divine over the window: (0.24/55) / (0.20/50) - 1 = +9.1%
        assert abs(r["change_pct"] - 9.1) < 0.2, r["change_pct"]
        assert abs(r["trend"][-1]["v"] - 0.24 / 55.0) < 1e-9
    finally:
        _teardown()


def test_a_daily_only_mover_agrees_with_the_card_it_opens(monkeypatch):
    """Movers falls back to poe2scout dailies for what the exchange doesn't trade. It must smooth
    them the same way the card does, or the row and the card disagree for the same asset."""
    from app import movers
    g = _graph(monkeypatch)
    try:
        t0 = 1_700_000_000
        days = [t0 + i * 86400 for i in range(6)]
        px = [100.0, 104.0, 180.0, 108.0, 112.0, 120.0]        # one spiky day in the middle
        monkeypatch.setattr(movers, "_current_series", lambda: (
            "PairsLeague", {9: [(t, v, 5e8) for t, v in zip(days, px)]}, {9: ("Thingy", "Currency")}))
        movers._cache.clear(); movers._movers_cache.clear()
        row = next(a for a in movers.top_movers(24 * 5, 5, 0.0, "up")["assets"] if a["name"] == "Thingy")
        card = movers.asset_row("Thingy", 24 * 5, row["num"])["row"]
        assert card["source"] == "scout"
        assert abs(card["change_pct"] - row["change_pct"]) < 0.6, (row["change_pct"], card["change_pct"])
    finally:
        movers._cache.clear(); movers._movers_cache.clear()
        _teardown()


# ------------------------------------------------------------------ inactive markets (owner, 2026-09-19)
def _mkt(g, a, b, rate, vol, inactive=False, stock=10_000):
    g.add(Edge(a, b, "digest", rate, [{"rate": rate, "stock": stock}], age_s=0.0,
               vol_in_per_h=vol, meta={"inactive": inactive}))


def test_a_thin_inactive_market_never_outranks_a_deep_one(monkeypatch):
    """An item trades steadily against Divine (14.7 div) and barely against Exalted, where the
    hours that did trade disagree wildly — that market is inactive. The deep market prices it:
    pricing it off the thin one read a Preserved Cranium at 3.33 divine."""
    g = _graph(monkeypatch)
    try:
        _mkt(g, "thing", "divine", 14.7, 60)          # deep: ~60 things/h against divine
        _mkt(g, "divine", "thing", 1 / 14.7, 900)
        _mkt(g, "thing", "exalted", 4_000, 1.2, inactive=True)     # thin, and its hours disagree
        _mkt(g, "exalted", "thing", 1 / 4_000, 3_000, inactive=True)
        V = g.values()
        assert g.priced_by["thing"] == "divine", g.priced_by.get("thing")
        assert abs(V["thing"] / V["divine"] - 14.7) < 1e-6, V["thing"] / V["divine"]
    finally:
        _teardown()


def test_an_inactive_market_cannot_drag_a_value_down(monkeypatch):
    """Same shape, but the inactive market is wildly cheap (a lone sparse hour). It must not
    price the item, and it must not become the yardstick that discredits the real markets —
    Tecrod's Gaze went from 12 divine to 6.6 that way, and then to no price at all."""
    g = _graph(monkeypatch)
    try:
        _mkt(g, "thing", "divine", 12.0, 65)
        _mkt(g, "divine", "thing", 1 / 12.0, 790)
        _mkt(g, "thing", "chaos", 105.9, 22)
        _mkt(g, "chaos", "thing", 1 / 105.9, 2_100)
        _mkt(g, "thing", "exalted", 87.5, 1.4, inactive=True)      # 65x below its real price
        _mkt(g, "exalted", "thing", 1 / 87.5, 3_500, inactive=True)
        V = g.values()
        assert g.priced_by["thing"] == "divine", g.priced_by.get("thing")
        assert abs(V["thing"] / V["divine"] - 12.0) < 1e-6, V["thing"] / V["divine"]
    finally:
        _teardown()
