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
    assert set(s["wealth_prices"]) <= {"exalted", "chaos", "divine", "mirror"}


def test_anchor_prices_reads_the_cached_graph(monkeypatch):
    from tests.test_arbitrage_golden import _synthetic_graph, SETTINGS
    from app import db
    db.kv_set("settings", SETTINGS)
    arbitrage.invalidate_caches()
    g = _synthetic_graph()
    monkeypatch.setattr(arbitrage.graph, "cached_graph", lambda: g)
    monkeypatch.setattr(arbitrage, "cached_graph", lambda: g)
    p = arbitrage.anchor_prices()
    assert p["exalted"] == 1.0 and p["divine"] == g.ref_values()["divine"] and p["chaos"] == g.ref_values()["chaos"]
    db.kv_set("settings", {})
    arbitrage.invalidate_caches()
