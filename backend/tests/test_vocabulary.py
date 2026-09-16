"""Batch 7 — the backend owns the vocabulary (audit F-09, F-13, F-24).

  * ONE anchors table (marketseries.ANCHORS): hold numeraires, cross-league items, inflation
    anchors and the sidecar's Divine id all derive from it; /api/currencies exposes it.
  * /api/hold takes the app-wide window_h (clamped to 7d server-side) and still accepts the
    legacy horizon=1d|3d|7d.
  * /api/status carries digest.state / orderbook.feed so the topbar renders a string instead of
    re-deriving staleness with its own thresholds.
  * /api/routes/stream emits provisional `scores` server-side; the meta event no longer ships
    rank_weights for the client to re-implement the ranking.

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_vocabulary.py -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import arbitrage, db, digest, holdscore, inflation, leaguehistory, marketseries, orderbook  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)


def test_one_anchor_table():
    a = marketseries.ANCHORS
    assert set(a) == {"divine", "mirror", "lock", "chaos"}
    assert a["divine"].item_id == 291 and a["lock"].item_id == 4287
    assert a["divine"].metadata_id.endswith("CurrencyModValues")
    assert marketseries.DIVINE_ID == a["divine"].item_id
    assert holdscore.NUMERAIRES == {k: (v.item_id, v.name) for k, v in a.items() if k != "chaos"}
    assert leaguehistory.ITEMS == {v.item_id: v.name for v in a.values()}
    assert leaguehistory.DEFAULT_ITEM == 291 and leaguehistory.MIRROR_ITEM == 295
    assert inflation.ANCHORS == {k: (v.name, v.metadata_id) for k, v in a.items() if k in ("divine", "mirror", "lock")}


def test_currencies_endpoint_exposes_anchors():
    r = client.get("/api/currencies").json()
    assert [x["id"] for x in r["anchors"]] == ["divine", "mirror", "lock", "chaos"]
    assert r["anchors"][2] == {"id": "lock", "item_id": 4287, "name": "Hinekora's Lock",
                               "metadata_id": "Metadata/Items/Currency/CurrencyHinekorasLock"}


def test_inflation_accepts_both_spellings_and_answers_canonically():
    assert client.get("/api/inflation", params={"anchor": "hinekora"}).json()["anchor"] == "lock"
    assert client.get("/api/inflation", params={"anchor": "lock"}).json()["anchor"] == "lock"
    assert client.get("/api/inflation", params={"anchor": "nope"}).json()["anchor"] == "lock"


def test_hold_takes_window_hours_and_clamps_to_7d():
    r = client.get("/api/hold", params={"window_h": 72}).json()
    assert r["horizon"] == "3d" and r["delta_days"] == 3 and r["window_h"] == 72
    r = client.get("/api/hold", params={"window_h": 336}).json()
    assert r["horizon"] == "7d" and r["window_h"] == 168          # clamped: hold is tuned to 7d
    r = client.get("/api/hold", params={"horizon": "1d"}).json()   # legacy spelling still works
    assert r["horizon"] == "1d" and r["window_h"] == 24
    assert client.get("/api/hold").json()["horizon"] == "3d"


def test_status_carries_feed_states(monkeypatch):
    monkeypatch.setitem(digest.state, "last_fetch", None)
    s = client.get("/api/status").json()
    assert s["digest"]["state"] == "waiting"
    import time
    monkeypatch.setitem(digest.state, "last_fetch", time.time() - 10)
    monkeypatch.setitem(digest.state, "last_hour", int(time.time()) - 3600)
    assert client.get("/api/status").json()["digest"]["state"] == "ok"
    monkeypatch.setitem(digest.state, "last_fetch", time.time() - 3 * 3600)
    assert client.get("/api/status").json()["digest"]["state"] == "stale"
    monkeypatch.setitem(orderbook.state, "last_fetch", None)
    assert client.get("/api/status").json()["orderbook"]["feed"] == "idle"
    monkeypatch.setitem(orderbook.state, "last_fetch", time.time() - 10)
    assert client.get("/api/status").json()["orderbook"]["feed"] == "ok"
    monkeypatch.setitem(orderbook.state, "last_fetch", time.time() - 2 * 3600)
    assert client.get("/api/status").json()["orderbook"]["feed"] == "stale"


def test_stream_scores_server_side(monkeypatch):
    from tests.test_arbitrage_golden import SETTINGS, _synthetic_graph
    db.kv_set("settings", SETTINGS)
    arbitrage.invalidate_caches()
    g = _synthetic_graph()
    monkeypatch.setattr(arbitrage, "cached_graph", lambda: g)
    monkeypatch.setattr(db, "get_capital", lambda: {"chaos": 100.0})
    r = client.get("/api/routes/stream")
    events = [l.split(": ", 1)[1] for l in r.text.splitlines() if l.startswith("event:")]
    assert "scores" in events and events.index("scores") < events.index("done")
    meta = next(l for l in r.text.splitlines() if l.startswith("data:"))
    assert "rank_weights" not in meta
    db.kv_set("settings", {})
    arbitrage.invalidate_caches()
