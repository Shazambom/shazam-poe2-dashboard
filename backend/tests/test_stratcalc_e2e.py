"""Strat Calculator, end to end, on realistic farming sessions (owner, 2026-10-01: "make sure there
is an end to end tests that are fuzzy with realistic strats").

Every check runs the whole path the app runs:
  market rates → Graph.values (the one value table), and poe2db's tablet pages → the pipeline
  (modpool.refresh_tablet_uses → kv_ops tablet_uses) → GET /api/strategy/calc (divines per unit, the
  tablets' full uses) → PUT the strats (user kv `strat_calc`, stratcalc.validate)
  → GET them back → frontend/src/lib/stratcalc.js in node (normalize, tally, sidebar, the strat
  actions) → net divines per hour.

  * PROFILES (fixtures/strat_profiles.json): 19 real strategies with the costs, loot and session
    lengths their sources published (Farm of Exile, XTheFarmerX's public "Strat Data" sheet, guides;
    each lists its URLs), priced at the source's own rates. The calculator must land in the div/h
    range the source gives.
  * FUZZ: seeded random sessions inside the envelope those sources span, against an independent
    oracle and invariants (more loot never lowers net, another map never raises it, the override
    only replaces the maps + tablets cost, rate × hours = net, nothing NaN or infinite).
  * ACTIONS: random sequences of what the sidebar does (new, duplicate, start/pause, edit, rename,
    remove, undo) — every document the view would save is one the backend accepts, at most one strat
    runs, and every sidebar number is that strat's own tally.

    DATA_DIR=$(mktemp -d) MARKET_SEED= .venv-test/bin/python -m pytest backend/tests/test_stratcalc_e2e.py -q
"""
import json
import math
import random
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from starlette.testclient import TestClient  # noqa: E402
from app import arbitrage, db, modpool, settings, stratcalc  # noqa: E402
from app.arbitrage.graph import Edge, Graph  # noqa: E402
from app.main import app  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "strat_profiles.json").read_text())
PROFILES = FIXTURES["profiles"]
ENV = FIXTURES["envelope"]
LIB = (ROOT / "frontend" / "src" / "lib" / "stratcalc.js").as_uri()
MIN = 60_000
H = 3_600_000
EX_PER_DIV = 537.0          # Forbidden Rites, 2026-09-28 (the research's market medians)

client = TestClient(app)   # no lifespan: no backfill/sidecar


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    db.kv_set(stratcalc.KEY, None)
    _pipeline_tablet_uses(monkeypatch)
    yield
    db.kv_set(stratcalc.KEY, None)
    db.kv_set("tablet_uses", [])


# ------------------------------------------------------------------ the tablets' full uses
# The pipeline run over the poe2db pages saved in fixtures/mods (the Tablet page and three uniques),
# exactly as shazam runs it: what the endpoint serves is what it stored.
MODS = Path(__file__).parent / "fixtures" / "mods"
UNIQUE_TABLETS = ("Freedom_of_Faith", "Mastered_Domain", "Wraeclast_Besieged")


def _pipeline_tablet_uses(monkeypatch):
    import asyncio
    import gzip

    async def page(slug, max_age):
        if slug != "Tablet" and slug not in UNIQUE_TABLETS:
            raise OSError(slug)
        with gzip.open(MODS / f"poe2db-{slug}.html.gz", "rt", encoding="utf-8") as f:
            return f.read()
    monkeypatch.setattr(modpool, "_page", page)
    assert asyncio.run(modpool.refresh_tablet_uses(0)) is None


# ------------------------------------------------------------------ the market
def _graph(div_prices: dict[str, float], ex_per_div: float) -> Graph:
    """A market where every currency trades against exalted at the given divine price: the real
    Graph, so prices reach the calculator through Graph.values as they do in the app."""
    g = Graph({**settings.get_settings(), "reference": "exalted"})
    g.fee_table = {}
    for cur, px_div in {**div_prices, "divine": 1.0}.items():
        if cur == "exalted":
            continue
        ex = px_div * ex_per_div
        for a, b, rate in ((cur, "exalted", ex), ("exalted", cur, 1 / ex)):
            e = Edge(a, b, "live", rate, [{"rate": rate, "stock": 10_000}], age_s=10.0)
            e.vol_in_per_h = 1e6
            g.add(e)
    return g


def _prices_through_the_app(monkeypatch, div_prices, ex_per_div=EX_PER_DIV) -> dict:
    if div_prices.get("exalted"):       # a market that states exalted's price sets its own ratio
        ex_per_div = 1 / div_prices["exalted"]
    g = _graph(div_prices, ex_per_div)
    monkeypatch.setattr(arbitrage, "cached_graph", lambda: g)
    r = client.get("/api/strategy/calc")
    assert r.status_code == 200
    return r.json()


