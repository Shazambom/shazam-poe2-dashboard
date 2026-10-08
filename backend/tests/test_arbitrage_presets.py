"""Arbitrage presets (docs/learnability-plan.md part 4): six owner-tuned sets of the Arbitrage page's values,
defined once in settings.py. Balanced is the default and replaces every user's saved arbitrage values once (m8).
Currency thresholds are in exalted whatever the user's reference currency, so a preset means the same for everyone.

The expected values below are copied from the owner's tuning session (packaged app, 2026-10-05), not from the code.
"""
import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import db, migrations_user, settings  # noqa: E402
from app.arbitrage import routes  # noqa: E402

OWNER = {
    "balanced": ("Balanced", dict(min_margin_pct=20, max_gold=0, min_margin_per_1k_gold=0, min_liquidity_ref=1000,
                                  min_volume_ref_per_h=100, max_step_minutes=60),
                 3, (0.6, 0.2, 0.35, 0.3), 2, 72, 2, 0.009527348253160697),
    # Owner, 2026-10-08, read from their running app: Balanced's filters, ranked by yield (velocity) alone.
    "high_yield": ("High Yield", dict(min_margin_pct=20, max_gold=0, min_margin_per_1k_gold=0, min_liquidity_ref=1000,
                                      min_volume_ref_per_h=100, max_step_minutes=60),
                   3, (1, 0, 0, 0), 2, 72, 2, 0.009527348253160697),
    "quick": ("Quick flips", dict(min_margin_pct=5, max_gold=1000000, min_margin_per_1k_gold=0.41, min_liquidity_ref=200,
                                  min_volume_ref_per_h=10000, max_step_minutes=15),
              3, (0.8, 0.2, 0.4, 0.4), 2, 24, 2, 0.009098518761145686),
    "big": ("Big margins", dict(min_margin_pct=66, max_gold=2000000, min_margin_per_1k_gold=0, min_liquidity_ref=2000,
                                min_volume_ref_per_h=2000, max_step_minutes=45),
            3, (0.2, 0.2, 1.0, 0.35), 2, 24, 3.5, 0.019452225334578275),
    "gold": ("Gold efficient", dict(min_margin_pct=0, max_gold=1000000, min_margin_per_1k_gold=0, min_liquidity_ref=2000,
                                    min_volume_ref_per_h=2000, max_step_minutes=45),
             3, (0.9, 1.0, 0.2, 0.4), 2, 24, 3.5, 0.05),
    "safe": ("Safe", dict(min_margin_pct=8, max_gold=1200000, min_margin_per_1k_gold=0, min_liquidity_ref=10000,
                          min_volume_ref_per_h=5000, max_step_minutes=120),
             3, (0.3, 0.2, 0.5, 1.0), 2, 72, 2, 0.019905251005215174),
}
ZERO = dict(min_margin_ref=0, max_fill_hours=0, min_velocity=0, exclude_recipes=False)


def _expected(pid):
    label, f, steps, w, overhead, window, spread, gold = OWNER[pid]
    return label, {
        "filters": {**ZERO, **f},
        "max_steps": steps,
        "rank_weights": dict(zip(("velocity", "margin_per_1k_gold", "margin_ref", "volume"), w)),
        "step_overhead_min": overhead, "volume_window_h": window, "wide_spread": spread, "gold_value_per_1k": gold,
    }


def test_the_six_presets_in_order_with_the_owners_values():
    assert [p["id"] for p in settings.ARBITRAGE_PRESETS] == ["balanced", "high_yield", "quick", "big", "gold", "safe"]
    for p in settings.ARBITRAGE_PRESETS:
        label, values = _expected(p["id"])
        assert p["label"] == label
        assert p["values"] == values, p["id"]


def test_a_preset_never_carries_the_users_own_choices():
    for p in settings.ARBITRAGE_PRESETS:
        assert not {"start", "limit", "sort", "live_only"} & set(p["values"]["filters"])
        assert "max_start_fraction" not in p["values"]


def test_balanced_is_the_default():
    _, bal = _expected("balanced")
    d = settings.DEFAULTS
    for k, v in bal.items():
        if k == "filters":
            assert {fk: d["filters"][fk] for fk in v} == v
        else:
            assert d[k] == v, k
    # the user's own filter choices keep their defaults
    assert (d["filters"]["sort"], d["filters"]["limit"], d["filters"]["live_only"]) == ("score", 100, False)


# --- m8: Balanced replaces every saved arbitrage value once --------------------------------------

def _conn(tmp_path, stored):
    c = sqlite3.connect(str(tmp_path / "u.sqlite"))
    c.executescript(db.USER_SCHEMA)
    if stored is not None:
        c.execute("INSERT INTO kv(key, value) VALUES('settings', ?)", (json.dumps(stored),))
    return c


def _stored(c):
    return json.loads(c.execute("SELECT value FROM kv WHERE key='settings'").fetchone()[0])


