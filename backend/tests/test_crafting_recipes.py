"""Crafting recipes in route search (docs/bugs/2026-09-29-crafting-recipes-missing-from-routes.md).

Two kinds of conversion are route steps besides the user's own recipes.json:
- Reforge (the Reforging Bench's "Three to One" list): derived on shazam from poe2db's
  Reforging_Bench page into kv_ops `bench_recipes`, which rides the seed. Essences are left out: the
  bench turns 3 essences into a RANDOM essence (maxroll), so it is no fixed conversion.
- Disenchant: INTENDED behaviour, confirmed in-game by the owner 2026-09-30. A Greater orb disenchants
  into 3 of its normal orb, and a Perfect orb into 3 Greater. Orbs only: Jeweller's Orbs and runes do
  not disenchant. Derived in the app from the currency names; it needs no data.

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_crafting_recipes.py -q
"""
import gzip
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import modpool  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures" / "mods"


def _bench_page() -> str:
    with gzip.open(FIX / "reforging-bench.html.gz", "rt", encoding="utf-8") as f:
        return f.read()


# ------------------------------------------------------------------ the bench page (shazam)
def test_the_bench_page_parses_into_its_three_to_one_list():
    rows = modpool.bench_recipes_from(_bench_page())
    assert len(rows) == 93
    assert {"from": "Lesser Desert Rune", "from_qty": 3, "to": "Desert Rune", "to_qty": 1} in rows
    assert {"from": "Desert Rune", "from_qty": 3, "to": "Greater Desert Rune", "to_qty": 1} in rows
    assert {"from": "Diluted Liquid Ire", "from_qty": 3, "to": "Diluted Liquid Guilt", "to_qty": 1} in rows
    assert {"from": "Waystone (Tier 14)", "from_qty": 3, "to": "Waystone (Tier 15)", "to_qty": 1} in rows
    assert not any("Amulet" in r["to"] for r in rows), "the Equip / X of a Kind tables are not the 3-to-1 list"


def test_a_page_without_the_list_or_with_a_changed_layout_gives_nothing():
    assert modpool.bench_recipes_from("<html><body>no table</body></html>") == []
    changed = _bench_page().replace("<th>From</th><th>To</th>", "<th>Input</th><th>Output</th>")
    assert modpool.bench_recipes_from(changed) == [], "never a wrong recipe from a table we do not recognise"


def _fake_sources(monkeypatch, bench_page):
    """refresh() with every source served from the fixtures: the RePoE export, the stackable list and
    the bench page (the grant pages answer with no table)."""
    from app import gamedata
    repoe = {f"repoe-{f}": FIX / f"{f.removesuffix('.min.json').removesuffix('.json')}{'.min' if f.endswith('.min.json') else ''}.json.gz"
             for f in modpool.REPOE_FILES}

    async def fake_get(url, name, max_age):
        with gzip.open(repoe[name], "rb") as f:
            return f.read()

    async def fake_page(slug, max_age):
        if slug == "Stackable_Currency":
            return (FIX / "stackable.html").read_text()
        if slug == "Reforging_Bench":
            return bench_page
        return "<html><body>no table</body></html>"

    monkeypatch.setattr(gamedata, "_get", fake_get)
    monkeypatch.setattr(modpool, "_page", fake_page)


@pytest.fixture
def no_bench_after():
    from app import db
    yield
    db.kv_set("bench_recipes", [])       # other tests' graphs must not see this list


def test_refresh_stores_the_bench_list_and_keeps_the_last_good_one(monkeypatch, no_bench_after):
    import asyncio
    from app import db
    _fake_sources(monkeypatch, _bench_page())
    asyncio.run(modpool.refresh(force=True))
    stored = db.kv_get("bench_recipes")
    assert len(stored) == 93 and {"from": "Liquid Paranoia", "from_qty": 3, "to": "Liquid Envy", "to_qty": 1} in stored
    _fake_sources(monkeypatch, "<html><body>poe2db changed</body></html>")
    state = asyncio.run(modpool.refresh(force=True))
    assert db.kv_get("bench_recipes") == stored, "an unreadable page never replaces the last good list"
    assert "bench" in (state.get("last_error") or ""), "the cron sees the failure (exit 1), never a silent keep"


