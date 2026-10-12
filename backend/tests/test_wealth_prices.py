"""/api/status carries the anchor prices (reference per unit) the UI's wealth-display rule needs."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from starlette.testclient import TestClient  # noqa: E402
from app import arbitrage  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)


def test_status_has_wealth_prices_with_the_reference_at_one():
    s = client.get("/api/status").json()
    assert s["wealth_prices"][s["reference"]] == 1.0
    assert set(s["wealth_prices"]) <= {"exalted", "chaos", "divine", "mirror", "hinekoras-lock"}


def test_anchor_prices_reads_the_cached_graph(monkeypatch):
    from tests.test_arbitrage_golden import _synthetic_graph, SETTINGS
    from app import db
    db.kv_set("settings", SETTINGS)
    arbitrage.invalidate_caches()
    g = _synthetic_graph()
    monkeypatch.setattr(arbitrage.graph, "cached_graph", lambda *a, **k: g)
    monkeypatch.setattr(arbitrage, "cached_graph", lambda *a, **k: g)
    p = arbitrage.anchor_prices()
    # the anchors are read off the graph's ONE value table (Graph.values), never a second source
    V = g.values()
    assert p["exalted"] == 1.0 and p["divine"] == V["divine"] and p["chaos"] == V["chaos"]
    db.kv_set("settings", {})
    arbitrage.invalidate_caches()


def test_the_stash_unit_choices_are_all_priced_and_the_choice_is_a_plain_setting(monkeypatch):
    """Owner, 2026-10-12: the stash may be valued in exalted, chaos, divine, Hinekora's Lock or mirror."""
    from app import settings, main
    from app.arbitrage import graph as graph_mod

    class G:
        def values(self):
            return {"exalted": 1.0, "chaos": 40.0, "divine": 700.0, "hinekoras-lock": 90000.0, "mirror": 4e6, "vaal": 3.0}
    monkeypatch.setattr(graph_mod, "cached_graph", lambda *a, **k: G())
    p = arbitrage.anchor_prices()
    assert p["hinekoras-lock"] == 90000.0 and p["mirror"] == 4e6 and "vaal" not in p
    assert settings.DEFAULTS["stash_unit"] is None, "no choice: the wealth rule picks"
    assert settings._merged({"stash_unit": "mirror"})["stash_unit"] == "mirror"
    assert "stash_unit" in main.SETTINGS_OUTSIDE_THE_GRAPH, "a display choice rebuilds nothing"
