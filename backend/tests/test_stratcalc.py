"""Strategy → Strat Calculator: the saved strats (user kv `strat_calc`) and the divine-per-unit price
table they are valued with — the one value table (Graph.values) every screen uses. Everything the
currency picker offers is priced there, lineage support gems included (the registry carries them and
the graph falls back to poe2scout's daily close for what the exchange doesn't trade).

    DATA_DIR=$(mktemp -d) MARKET_SEED= .venv-test/bin/python -m pytest backend/tests/test_stratcalc.py -q
"""
import copy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from starlette.testclient import TestClient  # noqa: E402
from app import arbitrage, datapolicy, db, stratcalc  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)   # no lifespan: no backfill/sidecar


def _strat(id_="a", **over):
    s = {
        "id": id_, "name": "Ritual chains", "updatedAt": 2,
        "timer": {"startedAt": 1_700_000_000_000, "elapsedMs": 120_000},
        "time": {"on": False, "ms": 0},
        "loot": [{"cur": "divine", "name": None, "qty": 3, "price": None},
                 {"cur": None, "name": "Rakiata's Flow", "qty": 1, "price": 196.0},
                 {"cur": None, "name": "Mageblood", "base": "Utility Belt", "qty": 1, "price": None,
                  "floor": {"div": 140.0, "at": 1_700_000_000_000}}],
        "maps": {"count": 35, "price": 6, "cur": "chaos"},
        "tablets": {"lines": [{"id": "t1", "base": None, "name": None, "slots": 2, "price": 1.5, "cur": "divine"},
                              {"id": "t2", "base": "Ritual Tablet", "name": "Freedom of Faith", "slots": 1, "price": 3, "cur": "divine"}]},
        "override": {"on": False, "amount": 0, "cur": "chaos"},
        "fixed": [{"cur": "head-of-the-king", "name": None, "qty": 7, "price": None}],
    }
    s.update(over)
    return s


GOOD = {"v": 1, "active": "a", "lastCur": "chaos", "strats": [_strat("a"), _strat("b", name="Abyss")],
        "tree": [{"id": "f", "kind": "folder", "name": "Ritual", "open": True, "children": [{"id": "a", "kind": "strat"}]},
                 {"id": "b", "kind": "strat"}]}


def _deep(n):
    node = {"id": "a", "kind": "strat"}
    for i in range(n):
        node = {"id": f"f{i}", "kind": "folder", "name": "F", "open": True, "children": [node]}
    return [node, {"id": "b", "kind": "strat"}]


def _bad(path, value):
    d = copy.deepcopy(GOOD)
    tgt = d
    for k in path[:-1]:
        tgt = tgt[k]
    tgt[path[-1]] = value
    return d


def test_the_strats_are_user_data():
    assert "strat_calc" in datapolicy.USER_KV
    assert db._kv_table(stratcalc.KEY) == "kv"


# ------------------------------------------------------------------ what may be saved
def test_validate_takes_what_the_view_writes():
    assert stratcalc.validate(GOOD) is None
    assert stratcalc.validate({"v": 1, "active": None, "lastCur": "chaos", "strats": []}) is None
    assert stratcalc.validate(_bad(["strats", 0, "override"], {"on": True, "amount": 140.5, "cur": "divine"})) is None
    unique = {"cur": None, "name": "Headhunter", "base": "Heavy Belt", "qty": 1, "price": None, "floor": None}
    assert stratcalc.validate(_bad(["strats", 0, "loot"], [unique])) is None, "a unique not priced yet"
    assert stratcalc.validate(_bad(["strats", 0, "time"], {"on": True, "ms": 5_400_000})) is None, "1 h 30 m, typed"
    assert stratcalc.validate({**GOOD, "tree": _deep(stratcalc.MAX_DEPTH)}) is None, "folders inside folders, to a depth"
    linked = {"id": "t1", "base": "Breach Tablet", "name": None, "slots": 2, "price": None, "cur": "divine",
              "link": {"query": {"query": {"type": "Breach Tablet"}, "sort": {"price": "asc"}}, "league": "Forbidden Rites", "div": None, "at": 0}}
    assert stratcalc.validate(_bad(["strats", 0, "tablets", "lines"], [linked])) is None, "a linked search, not priced yet"
    priced = {**linked, "link": {**linked["link"], "div": 0.4, "at": 1_700_000_000_000}}
    assert stratcalc.validate(_bad(["strats", 0, "tablets", "lines"], [priced])) is None
    way = {"query": {"query": {"filters": {"type_filters": {"filters": {"category": {"option": "map.waystone"}}}}}}, "league": "Forbidden Rites", "div": 0.2, "at": 1}
    assert stratcalc.validate(_bad(["strats", 0, "maps"], {"count": 3, "price": None, "cur": "chaos", "link": way})) is None, "a map priced by a waystone search"


