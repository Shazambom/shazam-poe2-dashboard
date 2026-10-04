"""The Stash page and the capital Arbitrage may use (owner, 2026-10-03).

* Arbitrage trades only from liquid currencies: the default cash (Chaos, Exalted, Divine) plus the
  market's hubs, a wider set than the Board's ⬢ (top ARBITRAGE_HUBS, never fewer than `hub_count`).
  The Stash total still counts every holding; only what the route search may start from shrinks.
* Holdings are grouped by the game's own Currency Exchange category (gamedata's `gold_fees_meta`),
  never a hand-written list; an item the exchange doesn't list keeps the trade site's category.
* Each group's icon is its most-traded item (executed value per hour), derived from the market.

Synthetic graphs, no DB (mirrors test_liquidity.py / test_centrality.py).

    python -m pytest backend/tests/test_stash.py -q
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import arbitrage, db, liquidity, settings  # noqa: E402
from app.arbitrage import Edge, Graph, routes  # noqa: E402
from app.currencies import Currency, Registry  # noqa: E402


def _edge(a, b, rate, vol, stock=10_000_000):
    return Edge(a, b, "live", rate, [{"rate": rate, "stock": stock}], age_s=0.0, vol_in_per_h=vol)


def _market(n=14, hub_count=None):
    """`n` currencies c0..c{n-1}, each trading both ways with exalted, volume falling with the index,
    so PageRank ranks exalted first, then c0, c1, … in order."""
    s = {"gold_model": {}, "reference": "exalted", "league": "T", "step_overhead_min": 0, "max_steps": 3,
         "filters": {}, "max_start_fraction": 1.0}
    if hub_count is not None:
        s["hub_count"] = hub_count
    g = Graph(s)
    g.fee_table = {}
    for i in range(n):
        vol = 1000.0 * (n - i)
        g.add(_edge(f"c{i}", "exalted", 2.0, vol))
        g.add(_edge("exalted", f"c{i}", 0.5, vol * 2))
    return g


# ------------------------------------------------------------------ what arbitrage may use
def test_arbitrage_currencies_are_the_cash_plus_the_top_ten_hubs():
    g = _market()
    use = arbitrage.arbitrage_currencies(g, g.ref_values())
    assert {"chaos", "exalted", "divine"} <= use, "the default cash is always usable, traded here or not"
    assert {"c0", "c8"} <= use, "the most central markets are hubs"
    assert "c9" not in use and "c13" not in use, "only the top 10 hubs (exalted + c0..c8)"
    assert len(use - {"chaos", "divine"}) == routes.ARBITRAGE_HUBS


def test_arbitrage_never_uses_fewer_hubs_than_the_board_shows():
    g = _market(hub_count=12)
    use = arbitrage.arbitrage_currencies(g, g.ref_values())
    assert "c10" in use and "c11" not in use, "hub_count 12 → exalted + c0..c10"


def test_route_search_starts_only_from_usable_holdings(monkeypatch):
    g = _market()
    monkeypatch.setattr(arbitrage.graph, "cached_graph", lambda: g)
    monkeypatch.setattr(db, "get_capital", lambda: {"chaos": 10.0, "c0": 3.0, "c13": 5.0})
    _, _, _, _, capital, starts, notional = routes._search_setup(None, None)
    assert capital == {"chaos": 10.0, "c0": 3.0}, "a non-hub holding is not arbitrage capital"
    assert sorted(starts) == ["c0", "chaos"] and notional is False


def test_holding_nothing_usable_searches_notionally_from_usable_currencies_only(monkeypatch):
    g = _market()
    monkeypatch.setattr(arbitrage.graph, "cached_graph", lambda: g)
    monkeypatch.setattr(db, "get_capital", lambda: {"c13": 5.0})
    _, _, _, _, capital, starts, notional = routes._search_setup(None, None)
    assert capital == {} and notional is True
    assert set(starts) == arbitrage.arbitrage_currencies(g, g.ref_values()) & set(g.adj), \
        "a notional search still starts only where arbitrage may trade"
    assert "c13" not in starts


def test_capital_rows_flag_arbitrage_capital_and_keep_every_holding_in_the_total():
    g = _market()
    rv = g.ref_values()
    out = liquidity.capital_rows({"exalted": 10.0, "c0": 1.0, "c13": 1.0}, g, rv)
    flags = {r["currency"]: r["arbitrage"] for r in out["rows"]}
    assert flags == {"exalted": True, "c0": True, "c13": False}
    assert out["total_ref"] == pytest.approx(10.0 + rv["c0"] + rv["c13"]), "the stash total counts everything"


def test_capital_rows_flag_cash_while_syncing():
    s = {"gold_model": {}, "reference": "exalted", "league": "T", "max_steps": 3}
    g = Graph(s)
    g.values = lambda: {"exalted": 1.0, "chaos": 60.0, "vaal": 7.0}
    out = liquidity.capital_rows({"chaos": 2.0, "vaal": 1.0}, g, g.values())
    assert out["syncing"] is True
    assert {r["currency"]: r["arbitrage"] for r in out["rows"]} == {"chaos": True, "vaal": False}


# ------------------------------------------------------------------ groups: the game's own category
def _reg(*currencies):
    r = Registry()
    r.by_id = {c.id: c for c in currencies}
    return r


def test_group_is_the_games_exchange_category_not_the_trade_sites():
    shard = Currency(id="raven-touched-shard", name="Raven-Touched Shard", category="Ritual",
                     metadata_ids=["Metadata/Items/Currency/RavenShard"])
    light = Currency(id="omen-of-light", name="Omen of Light", category="Ritual",
                     metadata_ids=["Metadata/Items/Currency/OmenOnAnnulRemoveAbyssMod"])
    whittling = Currency(id="omen-of-whittling", name="Omen of Whittling", category="Ritual",
                         metadata_ids=["Metadata/Items/Currency/OmenOnChaosLowestLevelMod"])
    cats = {"Metadata/Items/Currency/RavenShard": "Delirium",
            "Metadata/Items/Currency/OmenOnAnnulRemoveAbyssMod": "Abyss",
            "Metadata/Items/Currency/OmenOnChaosLowestLevelMod": "Ritual"}
    groups = _reg(shard, light, whittling).groups(cats)
    assert groups == {"raven-touched-shard": "Delirium", "omen-of-light": "Abyss", "omen-of-whittling": "Ritual"}


def test_an_item_the_exchange_does_not_list_keeps_the_trade_sites_category():
    way = Currency(id="waystone-16", name="Waystone (Tier 16)", category="Waystones", metadata_ids=[])
    rune = Currency(id="legacy-of-kingsguard", name="Legacy of Kingsguard", category="Runes",
                    metadata_ids=["Metadata/Items/SoulCores/Legacy"])
    assert _reg(way, rune).groups({}) == {"waystone-16": "Waystones", "legacy-of-kingsguard": "Runes"}


def test_currencies_payload_carries_the_group():
    c = Currency(id="omen-of-light", name="Omen of Light", category="Ritual", metadata_ids=["M/Light"])
    out = _reg(c).to_json(categories={"M/Light": "Abyss"})
    assert out["currencies"][0]["group"] == "Abyss"
    assert out["currencies"][0]["category"] == "Ritual", "the trade site's label is still served as before"


# ------------------------------------------------------------------ group icon: most-traded item
def test_group_icon_is_the_most_traded_item_in_the_group():
    g = _market(n=4)                     # c0 trades the most, c3 the least
    rv = g.ref_values()
    icons = liquidity.group_icons(g, rv, {"c0": "Ritual", "c1": "Ritual", "c2": "Abyss", "c3": "Abyss",
                                          "exalted": "Currency"})
    assert icons == {"Ritual": "c0", "Abyss": "c2", "Currency": "exalted"}


def test_a_group_with_no_traded_item_has_no_icon():
    g = _market(n=1)
    icons = liquidity.group_icons(g, g.ref_values(), {"c0": "Ritual", "never-traded": "Idols"})
    assert "Idols" not in icons and icons["Ritual"] == "c0"


def test_capital_endpoint_serves_group_icons(monkeypatch):
    from app import main
    g = _market(n=2)
    monkeypatch.setattr(arbitrage, "cached_graph", lambda: g)
    monkeypatch.setattr(db, "get_capital", lambda: {"c0": 1.0})
    monkeypatch.setattr(main.registry, "groups", lambda categories=None: {"c0": "Ritual", "c1": "Ritual"})
    assert main.capital()["group_icons"] == {"Ritual": "c0"}


# ------------------------------------------------------------------ the counted-toward-liquid choices
def test_counted_choices_default_empty_and_merge_per_currency():
    assert settings.DEFAULTS["stash_counted"] == {}
    merged = settings._merged({"stash_counted": {"vaal": False}})
    assert merged["stash_counted"] == {"vaal": False}


# ------------------------------------------------------------------ QA pass 1 (2026-10-03)
def test_a_hub_that_is_not_cash_is_worth_its_market_rate_not_its_own_count():
    """Omen of Whittling is a hub (Board ⬢) but not cash: its Stash row showed no worth because a hub's
    native amount was its own quantity. Only the default cash (and the reference) are their own money."""
    g = _market()
    rv = g.ref_values()
    out = liquidity.capital_rows({"c0": 3.0, "chaos": 2.0}, g, rv)
    row = {r["currency"]: r for r in out["rows"]}
    assert row["c0"]["native"]["cur"] != "c0", "c0 is a top hub but not cash: priced in its market"
    assert row["c0"]["native"]["amount"] == pytest.approx(3.0 * rv["c0"] / rv[row["c0"]["native"]["cur"]], rel=0.05)
    assert row["chaos"]["native"] == {"amount": 2.0, "cur": "chaos"}


# ------------------------------------------------------------------ code review (2026-10-03)
def test_a_saved_start_arbitrage_may_not_use_falls_back_to_what_it_may(monkeypatch):
    """A "Start from" saved before the rule (or a hub that has since dropped out of the top) used to
    search with zero budget and show no loops, with the dropdown claiming "Everything I hold"."""
    g = _market()
    monkeypatch.setattr(arbitrage.graph, "cached_graph", lambda: g)
    monkeypatch.setattr(db, "get_capital", lambda: {"chaos": 10.0, "c0": 3.0, "c13": 5.0})
    _, _, _, _, _, starts, notional = routes._search_setup(None, ["c13"])
    assert sorted(starts) == ["c0", "chaos"] and notional is False
    _, _, _, _, _, starts, _ = routes._search_setup(None, ["c0"])
    assert starts == ["c0"], "a usable start is honoured"


def test_a_sale_that_costs_more_gold_than_it_fetches_realizes_nothing_not_a_negative():
    s = {"gold_model": {"base_per_order": 0, "per_unit": {}, "per_ref_unit": 10, "fee_side": "buy"},
         "reference": "exalted", "league": "T", "step_overhead_min": 0, "max_steps": 3}
    g = Graph(s)
    g.fee_table = {"exalted": 500}                    # gold per exalted received, far above its worth
    g.add(_edge("cheap", "exalted", 0.5, 1000.0))
    g.add(_edge("exalted", "cheap", 2.0, 1000.0))
    rv = g.ref_values()
    r = liquidity.realizable(g, rv, "cheap", 10, cash={"exalted"}, gold_value_per_1k=10.0)
    assert r["realizable_ref"] is not None and r["realizable_ref"] >= 0.0
    assert r["ghost_ref"] <= r["paper_ref"]


def test_pagerank_is_computed_once_per_graph_and_redone_when_it_changes(monkeypatch):
    from app import centrality
    g = _market()
    rv = g.ref_values()
    calls = []
    real = centrality._rank
    monkeypatch.setattr(centrality, "_rank", lambda *a: (calls.append(1), real(*a))[1])
    a = centrality.hubs(g, rv, 5)
    b = centrality.hubs(g, rv, 10)
    assert len(calls) == 1 and a <= b
    g.add(_edge("zz", "exalted", 1.0, 10_000_000.0))
    g.add(_edge("exalted", "zz", 1.0, 10_000_000.0))
    assert "zz" in centrality.hubs(g, rv, 5) and len(calls) == 2


def test_traded_value_is_public_and_ranks_the_group_icon():
    from app import centrality
    g = _market(n=3)
    tv = centrality.traded_value(g, g.ref_values())
    assert tv["c0"] > tv["c1"] > tv["c2"] > 0


def test_game_categories_come_from_one_accessor(monkeypatch):
    from app import gamedata
    monkeypatch.setattr(db, "kv_get", lambda k, d=None: {"M/a": {"category": "Abyss", "fee": 1}, "M/b": {"fee": 2}}
                        if k == "gold_fees_meta" else d)
    assert gamedata.categories() == {"M/a": "Abyss"}
    c = Currency(id="a", name="A", category="Ritual", metadata_ids=["M/a"])
    assert _reg(c).groups() == {"a": "Abyss"}


# ------------------------------------------------------------------ switched off on Stash (owner, 2026-10-03)
def test_a_holding_switched_off_on_stash_is_not_arbitrage_capital(monkeypatch):
    """"If I mark something as not liquid in my stash tab that shouldn't be visible to the arbitrage page
    anymore." A holding counts until the user switches it off (settings `stash_counted`)."""
    g = _market()
    _switches(monkeypatch, {"chaos": False, "c0": True})
    monkeypatch.setattr(arbitrage.graph, "cached_graph", lambda: g)
    monkeypatch.setattr(db, "get_capital", lambda: {"chaos": 10.0, "c0": 3.0, "exalted": 5.0})
    _, _, _, _, capital, starts, _ = routes._search_setup(None, None)
    assert capital == {"c0": 3.0, "exalted": 5.0}
    assert "chaos" not in starts
    _, _, _, _, _, starts, _ = routes._search_setup(None, ["chaos"])
    assert "chaos" not in starts, "a saved Start from that was switched off falls back too"