def test_the_bench_list_rides_the_seed():
    from app import datapolicy
    assert not datapolicy.is_user_kv("bench_recipes"), "operational kv lands in kv_ops, which ships in the seed"
    assert "kv_ops" in datapolicy.SEED_TABLES


# ------------------------------------------------------------------ the recipes (every install)
# Names as the trade site lists them (registry names), trade ids as it keys them.
NAMES = {
    "Orb of Augmentation": "aug", "Greater Orb of Augmentation": "greater-orb-of-augmentation",
    "Perfect Orb of Augmentation": "perfect-orb-of-augmentation",
    "Chaos Orb": "chaos", "Greater Chaos Orb": "greater-chaos-orb", "Perfect Chaos Orb": "perfect-chaos-orb",
    "Lesser Jeweller's Orb": "lesser-jewellers-orb", "Greater Jeweller's Orb": "greater-jewellers-orb",
    "Perfect Jeweller's Orb": "perfect-jewellers-orb",
    "Desert Rune": "desert-rune", "Greater Desert Rune": "greater-desert-rune", "Perfect Desert Rune": "perfect-desert-rune",
    "Essence of Ice": "essence-of-ice", "Greater Essence of Ice": "greater-essence-of-ice",
    "Perfect Essence of Ice": "perfect-essence-of-ice",
    "Flux": "flux", "Perfect Flux": "perfect-flux",
    "Lesser Desert Rune": "lesser-desert-rune", "Liquid Paranoia": "liquid-paranoia", "Liquid Envy": "liquid-envy",
    "Lesser Essence of Ice": "lesser-essence-of-ice",
}


def _pairs(recs):
    return {(next(iter(r["inputs"].items())), next(iter(r["outputs"].items()))) for r in recs}


def test_orbs_disenchant_greater_into_three_normal_and_perfect_into_three_greater():
    """INTENDED (owner, in-game 2026-09-30): a Greater orb gives 3 of its orb; Perfect gives 3 Greater.
    Jeweller's Orbs and runes do not disenchant; essences were never confirmed. Not a bug; do not remove."""
    from app import recipes
    recs = recipes.disenchant_recipes(NAMES)
    assert _pairs(recs) == {
        (("greater-orb-of-augmentation", 1), ("aug", 3)),
        (("perfect-orb-of-augmentation", 1), ("greater-orb-of-augmentation", 3)),
        (("greater-chaos-orb", 1), ("chaos", 3)),
        (("perfect-chaos-orb", 1), ("greater-chaos-orb", 3)),
    }
    assert all(r["kind"] == "disenchant" and r["enabled"] and r["routable"] for r in recs)
    assert len({r["id"] for r in recs}) == len(recs)


def test_the_bench_list_maps_by_name_and_leaves_out_random_outputs_and_unknown_names():
    from app import recipes
    rows = [
        {"from": "Lesser Desert Rune", "from_qty": 3, "to": "Desert Rune", "to_qty": 1},
        {"from": "Liquid Paranoia", "from_qty": 3, "to": "Liquid Envy", "to_qty": 1},
        {"from": "Lesser Essence of Ice", "from_qty": 3, "to": "Essence of Ice", "to_qty": 1},   # random at the bench
        {"from": "Lesser Tempered Rune", "from_qty": 3, "to": "Tempered Rune", "to_qty": 1},    # not on the trade site
    ]
    recs = recipes.reforge_recipes(rows, NAMES)
    assert _pairs(recs) == {(("lesser-desert-rune", 3), ("desert-rune", 1)), (("liquid-paranoia", 3), ("liquid-envy", 1))}
    assert all(r["kind"] == "reforge" for r in recs)