@pytest.mark.parametrize("bad", [
    [],
    {**GOOD, "v": 2},
    {**GOOD, "strats": "x"},
    {**GOOD, "strats": [_strat(f"s{i}") for i in range(stratcalc.MAX_STRATS + 1)]},
    {**GOOD, "strats": [_strat("a"), _strat("a")]},                     # one id, two strats
    {**GOOD, "active": 7},
    _bad(["strats", 0, "id"], ""),
    _bad(["strats", 0, "name"], "x" * 500),
    _bad(["strats", 0, "timer"], {"startedAt": "now", "elapsedMs": 0}),
    _bad(["strats", 0, "loot"], [{"cur": "divine", "name": None, "qty": 2.5, "price": None}]),   # counts are whole
    _bad(["strats", 0, "loot"], [{"cur": "divine", "name": None, "qty": -1, "price": None}]),
    _bad(["strats", 0, "loot"], [{"cur": None, "name": None, "qty": 1, "price": None}]),       # neither id nor name
    _bad(["strats", 0, "loot"], [{"cur": "divine", "name": None, "qty": 1, "price": -2}]),
    _bad(["strats", 0, "loot"], [{"cur": "divine", "name": None, "qty": True, "price": None}]),
    _bad(["strats", 0, "loot"], [{"cur": "c", "name": None, "qty": 1, "price": None}] * (stratcalc.MAX_ROWS + 1)),
    _bad(["strats", 0, "tablets"], {"perMap": 3, "price": 1.5, "cur": "divine"}),        # the shape before setups
    _bad(["strats", 0, "tablets", "lines", 0, "slots"], 4),                              # four slots in all (4 + 1)
    _bad(["strats", 0, "tablets", "lines", 0, "slots"], 0),                              # a line holds a tablet
    _bad(["strats", 0, "tablets", "lines", 1, "id"], "t1"),                              # one id, two lines
    _bad(["strats", 0, "tablets", "lines", 0, "price"], -1),
    _bad(["strats", 0, "tablets", "lines", 0, "base"], ""),
    _bad(["strats", 0, "tablets", "lines", 0, "name"], "x" * 500),
    _bad(["strats", 0, "tablets", "lines", 0, "link"], {"query": "x", "league": "L", "div": None, "at": 0}),
    _bad(["strats", 0, "tablets", "lines", 0, "link"], {"query": {"query": {}}, "league": "", "div": None, "at": 0}),
    _bad(["strats", 0, "tablets", "lines", 0, "link"], {"query": {"query": {}}, "league": "L", "div": -1, "at": 0}),
    _bad(["strats", 0, "tablets", "lines", 0, "link"], {"query": {"query": {"x": "y" * 30_000}}, "league": "L", "div": None, "at": 0}),   # a search, not a payload
    _bad(["strats", 0, "maps", "count"], 1.5),
    _bad(["strats", 0, "maps", "link"], {"query": "x", "league": "L", "div": None, "at": 0}),
    _bad(["strats", 0, "override", "on"], "yes"),
    _bad(["strats", 0, "fixed"], [{"cur": "x" * 500, "name": None, "qty": 1, "price": None}]),
    _bad(["strats", 0, "loot"], [{"cur": "divine", "name": None, "base": "Ring", "qty": 1, "price": None}]),   # a base is a unique's
    _bad(["strats", 0, "loot"], [{"cur": None, "name": "Mageblood", "base": "", "qty": 1, "price": None}]),
    _bad(["strats", 0, "loot"], [{"cur": None, "name": "Mageblood", "base": "Utility Belt", "qty": 1, "price": None, "floor": {"div": -1, "at": 0}}]),
    _bad(["strats", 0, "loot"], [{"cur": None, "name": "Mageblood", "base": "Utility Belt", "qty": 1, "price": None, "floor": "140"}]),
    _bad(["strats", 0, "time"], {"on": "yes", "ms": 0}),                # the time override
    _bad(["strats", 0, "time"], {"on": True, "ms": -1}),
    _bad(["strats", 0, "time"], "2h"),
    {**GOOD, "tree": "x"},                                                                # the sidebar tree
    {**GOOD, "tree": [{"id": "a", "kind": "strat"}, {"id": "zz", "kind": "strat"}, {"id": "b", "kind": "strat"}]},  # a strat that isn't there
    {**GOOD, "tree": [{"id": "a", "kind": "strat"}, {"id": "a", "kind": "strat"}, {"id": "b", "kind": "strat"}]},   # one strat twice
    {**GOOD, "tree": [{"id": "f", "kind": "folder", "name": "", "open": True, "children": []}, {"id": "a", "kind": "strat"}, {"id": "b", "kind": "strat"}]},
    {**GOOD, "tree": [{"id": "a", "kind": "folder", "name": "F", "open": True, "children": []}, {"id": "b", "kind": "strat"}]},  # a folder with a strat's id
    {**GOOD, "tree": _deep(stratcalc.MAX_DEPTH + 1)},
])
def test_validate_refuses_what_the_view_never_writes(bad):
    assert stratcalc.validate(bad) is not None


