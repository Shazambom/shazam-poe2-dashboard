"""Batch 5 — the backend owns the ONE pathofexile.com rate budget (audit F-E1).

Electron's live-search engine reserves a slot via POST /api/ratelimits/acquire before each trade
fetch/whisper and reports the response's X-Rate-Limit headers via POST /api/ratelimits/observe,
so both processes share gateway.Policy state instead of each parsing headers alone.

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_ratelimits_api.py -q
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from starlette.testclient import TestClient  # noqa: E402
from app import gateway  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)


def _fresh(name):
    p = gateway.POLICIES[name]
    p.penalty_until = 0.0
    p.limiter = gateway.Limiter(p.rates)
    return p


def test_trade_fetch_and_whisper_policies_exist_with_the_trade_host():
    for name in ("trade-fetch", "trade-whisper"):
        assert "www.pathofexile.com" in gateway.POLICIES[name].hosts
    # host lookup without an override still resolves to the exchange policy (first match)
    assert gateway.policy_for("https://www.pathofexile.com/api/trade2/exchange/poe2/X").name == "trade"


def test_acquire_is_non_blocking_and_refuses_when_the_window_is_spent():
    p = _fresh("trade-whisper")
    ok = [client.post("/api/ratelimits/acquire", json={"policy": "trade-whisper"}).json() for _ in range(3)]
    assert ok[0]["ok"] is True
    refused = [r for r in ok if not r["ok"]]
    assert refused, "the conservative default (1 per 2s) must refuse a burst"
    assert refused[0]["retry_after_s"] > 0
    assert p.requests >= 1


def test_acquire_refuses_during_a_penalty():
    p = _fresh("trade-fetch")
    p.penalize(30, "test")
    r = client.post("/api/ratelimits/acquire", json={"policy": "trade-fetch"}).json()
    assert r["ok"] is False and 25 < r["retry_after_s"] <= 31
    p.penalty_until = 0.0


def test_observe_applies_headers_and_429s():
    p = _fresh("trade-fetch")
    r = client.post("/api/ratelimits/observe", json={
        "policy": "trade-fetch", "status": 200,
        "headers": {"X-Rate-Limit-Rules": "Ip", "X-Rate-Limit-Ip": "12:6:60,16:12:120",
                    "X-Rate-Limit-Ip-State": "1:6:0,1:12:0"}})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert p.advertised == [(12, 6, 60), (16, 12, 120)]
    r = client.post("/api/ratelimits/observe", json={"policy": "trade-fetch", "status": 429,
                                                     "headers": {"Retry-After": "20"}})
    assert r.json()["ok"] is True
    assert p.penalty_until - time.time() > 15
    p.penalty_until = 0.0


def test_unknown_policy_is_404():
    assert client.post("/api/ratelimits/acquire", json={"policy": "nope"}).status_code == 404
    assert client.post("/api/ratelimits/observe", json={"policy": "nope", "status": 200, "headers": {}}).status_code == 404