def _save_and_reload(doc: dict) -> dict:
    put = client.put("/api/strategy/calc", json={"calc": doc})
    assert put.status_code == 200, (put.text, doc)
    back = client.get("/api/strategy/calc").json()["calc"]
    assert back == doc, "the strats read back exactly as they were written"
    return back


# ------------------------------------------------------------------ the view's code, in node
_JS = r"""
const sc = await import(process.argv[1])
let raw = ''
for await (const c of process.stdin) raw += c
const { mode, cases, uses } = JSON.parse(raw)
const T = (t) => ({ loot: t.loot, maps: t.maps, tablets: t.tablets, override: t.override, fixed: t.fixed, costs: t.costs,
                    net: t.net, hours: t.hours, perHour: t.perHour, unpriced: t.unpriced })
let out
if (mode === 'tally') {
  out = cases.map(({ calc, prices, now }) => {
    const d = sc.normalize(calc)
    return { strats: d.strats.map(s => ({ id: s.id, ...T(sc.tally(s, prices, now, uses)) })) }
  })
} else if (mode === 'actions') {
  // Replay a script of sidebar actions; report every document the view would have saved.
  out = cases.map(({ steps, prices }) => {
    let d = sc.blankDoc()
    const docs = [], undo = []
    for (const st of steps) {
      const { op, id, now } = st
      if (op === 'new') d = sc.newStrat(d, { id: st.newId, name: st.name, now })
      else if (op === 'dup') d = sc.duplicate(d, id, { id: st.newId, now })
      else if (op === 'toggle') d = sc.toggle(d, id, now)
      else if (op === 'select') d = sc.select(d, id)
      else if (op === 'rename') d = sc.rename(d, id, st.name, now)
      else if (op === 'loot') d = sc.edit(d, id, s => ({ ...s, loot: sc.setQty(sc.addRow(s.loot, st.cur), st.cur, st.qty) }), now)
      else if (op === 'custom') d = sc.edit(d, id, s => ({ ...s, loot: sc.addCustom(s.loot, st.name, st.price) }), now)
      else if (op === 'unique') d = sc.edit(d, id, s => ({ ...s, loot: sc.setQty(sc.addUnique(s.loot, st.u), `unique:${st.u.name}|${st.u.type}`, 1) }), now)
      else if (op === 'floor') d = sc.recordFloor(d, id, `unique:${st.u.name}|${st.u.type}`, sc.floorDiv(st.listings, prices), now)
      else if (op === 'map') d = sc.edit(d, id, s => ({ ...s, maps: { ...s.maps, count: s.maps.count + 1 } }), now)
      else if (op === 'mapprice') d = sc.edit(d, id, s => ({ ...s, maps: { ...s.maps, price: st.price } }), now)
      else if (op === 'tablet') d = sc.addTablet(d, id, { id: st.newId, now })
      else if (op === 'tabletedit') { const ls = d.strats.find(s => s.id === id)?.tablets.lines ?? []; if (ls.length) d = sc.editTablet(d, id, ls[st.pick % ls.length].id, st.patch, now) }
      else if (op === 'link') { const ls = d.strats.find(s => s.id === id)?.tablets.lines ?? []; if (ls.length) d = sc.linkTablet(d, id, ls[st.pick % ls.length].id, { query: st.query, league: 'Forbidden Rites' }, now) }
      else if (op === 'linkprice') { const ls = d.strats.find(s => s.id === id)?.tablets.lines ?? []; if (ls.length) d = sc.recordLinkPrice(d, id, ls[st.pick % ls.length].id, st.div, now) }
      else if (op === 'unlink') { const ls = d.strats.find(s => s.id === id)?.tablets.lines ?? []; if (ls.length) d = sc.unlinkTablet(d, id, ls[st.pick % ls.length].id, now) }
      else if (op === 'mapslink') d = sc.linkMaps(d, id, { query: st.query, league: 'Forbidden Rites' }, now)
      else if (op === 'mapsprice') d = sc.recordMapsPrice(d, id, st.div, now)
      else if (op === 'mapsunlink') d = sc.unlinkMaps(d, id, now)
      else if (op === 'share') { const all = sc.treeIds(d.tree); if (all.length) { const r = sc.importStrats(d, sc.exportStrats(d, all[st.pick % all.length], now), { newId: (k) => `${k}-${now}-${Math.random().toString(36).slice(2, 8)}`, now }); if (r) d = r.doc } }
      else if (op === 'untablet') { const ls = d.strats.find(s => s.id === id)?.tablets.lines ?? []; if (ls.length) d = sc.removeTablet(d, id, ls[st.pick % ls.length].id, now) }
      else if (op === 'cur') d = sc.setCostCur(d, id, st.part, st.cur, now)
      else if (op === 'override') d = sc.edit(d, id, s => (s.override.on ? { ...s, override: { ...s.override, on: false } } : sc.overrideOn(s, prices, uses)), now)
      else if (op === 'remove') { const r = sc.removeStrat(d, id); d = r.doc; if (r.removed) undo.push(['strat', r.removed]) }
      else if (op === 'folder') d = sc.newFolder(d, { id: st.newId, name: st.name })
      else if (op === 'move') { const fs = sc.flattenFolders(d.tree); const to = st.toRoot || !fs.length ? null : fs[st.pick % fs.length].id; const all = sc.treeIds(d.tree); if (all.length) d = sc.moveNode(d, all[st.pick % all.length], to, st.index) }
      else if (op === 'unfolder') { const fs = sc.flattenFolders(d.tree); if (fs.length) { const r = sc.removeFolder(d, fs[st.pick % fs.length].id); d = r.doc; if (r.removed) undo.push(['folder', r.removed]) } }
      else if (op === 'deepfolder') { const fs = sc.flattenFolders(d.tree); if (fs.length) { const r = sc.removeFolderDeep(d, fs[st.pick % fs.length].id); d = r.doc; if (r.removed) undo.push(['deep', r.removed]) } }
      else if (op === 'undo') { const r = undo.pop(); if (r) d = r[0] === 'strat' ? sc.restoreStrat(d, r[1]) : r[0] === 'deep' ? sc.restoreFolderDeep(d, r[1]) : sc.restoreFolder(d, r[1]) }
      if (d.strats.some(s => sc.tabletSlots(s) > sc.MAX_TABLETS)) throw new Error('more than four tablets on a map at ' + op)
      const running = d.strats.filter(s => sc.running(s.timer)).length
      const placed = sc.treeIds(d.tree).filter(x => d.strats.some(s => s.id === x)).sort().join()
      if (placed !== d.strats.map(s => s.id).sort().join()) throw new Error('a strat lost its place in the tree at ' + op)
      const back = sc.normalize(JSON.parse(JSON.stringify(d)))
      docs.push({ doc: d, running, roundtrip: JSON.stringify(back) === JSON.stringify(d), back })
    }
    return docs
  })
}
process.stdout.write(JSON.stringify(out))
"""