@pytest.fixture
def game_names(monkeypatch):
    """The registry lists NAMES, and the bench list is in kv_ops, as on an install after the seed."""
    from app import db
    from app.currencies import Currency, registry
    monkeypatch.setattr(registry, "by_id", {tid: Currency(id=tid, name=n) for n, tid in NAMES.items()})
    db.kv_set("bench_recipes", [{"from": "Liquid Paranoia", "from_qty": 3, "to": "Liquid Envy", "to_qty": 1}])
    yield
    db.kv_set("bench_recipes", [])


def test_route_edges_are_the_derived_recipes_plus_the_users_own(game_names, tmp_path, monkeypatch):
    import json
    from app import recipes
    path = tmp_path / "recipes.json"
    monkeypatch.setattr(recipes, "RECIPES_PATH", path)
    path.write_text(json.dumps([
        {"id": "mine", "name": "mine", "kind": "combine", "inputs": {"flux": 10}, "outputs": {"perfect-flux": 1}},
        {"id": "disenchant:greater-chaos-orb", "name": "off", "kind": "disenchant", "enabled": False,
         "inputs": {"greater-chaos-orb": 1}, "outputs": {"chaos": 3}},
    ]))
    by = {e["recipe_id"]: e for e in recipes.edges()}
    assert by["disenchant:greater-orb-of-augmentation"] == {
        "from": "greater-orb-of-augmentation", "to": "aug", "rate": 3.0, "lot": 1,
        "recipe_id": "disenchant:greater-orb-of-augmentation", "name": "Disenchant Greater Orb of Augmentation",
        "kind": "disenchant"}
    assert by["reforge:liquid-paranoia"]["rate"] == pytest.approx(1 / 3) and by["reforge:liquid-paranoia"]["lot"] == 3
    assert "mine" in by
    assert "disenchant:greater-chaos-orb" not in by, "the user's own recipe with the same id wins (here: turned off)"
    assert [r["id"] for r in recipes.load()] == ["mine", "disenchant:greater-chaos-orb"], "the editor shows the user's file only"


# ------------------------------------------------------------------ route search
def _market(monkeypatch, rates):
    """Graph.build over a fixture digest: {(a, b): b per a}, deep and busy markets."""
    from app import digest, gamedata
    monkeypatch.setattr(digest, "latest_rates", lambda league, age: {
        k: {"rate": r, "stock": 1_000_000, "age_s": 0.0, "hour": 0, "volume_to": 1_000_000} for k, r in rates.items()})
    monkeypatch.setattr(digest, "pair_volume", lambda league, hours: {k: 100_000.0 for k in rates})
    monkeypatch.setattr(gamedata, "fees", lambda: {"by_trade": {}})


def _loops(filters=None):
    from app import arbitrage
    arbitrage.invalidate_caches()
    res = arbitrage.find_routes(filters or {"min_liquidity_ref": 0, "min_volume_ref_per_h": 0, "max_step_minutes": 0},
                                use_cache=False)     # no capital: a notional search from every currency
    return {tuple(r["path"]): r for r in res["routes"]}