# ------------------------------------------------------------------ prices
def test_prices_are_divines_per_unit_off_the_one_value_table():
    V = {"divine": 400.0, "chaos": 20.0, "mirror": 400_000.0, "dead": 0.0}
    p = stratcalc.divine_prices(V, "exalted")
    assert p["divine"] == 1.0
    assert p["exalted"] == pytest.approx(1 / 400)      # the reference is 1 by definition
    assert p["chaos"] == pytest.approx(0.05)
    assert p["mirror"] == pytest.approx(1000)
    assert "dead" not in p                              # no value is no price, not a free item


def test_no_divine_price_is_no_table():
    assert stratcalc.divine_prices({"chaos": 20.0}, "exalted") == {}
    assert stratcalc.divine_prices({"chaos": 0.05}, "divine") == {"divine": 1.0, "chaos": 0.05}


def test_endpoint_serves_the_strats_and_the_one_table(monkeypatch):
    class G:
        s = {"reference": "exalted"}
        def values(self):
            return {"divine": 400.0, "chaos": 20.0}
    monkeypatch.setattr(arbitrage, "cached_graph", lambda: G())
    db.kv_set(stratcalc.KEY, None)
    r = client.get("/api/strategy/calc").json()
    assert r["calc"] is None
    assert r["prices"]["chaos"] == pytest.approx(0.05)
    assert set(r) == {"calc", "prices", "uses"}, "one table: no second list of things to price"
    assert r["uses"] == [], "the tablets' full uses (kv_ops tablet_uses, the seed's): none until the pipeline ran"
    db.kv_set("tablet_uses", [{"name": "Freedom of Faith", "base": "Ritual Tablet", "uses": 5}])
    assert client.get("/api/strategy/calc").json()["uses"] == [{"name": "Freedom of Faith", "base": "Ritual Tablet", "uses": 5}]
    db.kv_set("tablet_uses", [])
    put = client.put("/api/strategy/calc", json={"calc": GOOD})
    assert put.status_code == 200 and put.json() == {"calc": GOOD}
    assert client.get("/api/strategy/calc").json()["calc"] == GOOD
    assert client.put("/api/strategy/calc", json={"calc": {"v": 1, "strats": "x"}}).status_code == 422
    assert client.get("/api/strategy/calc").json()["calc"] == GOOD, "a refused save changes nothing"
    db.kv_set(stratcalc.KEY, None)


def test_a_cold_graph_still_serves_the_strats(monkeypatch):
    def boom():
        raise RuntimeError("no graph yet")
    monkeypatch.setattr(arbitrage, "cached_graph", boom)
    db.kv_set(stratcalc.KEY, GOOD)
    r = client.get("/api/strategy/calc")
    assert r.status_code == 200 and r.json()["prices"] == {} and r.json()["calc"] == GOOD
    db.kv_set(stratcalc.KEY, None)


def test_prices_only_skips_the_saved_document(monkeypatch):
    """The view's minute poll needs the prices; the strats were read once on mount."""
    class G:
        s = {"reference": "exalted"}
        def values(self):
            return {"divine": 400.0}
    monkeypatch.setattr(arbitrage, "cached_graph", lambda: G())
    db.kv_set(stratcalc.KEY, GOOD)
    r = client.get("/api/strategy/calc", params={"prices": 1}).json()
    assert set(r) == {"prices"} and r["prices"]["divine"] == 1.0
    db.kv_set(stratcalc.KEY, None)
