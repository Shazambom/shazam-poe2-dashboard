"""Sales ledger (trading roadmap batch 6): migration 5, idempotent upsert, league filter, endpoints.

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_sales.py -q
"""
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from starlette.testclient import TestClient  # noqa: E402
from app import db, migrations_user  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)

ROW = {"time": "2026-09-16T20:11:03Z", "item_id": "abc123",
       "item": {"name": "Hate Pelt", "typeLine": "Vaal Regalia", "rarity": "Rare", "frameType": 2, "ilvl": 82,
                "properties": [{"name": "Energy Shield", "values": [["512", 1]], "displayMode": 0}],
                "explicitMods": ["+120 to maximum Life"]},
       "price": {"amount": 3, "currency": "divine"}}


def test_m5_creates_the_table_and_is_idempotent(tmp_path):
    c = sqlite3.connect(str(tmp_path / "u.sqlite"))
    c.executescript(db.USER_SCHEMA)
    migrations_user._m5_sales(c)
    migrations_user._m5_sales(c)
    cols = [r[1] for r in c.execute("PRAGMA table_info(sales)")]
    assert cols == ["item_id", "time", "league", "price_amount", "price_currency", "item_json"]
    assert migrations_user.USER_MIGRATIONS[-1][0] == 5


def test_ingest_is_idempotent_and_filters_by_league():
    r1 = client.post("/api/sales/ingest", json={"league": "L1", "result": [ROW, {**ROW, "item_id": "def"}]}).json()
    assert r1["ok"] and r1["new"] == 2 and r1["total"] == 2
    r2 = client.post("/api/sales/ingest", json={"league": "L1", "result": [ROW]}).json()
    assert r2["new"] == 0 and r2["total"] == 2, "same item_id+time twice → one row"
    client.post("/api/sales/ingest", json={"league": "L2", "result": [{**ROW, "item_id": "zzz"}]})
    got = client.get("/api/sales?league=L1").json()
    assert [r["item_id"] for r in got["rows"]] == ["abc123", "def"] or sorted(r["item_id"] for r in got["rows"]) == ["abc123", "def"]
    assert got["rows"][0]["item"]["name"] == "Hate Pelt" and got["rows"][0]["price"] == {"amount": 3, "currency": "divine"}
    assert set(got["leagues"]) == {"L1", "L2"}
    assert len(client.get("/api/sales").json()["rows"]) == 3
    assert client.post("/api/sales/ingest", json={"league": " ", "result": []}).status_code == 400


def test_rows_without_identity_are_skipped():
    r = client.post("/api/sales/ingest", json={"league": "L3", "result": [{"item": {}}, {"item_id": "x"}]}).json()
    assert r["new"] == 0 and r["total"] == 0


def test_new_sales_credit_capital_once():
    db.set_capital({"divine": 10})
    r = client.post("/api/sales/ingest", json={"league": "L9", "result": [{**ROW, "item_id": "cap1"}, {**ROW, "item_id": "cap2", "price": {"amount": 40, "currency": "chaos"}}]}).json()
    assert r["new"] == 2 and r["credited"] == 2
    assert db.get_capital() == {"divine": 13, "chaos": 40}
    client.post("/api/sales/ingest", json={"league": "L9", "result": [{**ROW, "item_id": "cap1"}]})   # same sale again
    assert db.get_capital() == {"divine": 13, "chaos": 40}, "a re-fetched sale never credits twice"
    db.set_capital({})