def test_capital_rows_do_not_offer_a_switched_off_holding_to_arbitrage_but_still_count_it(monkeypatch):
    g = _market()
    _switches(monkeypatch, {"exalted": False})
    out = liquidity.capital_rows({"exalted": 10.0, "c0": 1.0}, g, g.ref_values())
    flags = {r["currency"]: r["arbitrage"] for r in out["rows"]}
    assert flags == {"exalted": False, "c0": True}
    assert out["total_ref"] == pytest.approx(10.0 + g.ref_values()["c0"])


def test_counted_by_default_is_one_rule_served_to_the_client():
    assert settings.STASH_COUNTED_BY_DEFAULT is True
    assert settings.stash_counted({}, "vaal") is True
    assert settings.stash_counted({"stash_counted": {"vaal": False}}, "vaal") is False
    assert settings.stash_counted({"stash_counted": {"vaal": None}}, "vaal") is True
    g = _market(n=2)
    out = liquidity.capital_rows({"c0": 1.0}, g, g.ref_values())
    assert out["counted_by_default"] is settings.STASH_COUNTED_BY_DEFAULT, "the client takes the default from here"
    js = (Path(__file__).resolve().parents[2] / "frontend/src/lib/stash.js").read_text()
    assert "const COUNTED_BY_DEFAULT" not in js, "no second copy of the default"