def _js(mode: str, cases: list, uses: list | None = None) -> list:
    node = shutil.which("node")
    assert node, "node is required: the calculator's math is frontend/src/lib/stratcalc.js"
    r = subprocess.run([node, "--input-type=module", "-e", _JS, LIB], input=json.dumps({"mode": mode, "cases": cases, "uses": _served_uses() if uses is None else uses}),
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def _served_uses() -> list:
    """The tablets' full uses as the view gets them: from the endpoint."""
    return client.get("/api/strategy/calc").json()["uses"]


def _first_diff(a, b) -> str:
    x, y = json.dumps(a, separators=(",", ":")), json.dumps(b, separators=(",", ":"))
    i = next((i for i, (p, q) in enumerate(zip(x, y)) if p != q), min(len(x), len(y)))
    return f"reloaded …{x[max(0, i - 160):i + 60]}… / saved …{y[max(0, i - 160):i + 60]}…"


def _close(a, b, rel=1e-6):
    return math.isclose(a, b, rel_tol=rel, abs_tol=1e-9)


# ------------------------------------------------------------------ a strat, and the oracle
def _strat_from_profile(p: dict, sid="s") -> dict:
    o = p.get("override")
    return {
        "id": sid, "name": p["name"][:100], "updatedAt": 0,
        "timer": {"startedAt": None, "elapsedMs": round(p["minutes"] * MIN)},
        "loot": [{"cur": r.get("cur"), "name": r.get("name"), "qty": r["qty"], "price": r.get("price")} for r in p["loot"]],
        "maps": p["maps"], "tablets": _lines(p["tablets"]),
        "override": {"on": bool(o), "amount": o["amount"] if o else 0, "cur": o["cur"] if o else p["maps"]["cur"]},
        "fixed": [{"cur": r["cur"], "name": None, "qty": r["qty"], "price": None} for r in p.get("fixed", [])],
    }


def _lines(t: dict) -> dict:
    """A source's "n tablets a map at a price" is one line of any normal tablet."""
    if "lines" in t:
        return t
    return {"lines": [{"id": "t", "base": None, "name": None, "slots": t["perMap"], "price": t["price"], "cur": t["cur"]}] if t["perMap"] else []}


def _doc(*strats) -> dict:
    return {"v": 1, "active": strats[0]["id"] if strats else None, "lastCur": "chaos", "strats": list(strats)}


# The research's numbers (2026-10-01: trade listings + poe2db samples), written down independently of
# the pipeline so the oracle checks it rather than repeating it.
RESEARCH_USES = {"Freedom of Faith": 5, "Wraeclast Besieged": 5, "Mastered Domain": 1}


def _full_uses(ln: dict) -> int:
    return RESEARCH_USES[ln["name"]] if ln.get("name") else 10


def _oracle(s: dict, div: dict) -> dict:
    """The profit worked out here, independently of the JS: Σ count × divines per unit."""
    def px(r):
        return r["price"] if r.get("price") is not None else div[r["cur"]]
    loot = sum(r["qty"] * px(r) for r in s["loot"])
    if s["override"]["on"]:
        mt = s["override"]["amount"] * div[s["override"]["cur"]]
    else:
        m = s["maps"]
        mt = m["count"] * m["price"] * div[m["cur"]]
        for ln in s["tablets"]["lines"]:
            mt += m["count"] * ln["slots"] / _full_uses(ln) * ln["price"] * div[ln["cur"]]
    costs = mt + sum(r["qty"] * px(r) for r in s["fixed"])
    hours = s["timer"]["elapsedMs"] / H
    return {"loot": loot, "costs": costs, "net": loot - costs, "perHour": (loot - costs) / hours}


# ------------------------------------------------------------------ the fixtures themselves
def test_the_profiles_are_real_and_cover_the_range():
    assert len(PROFILES) >= 10
    for p in PROFILES:
        assert p["source_urls"], f"{p['name']}: every profile names where its numbers came from"
    rates = [p["maps"]["count"] / (p["minutes"] / 60) for p in PROFILES]
    assert min(rates) < 5 and max(rates) > 15, "slow juiced mappers and fast rushers both appear"
    assert any(p["override"] for p in PROFILES) and any(not p["override"] for p in PROFILES)
    assert any(p["tablets"]["perMap"] == 4 for p in PROFILES), "a city map's fourth tablet"
    assert any(p["fixed"] for p in PROFILES), "one-off session costs"
    assert any(r.get("name") for p in PROFILES for r in p["loot"]), "a custom-priced drop"
    assert any(p["from_spreadsheet"] for p in PROFILES), "a public profit spreadsheet's session"
    his = [p["expected_net_div_per_hour"][1] for p in PROFILES]
    assert min(his) < 1 and max(his) > 100, "from a casual near-zero hour to a juiced 100+ div/h"


# ------------------------------------------------------------------ real strategies
@pytest.mark.parametrize("p", PROFILES, ids=[p["name"][:60] for p in PROFILES])
def test_a_real_strategy_reads_what_its_source_claims(p, monkeypatch):
    prices = _prices_through_the_app(monkeypatch, p["prices_div"])["prices"]
    for c, px in p["prices_div"].items():
        assert _close(prices[c], px), f"{c}: the app prices it at {prices[c]}, the source at {px}"
    doc = _save_and_reload(_doc(_strat_from_profile(p)))
    [res] = _js("tally", [{"calc": doc, "prices": prices, "now": 0}])
    t, want = res["strats"][0], _oracle(doc["strats"][0], p["prices_div"])
    assert t["unpriced"] == []
    for k in ("loot", "costs", "net", "perHour"):
        assert _close(t[k], want[k]), (k, t[k], want[k])
    lo, hi = p["expected_net_div_per_hour"]
    assert lo <= t["perHour"] <= hi, f"{p['name']}: {t['perHour']:.2f} div/h, the source says {lo}–{hi}"


def test_every_real_strategy_side_by_side_in_one_document(monkeypatch):
    """All 19 as one history, priced at one market: each strat's rate is its own (the sidebar shows it)."""
    merged = {}             # one market: every profile's items at one table
    for p in PROFILES:
        merged.update(p["prices_div"])
    prices = _prices_through_the_app(monkeypatch, merged)["prices"]
    strats = [_strat_from_profile(p, f"s{i}") | {"updatedAt": i} for i, p in enumerate(PROFILES)]
    doc = _save_and_reload(_doc(*strats))
    [res] = _js("tally", [{"calc": doc, "prices": prices, "now": 0}])
    by_id = {s["id"]: s for s in strats}
    assert sorted(x["id"] for x in res["strats"]) == sorted(by_id)
    for row in res["strats"]:
        assert _close(row["perHour"], _oracle(by_id[row["id"]], merged)["perHour"]), row


# ------------------------------------------------------------------ fuzz
def _logu(rng, lo, hi):
    return math.exp(rng.uniform(math.log(lo), math.log(hi)))


def _market(rng):
    """A fuzzed market: forty items across the price range the sources span, plus the anchors."""
    ex_per_div = rng.uniform(*ENV["ex_per_div"])
    prices = {f"item-{i}": _logu(rng, *ENV["unit_price_div"]) for i in range(40)}
    prices.update({"divine": 1.0, "exalted": 1 / ex_per_div, "chaos": rng.uniform(1 / 31, 1 / 8)})
    return prices, ex_per_div


TABLET_KINDS = [(None, None), (None, "Breach Tablet"), (None, "Ritual Tablet"), ("Freedom of Faith", "Ritual Tablet"),
                ("Mastered Domain", "Irradiated Tablet"), ("Wraeclast Besieged", "Breach Tablet")]


def _rand_tablets(rng, prices, cur) -> dict:
    """0–4 slots split over up to three kinds of tablet, uniques among them."""
    left, lines = rng.randint(*ENV["tablets_per_map"]), []
    while left and len(lines) < 3:
        slots = rng.randint(1, left)
        left -= slots
        name, base = rng.choice(TABLET_KINDS)
        lines.append({"id": f"t{len(lines)}", "base": base, "name": name, "slots": slots,
                      "price": rng.uniform(*ENV["tablet_cost_div"]) * (_full_uses({"name": name}) / 10 if name else 1) / prices[cur], "cur": cur})
    return {"lines": lines}


def _rand_strat(rng, prices, sid) -> dict:
    minutes = rng.uniform(*ENV["minutes"])
    maps = max(0, round(minutes / 60 * rng.uniform(*ENV["maps_per_hour"])))
    cur = lambda: rng.choice(["chaos", "chaos", "exalted", "divine"])  # noqa: E731
    mcur, tcur, ocur = cur(), cur(), cur()
    pool = sorted(prices)
    loot = [{"cur": c, "name": None, "qty": round(_logu(rng, ENV["loot_count"][0], ENV["loot_count"][1] / 10)), "price": None}
            for c in rng.sample(pool, rng.randint(*ENV["loot_lines"]))]
    if rng.random() < 0.3:      # a jackpot line with a typed price (a unique, a Saga)
        loot.append({"cur": None, "name": f"Jackpot {sid}", "qty": 1, "price": _logu(rng, 1, 300)})
    if rng.random() < 0.2 and loot:     # a typed price over a market one
        loot[0]["price"] = _logu(rng, *ENV["unit_price_div"])
    fixed = [{"cur": c, "name": None, "qty": rng.randint(*ENV["fixed_count"]), "price": None}
             for c in rng.sample(pool, rng.randint(*ENV["fixed_lines"]))]
    return {
        "id": sid, "name": f"Fuzz {sid}", "updatedAt": rng.randint(0, 10**6),
        "timer": {"startedAt": None, "elapsedMs": round(minutes * MIN)},
        "loot": loot,
        "maps": {"count": maps, "price": rng.uniform(*ENV["map_cost_div"]) / prices[mcur], "cur": mcur},
        "tablets": _rand_tablets(rng, prices, tcur),
        "override": {"on": rng.random() < 0.25, "amount": rng.uniform(0, 300) / prices[ocur], "cur": ocur},
        "fixed": fixed,
    }


def _variant(s, fn):
    x = json.loads(json.dumps(s))
    fn(x)
    return x


N_FUZZ = 300
UNIQUES = [{"name": "Mageblood", "type": "Utility Belt"}, {"name": "Headhunter", "type": "Heavy Belt"},
           {"name": "Waistgate", "type": "Wide Belt"}, {"name": "Waistgate", "type": "Heavy Belt"}]


def test_fuzz_realistic_sessions_match_the_oracle_and_hold_the_invariants(monkeypatch):
    rng = random.Random(0x5EED)
    div, ex_per_div = _market(rng)
    prices = _prices_through_the_app(monkeypatch, div, ex_per_div)["prices"]
    for c, px in div.items():
        assert _close(prices[c], px), f"{c}: the app prices it at {prices[c]}, the market at {px}"
    strats = [_rand_strat(rng, div, f"f{i}") for i in range(N_FUZZ)]
    for i in range(0, 50, 10):       # the save path, on samples of ten (each is a real PUT + GET)
        _save_and_reload(_doc(*strats[i:i + 10]))

    def more_loot(x): x["loot"][0]["qty"] += 1
    def more_map(x): x["maps"]["count"] += 1
    def flip(x): x["override"]["on"] = not x["override"]["on"]
    cases = [{"calc": _doc(v), "prices": prices, "now": 0}
             for s in strats for v in (s, _variant(s, more_loot), _variant(s, more_map), _variant(s, flip))]
    out = [r["strats"][0] for r in _js("tally", cases)]

    for i, s in enumerate(strats):
        t, up, down, flipped = out[4 * i: 4 * i + 4]
        want = _oracle(s, div)
        for k in ("loot", "costs", "net", "perHour"):
            assert math.isfinite(t[k]), (i, k, t[k])
            assert _close(t[k], want[k]), (i, k, t[k], want[k])
        assert _close(t["perHour"] * t["hours"], t["net"]), (i, "rate × hours = net")
        assert up["net"] >= t["net"], (i, "more loot never lowers net")
        assert down["net"] <= t["net"] + 1e-9, (i, "one more map never raises net")
        if s["override"]["on"]:
            assert _close(down["net"], t["net"]), (i, "with the override on, maps run doesn't move the cost")
        assert _close(flipped["loot"], t["loot"]) and _close(flipped["fixed"], t["fixed"]), \
            (i, "the override only replaces the maps + tablets cost")
        assert t["unpriced"] == []


def test_fuzz_an_unpriced_item_is_left_out_and_named(monkeypatch):
    rng = random.Random(7)
    div, ex_per_div = _market(rng)
    prices = _prices_through_the_app(monkeypatch, div, ex_per_div)["prices"]
    strats = []
    for i in range(60):
        s = _rand_strat(rng, div, f"u{i}")
        s["loot"].append({"cur": "not-a-currency", "name": None, "qty": rng.randint(1, 50), "price": None})
        strats.append(s)
    out = [r["strats"][0] for r in _js("tally", [{"calc": _doc(s), "prices": prices, "now": 0} for s in strats])]
    for s, t in zip(strats, out):
        want = _oracle({**s, "loot": [r for r in s["loot"] if r["cur"] != "not-a-currency"]}, div)
        assert t["unpriced"] == ["not-a-currency"]
        assert _close(t["net"], want["net"]), "an unpriced row is left out, never priced at 0 or at a guess"


def test_fuzz_a_running_clock_never_goes_backwards_and_waits_a_minute_for_a_rate(monkeypatch):
    rng = random.Random(11)
    div, ex_per_div = _market(rng)
    prices = _prices_through_the_app(monkeypatch, div, ex_per_div)["prices"]
    cases, expect = [], []
    for i in range(60):
        s = _rand_strat(rng, div, f"r{i}")
        t0 = 1_700_000_000_000 + rng.randint(0, 10**9)
        banked = rng.choice([0, rng.randint(0, 3 * H)])
        s["timer"] = {"startedAt": t0, "elapsedMs": banked}
        for now in sorted(t0 + rng.randint(0, 4 * H) for _ in range(5)):
            cases.append({"calc": _doc(s), "prices": prices, "now": now})
            expect.append(banked + (now - t0))
    out = [r["strats"][0] for r in _js("tally", cases)]
    for i in range(0, len(out), 5):
        hours = [o["hours"] for o in out[i: i + 5]]
        assert hours == sorted(hours), "the clock only moves forward"
    for o, ms in zip(out, expect):
        assert _close(o["hours"], ms / H)
        assert (o["perHour"] is None) == (ms < MIN)


def test_fuzz_sidebar_actions_always_save_and_keep_one_timer(monkeypatch):
    """Random sequences of what the sidebar does. Every document the view would save is accepted by
    the backend and survives a reload; never two clocks running; time only moves forward."""
    rng = random.Random(23)
    div, ex_per_div = _market(rng)
    prices = _prices_through_the_app(monkeypatch, div, ex_per_div)["prices"]
    scripts = []
    for k in range(40):
        ids, n, now, steps = [], 0, 1_700_000_000_000, []
        for _ in range(rng.randint(10, 60)):
            now += rng.randint(1, 20 * MIN)
            ops = ["new"] + (["dup", "toggle", "toggle", "select", "rename", "loot", "loot", "custom", "map", "map",
                              "mapprice", "tablet", "tabletedit", "untablet", "link", "linkprice", "unlink", "mapslink", "mapsprice", "mapsunlink", "share", "cur", "override", "remove", "undo", "unique", "floor",
                              "folder", "move", "move", "unfolder", "deepfolder"] if ids else [])
            op = rng.choice(ops)
            st = {"op": op, "now": now, "id": rng.choice(ids) if ids else None}
            if op in ("new", "dup"):
                n += 1
                st["newId"] = f"k{k}-{n}"
                st["name"] = f"Strat {n}"
                ids.append(st["newId"])
            elif op == "rename":
                st["name"] = rng.choice(["Ritual chains", "  Abyss  ", "", "Breach " * 3, "x" * 300, "y" * 119])   # long names: review #2
            elif op == "loot":
                st["cur"], st["qty"] = rng.choice(sorted(div)), rng.randint(0, 5000)
            elif op == "custom":
                st["name"], st["price"] = rng.choice(["Rakiata's Flow", "Heart of the Well", "A unique", "z" * 400]), _logu(rng, 0.01, 300)
            elif op == "mapprice":
                st["price"] = round(rng.uniform(0, 20), 3)
            elif op == "tablet":
                n += 1
                st["newId"] = f"k{k}-t{n}"
            elif op in ("link", "linkprice", "unlink", "mapslink", "mapsprice", "mapsunlink", "share"):
                st["pick"] = rng.randint(0, 9)
                st["div"] = rng.choice([round(_logu(rng, 0.001, 50), 4), None, -1])
                st["query"] = rng.choice([
                    {"query": {"status": {"option": "securable"}, "type": "Breach Tablet", "stats": [{"type": "and", "filters": [{"id": "explicit.stat_1", "value": {"min": rng.randint(1, 40)}}]}]}, "sort": {"price": "asc"}},
                    {"query": {"filters": {"type_filters": {"filters": {"category": {"option": "map.tablet"}}}}}},
                    {"query": {"x": "y" * 25_000}},   # over the limit: never linked
                ])
            elif op in ("tabletedit", "untablet"):
                name, base = rng.choice(TABLET_KINDS)
                st["pick"] = rng.randint(0, 9)
                st["patch"] = rng.choice([{"slots": rng.randint(-1, 6)}, {"name": name, "base": base},
                                          {"price": round(rng.uniform(0, 50), 2)}, {"cur": rng.choice(["chaos", "exalted", "divine"])}])
            elif op == "folder":
                n += 1
                st["newId"], st["name"] = f"k{k}-f{n}", rng.choice(["Breach", "Ritual", "Juiced"])
            elif op in ("move", "unfolder", "deepfolder"):
                st["pick"], st["index"], st["toRoot"] = rng.randint(0, 99), rng.randint(0, 3), rng.random() < 0.3
            elif op in ("unique", "floor"):
                st["u"] = rng.choice(UNIQUES)
                st["listings"] = [{"amount": round(_logu(rng, 1, 5000), 2), "currency": rng.choice(["divine", "exalted", "chaos"])}
                                  for _ in range(rng.randint(0, 10))]
            elif op == "cur":
                st["part"], st["cur"] = rng.choice(["maps", "override"]), rng.choice(["chaos", "exalted", "divine"])
            steps.append(st)
        scripts.append({"steps": steps, "prices": prices})
    runs = _js("actions", scripts)
    for script, docs in zip(scripts, runs):
        for step, d in zip(script["steps"], docs):
            assert d["running"] <= 1, (step, "two strats running at once")
            assert d["roundtrip"], (step, "the document reloads exactly as it was", _first_diff(d["back"], d["doc"]))
            err = stratcalc.validate(d["doc"])
            assert err is None, (step, err)
        _save_and_reload(docs[-1]["doc"])          # and the backend really stores the last one


# ------------------------------------------------------------------ a lineage support gem
def test_a_lineage_gem_is_priced_through_the_one_value_table(monkeypatch):
    """Lineage support gems are registry currencies (category "Lineage Support Gems"), priced by
    Graph.values like any other: the calculator needs no second price source for them."""
    div = {"divine": 1.0, "exalted": 1 / EX_PER_DIV, "chaos": 0.125, "ataluis-bloodletting": 4.5}
    body = _prices_through_the_app(monkeypatch, div)
    assert _close(body["prices"]["ataluis-bloodletting"], 4.5)
    s = _strat_from_profile({"name": "Lineage test", "minutes": 60, "maps": {"count": 10, "price": 0, "cur": "chaos"},
                             "tablets": {"perMap": 0, "price": 0, "cur": "chaos"}, "override": None,
                             "loot": [{"cur": "ataluis-bloodletting", "qty": 2}, {"cur": "divine", "qty": 1}]})
    doc = _save_and_reload(_doc(s))
    [res] = _js("tally", [{"calc": doc, "prices": body["prices"], "now": 0}])
    assert _close(res["strats"][0]["loot"], 10.0)
    assert _close(res["strats"][0]["perHour"], 10.0)


def test_a_unique_is_valued_at_the_cheapest_listing_its_search_found(monkeypatch):
    """The price floor end to end: listings (what the desktop's trade search returns) → divines through
    the one value table → a saved floor on the row → the strat's profit; a typed price still wins."""
    div = {"divine": 1.0, "exalted": 1 / EX_PER_DIV, "chaos": 0.125}
    prices = _prices_through_the_app(monkeypatch, div)["prices"]
    listings = [{"amount": 150, "currency": "divine"}, {"amount": 140 * EX_PER_DIV, "currency": "exalted"}, {"amount": 1200, "currency": "chaos"}]
    s = _strat_from_profile({"name": "Uniques", "minutes": 60, "maps": {"count": 0, "price": 0, "cur": "chaos"},
                             "tablets": {"perMap": 0, "price": 0, "cur": "chaos"}, "override": None, "loot": []})
    s["loot"] = [{"cur": None, "name": "Mageblood", "base": "Utility Belt", "qty": 1, "price": None, "floor": None}]
    cases = [{"calc": _doc(s), "prices": prices, "now": 0}]
    floor = min(listings, key=lambda x: x["amount"] * div[x["currency"]])
    want = floor["amount"] * div[floor["currency"]]
    s2 = json.loads(json.dumps(s)); s2["loot"][0]["floor"] = {"div": want, "at": 1}
    s3 = json.loads(json.dumps(s2)); s3["loot"][0]["price"] = 99.0
    for v in (s2, s3):
        _save_and_reload(_doc(v))
        cases.append({"calc": _doc(v), "prices": prices, "now": 0})
    unpriced, floored, typed = [r["strats"][0] for r in _js("tally", cases)]
    assert unpriced["unpriced"] == ["unique:Mageblood|Utility Belt"], "no floor yet: unpriced, never free"
    assert _close(want, 140.0), "the cheapest of the three, in divines (140 div of exalted)"
    assert _close(floored["loot"], 140.0)
    assert _close(typed["loot"], 99.0), "your price wins"


# ------------------------------------------------------------------ tablet setups
def test_a_mixed_tablet_setup_spreads_each_tablet_over_its_own_full_uses(monkeypatch):
    """owner, 2026-10-01: "sometimes they add in a unique tablet, sometimes they add in 2 or 3 kinds of
    tablets". poe2db pages → pipeline → endpoint → tally: 30 maps with two Breach tablets (10 uses),
    Freedom of Faith (5) and Mastered Domain (1)."""
    div = {"divine": 1.0, "exalted": 1 / EX_PER_DIV, "chaos": 0.125}
    body = _prices_through_the_app(monkeypatch, div)
    uses = body["uses"]
    assert {"name": None, "base": "Breach Tablet", "uses": 10} in uses
    assert {"name": "Freedom of Faith", "base": "Ritual Tablet", "uses": 5} in uses
    assert {"name": "Mastered Domain", "base": "Irradiated Tablet", "uses": 1} in uses
    s = _strat_from_profile({"name": "Mixed tablets", "minutes": 60, "maps": {"count": 30, "price": 0, "cur": "chaos"},
                             "tablets": {"lines": [
                                 {"id": "a", "base": "Breach Tablet", "name": None, "slots": 2, "price": 8, "cur": "chaos"},       # 6 × 1 div
                                 {"id": "b", "base": "Ritual Tablet", "name": "Freedom of Faith", "slots": 1, "price": 2, "cur": "divine"},   # 6 × 2
                                 {"id": "c", "base": "Irradiated Tablet", "name": "Mastered Domain", "slots": 1, "price": 0.5, "cur": "divine"},  # 30 × 0.5
                             ]}, "override": None, "loot": [{"cur": "divine", "qty": 100}]})
    doc = _save_and_reload(_doc(s))
    [res] = _js("tally", [{"calc": doc, "prices": body["prices"], "now": 0}])
    t = res["strats"][0]
    assert _close(t["tablets"], 6 + 12 + 15)
    assert _close(t["perHour"], 100 - 33)
    assert t["unpriced"] == []


def test_a_unique_tablet_the_pipeline_could_not_read_is_unpriced_not_guessed(monkeypatch):
    """Forgotten By Time has no sample item on poe2db, so the pipeline stores no uses for it."""
    body = _prices_through_the_app(monkeypatch, {"divine": 1.0, "exalted": 1 / EX_PER_DIV, "chaos": 0.125})
    assert not any(u["name"] == "Forgotten By Time" for u in body["uses"])
    s = _strat_from_profile({"name": "FBT", "minutes": 60, "maps": {"count": 10, "price": 0, "cur": "chaos"},
                             "tablets": {"lines": [{"id": "a", "base": "Expedition Tablet", "name": "Forgotten By Time", "slots": 1, "price": 3, "cur": "divine"}]},
                             "override": None, "loot": []})
    [res] = _js("tally", [{"calc": _save_and_reload(_doc(s)), "prices": body["prices"], "now": 0}])
    assert res["strats"][0]["unpriced"] == ["tablet:Forgotten By Time"]
    assert res["strats"][0]["tablets"] == 0