OLD = {
    "reference": "exalted", "theme": "ember", "max_start_fraction": 0.5,
    "max_steps": 5, "rank_weights": {"velocity": 0.1, "margin_per_1k_gold": 0.9, "margin_ref": 0.0, "volume": 0.0},
    "step_overhead_min": 7, "volume_window_h": 6, "wide_spread": 4, "gold_value_per_1k": 0.2,
    "filters": {"min_margin_pct": 0.5, "min_liquidity_ref": 50, "max_step_minutes": 0, "exclude_recipes": True,
                "start": "divine", "limit": 40, "sort": "velocity", "live_only": True},
}


def test_m8_replaces_saved_arbitrage_values_with_balanced(tmp_path):
    c = _conn(tmp_path, OLD)
    migrations_user._m8_arbitrage_balanced(c)
    s = _stored(c)
    _, bal = _expected("balanced")
    for k, v in bal.items():
        if k == "filters":
            assert {fk: s["filters"][fk] for fk in v} == v
        else:
            assert s[k] == v, k
    # the user's own choices and everything outside arbitrage are untouched
    assert {k: s["filters"][k] for k in ("start", "limit", "sort", "live_only")} == \
        {"start": "divine", "limit": 40, "sort": "velocity", "live_only": True}
    assert (s["max_start_fraction"], s["theme"], s["reference"]) == (0.5, "ember", "exalted")


def test_m8_runs_once_so_a_later_edit_sticks(tmp_path):
    c = _conn(tmp_path, OLD)
    migrations_user._m8_arbitrage_balanced(c)
    s = _stored(c)
    s["filters"]["min_margin_pct"] = 9
    c.execute("UPDATE kv SET value=? WHERE key='settings'", (json.dumps(s),))
    migrations_user._m8_arbitrage_balanced(c)
    assert _stored(c)["filters"]["min_margin_pct"] == 9


def test_m8_tolerates_no_settings_and_is_registered(tmp_path):
    migrations_user._m8_arbitrage_balanced(_conn(tmp_path, None))   # a fresh install: nothing to replace
    assert any(n == 8 for n, _d, _f in migrations_user.USER_MIGRATIONS)
    assert any(f is migrations_user._m8_arbitrage_balanced for _n, _d, f in migrations_user.USER_MIGRATIONS)


# --- thresholds are in exalted whatever the reference ------------------------------------------

def test_currency_thresholds_scale_from_exalted_to_the_reference():
    f = {"min_margin_pct": 20, "min_margin_ref": 2, "min_liquidity_ref": 1000, "min_volume_ref_per_h": 100,
         "min_velocity": 3, "min_margin_per_1k_gold": 0.4, "max_gold": 5000, "max_step_minutes": 60}
    # reference = divine and 1 exalted is worth 0.01 divine: every currency amount shrinks 100x; the rest stays
    out = routes.thresholds_in_reference(f, ex_in_ref=0.01)
    assert out == {"min_margin_pct": 20, "min_margin_ref": 0.02, "min_liquidity_ref": 10.0, "min_volume_ref_per_h": 1.0,
                   "min_velocity": 0.03, "min_margin_per_1k_gold": pytest.approx(0.004), "max_gold": 5000,
                   "max_step_minutes": 60}
    assert routes.thresholds_in_reference(f, ex_in_ref=1.0) == f    # exalted reference: unchanged


def test_a_divine_reference_user_gets_the_same_loops_as_an_exalted_one():
    # one loop, liquidity 15 divine == 1500 exalted when 1 ex = 0.01 div: Balanced's 1000-exalted floor keeps it,
    # and a 2000-exalted floor drops it, exactly as for an exalted-reference user looking at 1500 ex
    r = {"margin_pct": 30, "margin_ref": 1, "gold": 0, "gold_free": True, "margin_per_1k_gold": None,
         "liquidity_ref": 15, "all_live": True, "volume_ref_per_h": 50, "fill_hours": 0.5, "slowest_step_hours": 0.2,
         "velocity": None, "velocity_inf": True, "uses_recipe": False}
    keep = lambda floor: routes._keep(r, routes.thresholds_in_reference(
        {"min_liquidity_ref": floor, "min_volume_ref_per_h": 100}, ex_in_ref=0.01))
    assert keep(1000) is True
    assert keep(2000) is False


# --- served to the page ---------------------------------------------------------------------------

def test_presets_endpoint_serves_the_one_definition():
    from starlette.testclient import TestClient
    from app.main import app
    got = TestClient(app).get("/api/arbitrage/presets").json()
    assert got == settings.ARBITRAGE_PRESETS


def test_the_search_applies_the_conversion(monkeypatch):
    class StubGraph:
        s = settings._merged({"reference": "divine"})
        adj = {}
        def values(self):
            return {"divine": 1.0, "exalted": 0.01}
    monkeypatch.setattr(routes.graph, "cached_graph", lambda volume_window_h=None: StubGraph())
    monkeypatch.setattr(routes, "loop_currencies", lambda g, v: set())
    monkeypatch.setattr(routes.db, "get_capital", lambda: {})
    f = routes._search_setup({"min_liquidity_ref": 1000, "min_margin_pct": 20}, None)[2]
    assert f["min_liquidity_ref"] == pytest.approx(10.0)       # 1000 exalted, in divine
    assert f["min_margin_pct"] == 20                          # a ratio: unchanged