# ------------------------------------------------------------------ code review 2 (2026-10-03)
def _switches(monkeypatch, counted):
    """The user's saved Stash switches, as settings.get_settings() reads them now."""
    real = settings.get_settings
    monkeypatch.setattr(settings, "get_settings", lambda: {**real(), "stash_counted": counted})


def test_a_switch_takes_effect_on_a_graph_built_before_it(monkeypatch):
    """The switch is read when a search runs, not from the graph's copy of the settings — a graph built
    a moment before the flip (another request was building it) must not bring the old switch back."""
    g = _market()
    g.s["stash_counted"] = {}                       # the graph was built before the flip
    _switches(monkeypatch, {"chaos": False})
    monkeypatch.setattr(arbitrage.graph, "cached_graph", lambda: g)
    monkeypatch.setattr(db, "get_capital", lambda: {"chaos": 10.0, "exalted": 5.0})
    assert routes._search_setup(None, None)[4] == {"exalted": 5.0}
    rows = {r["currency"]: r["arbitrage"] for r in liquidity.capital_rows({"chaos": 1.0}, g, g.ref_values())["rows"]}
    assert rows == {"chaos": False}


def test_route_results_are_cached_per_set_of_switches(monkeypatch):
    _switches(monkeypatch, {})
    a = routes._cache_key(None, None)
    _switches(monkeypatch, {"chaos": False})
    b = routes._cache_key(None, None)
    _switches(monkeypatch, {"chaos": None})
    assert a != b and routes._cache_key(None, None) == a, "a cleared switch is the same search as never switched"


def test_a_switch_flip_keeps_the_market_caches(monkeypatch):
    """Route results are keyed on the switches and capital is not cached, so a flip needs no graph rebuild."""
    from app import main
    dropped = []
    monkeypatch.setattr(arbitrage, "invalidate_caches", lambda: dropped.append(1))
    monkeypatch.setattr(main, "save_settings", lambda p: p)
    main.put_settings(main.SettingsPatch(patch={"stash_counted": {"vaal": False}}))
    assert dropped == []
    main.put_settings(main.SettingsPatch(patch={"hub_count": 6}))
    assert dropped == [1]


def test_one_rule_decides_what_arbitrage_may_start_from(monkeypatch):
    g = _market()
    _switches(monkeypatch, {"c0": False})
    rv = g.ref_values()
    use = arbitrage.loop_currencies(g, rv)
    assert "c0" not in use and "c1" in use and "chaos" in use
    assert arbitrage.loop_currencies(g, rv, base=set(arbitrage.CASH)) == set(arbitrage.CASH)