def test_route_search_finds_the_owners_disenchant_loop(game_names, monkeypatch, tmp_path):
    """Buy a Greater Chaos Orb for 2.5 chaos, disenchant it into 3 chaos: +20% a loop. The market's
    own greater->chaos rate (2.4) is worse than the disenchant, so the recipe takes the step, and the
    Greater orb's price stays what its market traded at."""
    from app import arbitrage, recipes
    monkeypatch.setattr(recipes, "RECIPES_PATH", tmp_path / "recipes.json")
    _market(monkeypatch, {("chaos", "greater-chaos-orb"): 1 / 2.5, ("greater-chaos-orb", "chaos"): 2.4,
                          ("chaos", "exalted"): 0.1, ("exalted", "chaos"): 9.9})
    r = _loops()[("chaos", "greater-chaos-orb", "chaos")]
    assert r["uses_recipe"] and r["kinds"] == ["digest", "recipe"]
    assert r["end_amount"] == 3 * (r["start_amount"] * 2 // 5), "whole Greater orbs at 2.5 chaos, 3 chaos each"
    assert r["margin_pct"] > 15
    assert r["steps"][1]["meta"]["kind"] == "disenchant" and r["steps"][1]["out"] == 3 * r["steps"][1]["in"]
    g = arbitrage.cached_graph()
    assert g.traded_rate("greater-chaos-orb", "chaos") == pytest.approx(2.4), "a recipe ratio is never a price"


def test_route_search_finds_a_reforge_loop(game_names, monkeypatch, tmp_path):
    """3 Liquid Paranoia (1 chaos each) reforge into 1 Liquid Envy that sells for 4 chaos: +33%."""
    from app import recipes
    monkeypatch.setattr(recipes, "RECIPES_PATH", tmp_path / "recipes.json")
    _market(monkeypatch, {("chaos", "liquid-paranoia"): 1.0, ("liquid-paranoia", "chaos"): 0.9,
                          ("liquid-envy", "chaos"): 4.0, ("chaos", "liquid-envy"): 1 / 4.5,
                          ("chaos", "exalted"): 0.1, ("exalted", "chaos"): 9.9})   # values them (the cull needs it)
    r = _loops()[("chaos", "liquid-paranoia", "liquid-envy", "chaos")]
    assert r["steps"][1]["meta"]["kind"] == "reforge"
    assert r["start_amount"] % 3 == 0, "the bench takes whole lots of 3"
    assert r["margin_pct"] == pytest.approx(100 * (4 / 3 - 1), abs=0.5)


def test_exchange_steps_only_leaves_every_recipe_out(game_names, monkeypatch, tmp_path):
    from app import recipes
    monkeypatch.setattr(recipes, "RECIPES_PATH", tmp_path / "recipes.json")
    _market(monkeypatch, {("chaos", "greater-chaos-orb"): 1 / 2.5, ("greater-chaos-orb", "chaos"): 2.4})
    assert not any(r["uses_recipe"] for r in _loops({"min_liquidity_ref": 0, "min_volume_ref_per_h": 0,
                                                     "max_step_minutes": 0, "exclude_recipes": True}).values())


def test_a_new_install_starts_with_an_empty_recipes_file():
    """The shipped file held disabled templates (one a made-up "Disenchant" that looked like data);
    the game's conversions are derived now, so the user's file starts empty."""
    import json
    from app.config import SEED_DIR
    assert json.loads((SEED_DIR / "recipes.json").read_text()) == []


def test_a_recipe_that_beats_its_market_still_serialises_for_the_screens(game_names, monkeypatch, tmp_path):
    """Found driving the app 2026-09-30: the Arbitrage page read "Object of type Edge is not JSON
    serializable". A recipe that takes a market's step kept that market's Edge in `meta`, and route
    steps and the Market graph table send `meta` to the UI as JSON."""
    import json
    from app import arbitrage, recipes
    from app.arbitrage.board import edge_table
    monkeypatch.setattr(recipes, "RECIPES_PATH", tmp_path / "recipes.json")
    _market(monkeypatch, {("chaos", "greater-chaos-orb"): 1 / 2.5, ("greater-chaos-orb", "chaos"): 2.4,
                          ("chaos", "exalted"): 0.1, ("exalted", "chaos"): 9.9})
    loops = _loops()
    assert ("chaos", "greater-chaos-orb", "chaos") in loops, "the loop through the recipe is there to serialise"
    json.dumps(list(loops.values()))
    json.dumps(edge_table())
    assert arbitrage.cached_graph().traded_rate("greater-chaos-orb", "chaos") == pytest.approx(2.4)


# ------------------------------------------------------------------ Convert
def _convert_graph():
    """10 Greater Orbs of Augmentation: the exchange path (via exalted) makes 22 Aug, the Greater->Aug
    market pays 2 each, and disenchanting pays 3 each at no gold. Values in exalted."""
    from app.arbitrage import Edge, Graph
    g = Graph({"gold_model": {}, "reference": "exalted", "league": "L", "step_overhead_min": 0, "max_steps": 3})
    g.fee_table = {}
    for a, b, rate in (("greater-orb-of-augmentation", "exalted", 2.62), ("exalted", "aug", 0.85),
                       ("greater-orb-of-augmentation", "aug", 2.0)):
        g.add(Edge(a, b, "digest", rate, [{"rate": rate, "stock": 1_000_000}], vol_in_per_h=1000.0))
    g.add_recipe({"from": "greater-orb-of-augmentation", "to": "aug", "rate": 3.0, "lot": 1,
                  "recipe_id": "disenchant:greater-orb-of-augmentation", "name": "Disenchant Greater Orb of Augmentation",
                  "kind": "disenchant"})
    return g, {"exalted": 1.0, "greater-orb-of-augmentation": 2.62, "aug": 1.0, "divine": 600.0}


def test_convert_picks_the_disenchant_and_direct_stays_the_market():
    """Found driving the app 2026-09-30: Convert showed "10 -> 22" through the exchange and labelled the
    disenchant's 30 "Direct market". A recipe's gain is real, not the cross-rate glitch the 2% gain cap
    screens out; and "direct" is the market, never a recipe."""
    from app import arbitrage
    g, rv = _convert_graph()
    res = arbitrage._best_conversions(g, rv, "greater-orb-of-augmentation", "aug", 10)
    assert res["best"]["uses_recipe"] and res["best"]["out"] == 30 and res["best"]["gold"] == 0
    assert res["direct"]["kinds"] == ["digest"] and res["direct"]["out"] == 20


def test_convert_still_rejects_a_glitch_on_the_exchange_steps_of_a_recipe_path():
    from app import arbitrage
    from app.arbitrage import Edge
    g, rv = _convert_graph()
    g.add(Edge("aug", "chaos", "digest", 5.0, [{"rate": 5.0, "stock": 1_000_000}], vol_in_per_h=1000.0))   # 1 Aug "sells" for 5 chaos
    rv["chaos"] = 1.0                                             # 1 Aug (1 ex) -> 5 ex of chaos: a quote glitch
    res = arbitrage._best_conversions(g, rv, "greater-orb-of-augmentation", "chaos", 10)
    assert res["best"] is None or not res["best"]["uses_recipe"], "the recipe's gain is exempt, the exchange glitch is not"



# ------------------------------------------------------------------ recipes never change market data
# Found by ops/regression-diff.py on 0.3.8-beta.2 (2026-09-30): recipes moved 17 prices by up to 4300%.
# (1) The thin-market cull spared every market touching a recipe's ends, and the orb disenchants make
# Chaos and Exalted recipe ends; (2) a recipe that took a market's pair hid that market from the value
# table and the volume ranking; (3) the naive walk behind the value table read recipe ratios as rates.
def _build(monkeypatch, rates, vols, with_recipes):
    """Graph.build over a fixture digest: rates {(a, b): b per a}, vols {(a, b): a units/h}."""
    from app import arbitrage, digest, gamedata, recipes
    from app.arbitrage import graph as G
    monkeypatch.setattr(digest, "latest_rates", lambda league, age: {
        k: {"rate": r, "stock": 1_000_000, "age_s": 0.0, "hour": 0, "volume_to": 1_000} for k, r in rates.items()})
    monkeypatch.setattr(digest, "pair_volume", lambda league, hours: dict(vols))
    monkeypatch.setattr(gamedata, "fees", lambda: {"by_trade": {}})
    real = recipes.edges
    monkeypatch.setattr(G.recipes, "edges", real if with_recipes else (lambda: []))
    arbitrage.invalidate_caches()
    g = G.Graph.build()
    monkeypatch.setattr(G.recipes, "edges", real)
    return g


# A market touching exalted too thin to keep (0.001 thin-rune an hour), and a Greater Chaos Orb
# whose ONLY market is the one its disenchant beats (2.4 chaos, against the recipe's 3).
MARKET = {("chaos", "exalted"): 0.1, ("exalted", "chaos"): 9.9,
          ("greater-chaos-orb", "chaos"): 2.4,
          ("thin-rune", "exalted"): 50.0, ("exalted", "thin-rune"): 1 / 60.0,
          ("thin-rune", "chaos"): 0.2, ("chaos", "thin-rune"): 4.0}
VOLS = {("chaos", "exalted"): 5000.0, ("exalted", "chaos"): 500.0, ("greater-chaos-orb", "chaos"): 300.0,
        ("thin-rune", "exalted"): 0.001, ("exalted", "thin-rune"): 0.0,
        ("thin-rune", "chaos"): 40.0, ("chaos", "thin-rune"): 30.0}


def test_recipes_never_change_the_market_data(game_names, monkeypatch, tmp_path):
    from app import centrality, recipes
    from app.arbitrage import graph as G
    monkeypatch.setattr(recipes, "RECIPES_PATH", tmp_path / "recipes.json")
    off = _build(monkeypatch, MARKET, VOLS, with_recipes=False)
    on = _build(monkeypatch, MARKET, VOLS, with_recipes=True)
    assert any(e.kind == "recipe" for e in on.edges.values()), "the fixture has recipe edges to test"
    assert ("thin-rune", "exalted") not in off.edges, "the fixture's thin market is culled without recipes"
    assert on.values() == off.values()
    assert on.busiest == off.busiest and on.priced_by == off.priced_by
    assert G.counterparts_by_volume(on, on.values()) == G.counterparts_by_volume(off, off.values())
    assert on.ref_values() == off.ref_values()
    assert on.direct_rate("greater-chaos-orb", "chaos") == off.direct_rate("greater-chaos-orb", "chaos") == 2.4
    assert centrality._weights(on, on.values()) == centrality._weights(off, off.values())
    assert on.edges[("greater-chaos-orb", "chaos")].kind == "recipe", "routes still take the disenchant"


# ------------------------------------------------------------------ Convert: only the recipe you start with
def test_convert_does_not_detour_a_plain_swap_through_a_recipe():
    """Found by ops/regression-diff.py (2026-09-30): chaos -> divine came back as chaos -> Greater Orb of
    Transmutation -> disenchant -> Transmutation -> divine, arbitrage dressed as a conversion. A
    recipe's gain is exempt from the cap only when the conversion starts by using it on what you hold."""
    from app import arbitrage
    from app.arbitrage import Edge
    g, rv = _convert_graph()
    g.add(Edge("exalted", "greater-orb-of-augmentation", "digest", 1 / 2.62, [{"rate": 1 / 2.62, "stock": 1_000_000}], vol_in_per_h=1000.0))
    g.add(Edge("aug", "exalted", "digest", 1.0, [{"rate": 1.0, "stock": 1_000_000}], vol_in_per_h=1000.0))
    res = arbitrage._best_conversions(g, rv, "exalted", "aug", 129)      # sizes to whole lots: a full conversion
    assert res["best"] is not None and not res["best"]["uses_recipe"], res["best"] and res["best"]["id"]
    assert arbitrage._best_conversions(g, rv, "greater-orb-of-augmentation", "aug", 10)["best"]["uses_recipe"]


def test_the_market_table_still_lists_a_market_a_recipe_took_over(monkeypatch):
    """Economy -> Market's "Edges in the current graph" lists every market, and each recipe beside it:
    the Greater Aug -> Aug market (2 each) did not vanish behind its disenchant (3 each)."""
    import importlib
    board = importlib.import_module("app.arbitrage.board")
    from app.arbitrage import graph as G
    g, _rv = _convert_graph()
    g.values = lambda: dict(_rv)
    monkeypatch.setattr(G, "cached_graph", lambda: g)
    rows = [(r["from"], r["to"], r["kind"], r["rate"]) for r in board.edge_table()]
    assert ("greater-orb-of-augmentation", "aug", "digest", 2.0) in rows
    assert ("greater-orb-of-augmentation", "aug", "recipe", 3.0) in rows