def test_any_import_order_boots_a_database_that_needs_m8(tmp_path):
    """db.py runs the user migrations as it loads; m8 must not import a module that is mid-import then
    (settings → db → migrations → settings crashed a process whose first import was `settings`)."""
    import subprocess
    d = tmp_path / "data"
    d.mkdir()
    c = sqlite3.connect(str(d / "user.sqlite"))
    c.executescript(db.USER_SCHEMA)
    c.execute("INSERT INTO kv(key, value) VALUES('settings', ?)", (json.dumps({"max_steps": 5}),))
    c.execute("INSERT INTO user_meta(key, value) VALUES('schema_version', '7')")
    c.commit(); c.close()
    for first in ("settings", "db", "migrations_user", "main"):
        r = subprocess.run([sys.executable, "-c", f"from app import {first}"], cwd=Path(__file__).resolve().parents[1],
                           env={"DATA_DIR": str(d), "MARKET_SEED": "", "PATH": "/usr/bin:/bin"}, capture_output=True, text=True)
        assert r.returncode == 0, f"import {first} first: {r.stderr[-400:]}"


# --- the volume window is the loop search's, never the market's (code review 2026-10-05) ------------------

def test_the_market_graph_keeps_its_own_volume_window_whatever_the_arbitrage_preset(monkeypatch):
    """volume_window_h is an Arbitrage knob (presets: 24 or 72). The shared market graph — Board, Hold, Convert,
    Capital, every price — reads volumes over a fixed MARKET_VOLUME_WINDOW_H, so picking a preset never moves them;
    only the route search builds its graph over the preset's window."""
    from app import digest, settings as S
    from app.arbitrage import graph
    seen = []
    monkeypatch.setattr(digest, "pair_volume", lambda league, hours: seen.append(hours) or {})
    monkeypatch.setattr(digest, "latest_rates", lambda league, age: {})
    monkeypatch.setattr(graph.gamedata, "fees", lambda: {"by_trade": {}})
    monkeypatch.setattr(S, "get_settings", lambda: S._merged({"volume_window_h": 72}))
    monkeypatch.setattr(graph, "get_settings", lambda: S._merged({"volume_window_h": 72}))
    graph.cache.clear(graph._graph_cache)
    graph.cached_graph()
    assert seen == [graph.MARKET_VOLUME_WINDOW_H] == [24]
    seen.clear()
    graph.cached_graph(volume_window_h=72)
    assert seen == [72], "the route search's own graph, over the preset's window"
    seen.clear()
    graph.cached_graph()
    assert seen == [], "the market graph is still cached: the two never share a cache entry"


def test_the_route_search_builds_over_the_presets_window(monkeypatch):
    asked = []

    class StubGraph:
        s = settings._merged({})
        adj = {}
        def values(self):
            return {"exalted": 1.0}
    monkeypatch.setattr(routes.graph, "cached_graph", lambda volume_window_h=None: asked.append(volume_window_h) or StubGraph())
    monkeypatch.setattr(routes, "get_settings", lambda: settings._merged({"volume_window_h": 72}))
    monkeypatch.setattr(routes, "loop_currencies", lambda g, v: set())
    monkeypatch.setattr(routes.db, "get_capital", lambda: {})
    routes._search_setup({}, None)
    assert asked == [72]


def test_m9_resets_the_values_stable_can_no_longer_edit(tmp_path):
    """Code review (2026-10-08): stable builds hide the recipe/digest switches, the gold overrides and "Show at most"
    (beta and dev keep them). A user who had changed one would keep that state with no control left to change it, so
    the upgrade sets those values back to the defaults once, the way m8 did for the presets. Everything else stays."""
    s = dict(OLD, allow_digest_edges=False, allow_recipe_edges=False,
             gold_model={"base_per_order": 50, "per_unit": {"chaos": 7}, "per_ref_unit": 3, "fee_side": "sell"})
    s["filters"] = {**OLD["filters"], "limit": 5}
    c = _conn(tmp_path, s)
    migrations_user._m9_reset_hidden_knobs(c)
    got = _stored(c)
    assert (got["allow_digest_edges"], got["allow_recipe_edges"]) == (True, True)
    assert got["gold_model"] == settings.DEFAULTS["gold_model"]
    assert got["filters"]["limit"] == settings.DEFAULTS["filters"]["limit"]
    assert got["filters"]["start"] == "divine" and got["theme"] == "ember", "the user's other choices stay"
    assert got["_hidden_knobs_reset_v1"] is True
    got["filters"]["limit"] = 7
    c.execute("UPDATE kv SET value=? WHERE key='settings'", (json.dumps(got),))
    migrations_user._m9_reset_hidden_knobs(c)
    assert _stored(c)["filters"]["limit"] == 7, "runs once: a later edit on beta/dev sticks"
    (tmp_path / "fresh").mkdir()
    migrations_user._m9_reset_hidden_knobs(_conn(tmp_path / "fresh", None))
    assert migrations_user.USER_MIGRATIONS[-1][0] == 9
