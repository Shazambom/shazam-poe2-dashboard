"""Endpoint-level smoke tests for the Phase 3/4 read surfaces — the layer the pure unit tests don't
cover (they'd miss a wiring bug like a missing import in main.py, which is exactly what slipped
through once). Uses Starlette's TestClient WITHOUT the lifespan context manager, so no backfill /
sidecar startup runs — just the route handlers against an empty (schema-only) market DB.

Run:  DATA_DIR=$(mktemp -d) MARKET_SEED= .venv-test/bin/python -m pytest backend/tests/test_signals_api.py -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from starlette.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)   # NOT used as a context manager → lifespan (backfill/sidecar) never runs


def test_signals_endpoint_degrades_to_empty():
    r = client.get("/api/signals")
    assert r.status_code == 200
    body = r.json()
    assert body["signals"] == [] and body["unseen"] == 0 and "league" in body


def test_signals_ack_all_is_ok_when_empty():
    r = client.post("/api/signals/ack", json={"all": True})
    assert r.status_code == 200 and r.json() == {"ok": True, "unseen": 0}


def test_leaguearc_and_arc_endpoints_respond():
    r = client.get("/api/leaguearc")
    assert r.status_code == 200 and {"league", "day", "phase"} <= r.json().keys()
    r2 = client.get("/api/arc", params={"item": "Divine Orb"})
    assert r2.status_code == 200
    body = r2.json()
    assert body["item"] == "Divine Orb" and "arc" in body and "history" in body


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
