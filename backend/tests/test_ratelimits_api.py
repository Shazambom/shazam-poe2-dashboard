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


def test_hint_folds_an_external_request_into_the_budget_without_penalising():
    """Batch 4-B: an EE2 price check on the same account/IP spends a slot Arbiter didn't make."""
    p = _fresh("trade-fetch")
    p.rates = [gateway.Rate(1, gateway.Duration.SECOND)]   # pin the rule: earlier tests may have re-advertised it
    p.limiter = gateway.Limiter(p.rates)
    before = p.requests
    r = client.post("/api/ratelimits/hint", json={"policy": "trade-fetch"}).json()
    assert r["ok"] is True and p.requests == before + 1
    # the slot really is gone: an immediate reservation on the 1/s rule is refused, with no penalty
    assert client.post("/api/ratelimits/acquire", json={"policy": "trade-fetch"}).json()["ok"] is False
    assert p.penalty_until == 0.0
    assert client.post("/api/ratelimits/hint", json={"policy": "nope"}).status_code == 404


def test_trade_history_policy_starts_very_conservative():
    """The history endpoint penalises for ~1 h and the budget is shared by every machine on the account."""
    p = gateway.POLICIES["trade-history"]
    assert "www.pathofexile.com" in p.hosts
    slowest = max(r.interval for r in p.rates)
    assert slowest >= gateway.Duration.MINUTE * 5, "no more than one history fetch per 5 minutes by default"


def test_trade_search_policy_is_slow_and_reachable_from_electron():
    """Strat Calculator's unique price floor: one item search per unique, background-only, so it starts
    slower than anything a person clicking would do; headers can only tighten or loosen it from there."""
    p = _fresh("trade-search")
    assert "www.pathofexile.com" in p.hosts
    assert min(r.interval / 1000 / r.limit for r in p.rates) >= 10, "at most one search per 10 s on any rule"
    assert client.post("/api/ratelimits/acquire", json={"policy": "trade-search"}).json()["ok"] is True
    assert client.post("/api/ratelimits/acquire", json={"policy": "trade-search"}).json()["ok"] is False, "the second waits"


# Headroom (owner, 2026-10-03: "we should be aware of our headroom"). Reprice's extra listing fetches are a
# nice-to-have, so they ask for spare capacity: refused unless every window the site reports has at least that
# share free. The counts come from the site's own state headers — including the user's own browsing, which the
# trade tap reports through /observe — and a window that has rolled over since it was reported counts as free.
def _observe(p, state, limits="6:4:60,12:12:120", ago=0.0):
    p.observe_headers(200, {"X-Rate-Limit-Rules": "Account", "X-Rate-Limit-Account": limits, "X-Rate-Limit-Account-State": state})
    p.penalty_until = 0.0
    p.last_states_at -= ago


def test_headroom_is_the_tightest_reported_window():
    p = _fresh("trade-fetch")
    _observe(p, "3:4:0,2:12:0")
    assert abs(p.headroom() - 0.5) < 1e-9          # 3 of 6 in the 4 s window; 2 of 12 in the 12 s window
    p2 = _fresh("trade-whisper"); p2.last_states = []
    assert p2.headroom() == 1.0, "nothing reported yet"


def test_a_window_that_rolled_over_since_it_was_reported_counts_as_free():
    p = _fresh("trade-fetch")
    _observe(p, "3:4:0,2:12:0", ago=5)               # 5 s ago: the 4 s window has rolled, the 12 s one has not
    assert abs(p.headroom() - (1 - 2 / 12)) < 1e-9
    _observe(p, "3:4:0,2:12:0", ago=13)
    assert p.headroom() == 1.0


def test_a_spare_request_is_refused_without_headroom_and_takes_no_slot():
    p = _fresh("trade-fetch")
    _observe(p, "4:4:0,2:12:0")                       # 4 of 6: a third free
    before = p.requests
    r = client.post("/api/ratelimits/acquire", json={"policy": "trade-fetch", "spare": 0.5}).json()
    assert r["ok"] is False and 1 <= r["retry_after_s"] <= 4, r
    assert p.requests == before, "a refusal spends nothing"
    assert client.post("/api/ratelimits/acquire", json={"policy": "trade-fetch"}).json()["ok"] is True, "ordinary requests are unaffected"


def test_a_spare_request_goes_through_with_headroom():
    p = _fresh("trade-fetch")
    _observe(p, "1:4:0,1:12:0")
    assert client.post("/api/ratelimits/acquire", json={"policy": "trade-fetch", "spare": 0.5}).json()["ok"] is True


# Found measuring "Find cheapest" (2026-10-03): the site's real rules, halved, are not a rate list pyrate-limiter accepts
# (it wants longer windows to have larger limits and a lower rate), so building the limiter threw and the policy kept
# its defaults while reporting the new rules. Search: 3/5s 8/10s 15/60s 60/300s 600/3h → halved 1/5s 4/10s …; fetch has
# two 4-second rules. The derived list keeps every rule that can bind and drops only the ones a stricter rule implies.
SEARCH_HEADERS = {"X-Rate-Limit-Rules": "Ip", "X-Rate-Limit-Ip": "3:5:60,8:10:60,15:60:120,60:300:1800,600:10800:3600",
                  "X-Rate-Limit-Ip-State": "1:5:0,1:10:0,1:60:0,1:300:0,1:10800:0"}
FETCH_HEADERS = {"X-Rate-Limit-Rules": "Account,Ip", "X-Rate-Limit-Account": "6:4:10,16:12:60",
                 "X-Rate-Limit-Account-State": "1:4:0,1:12:0", "X-Rate-Limit-Ip": "12:4:60,100:300:300,1000:10800:1800",
                 "X-Rate-Limit-Ip-State": "1:4:0,1:300:0,1:10800:0"}


def _rates(p):
    return [(r.limit, r.interval // 1000) for r in p.rates]


def test_the_sites_real_search_rules_become_a_working_limiter():
    p = _fresh("trade-search")
    p.observe_headers(200, SEARCH_HEADERS)
    p.penalty_until = 0.0
    assert _rates(p) == [(1, 5), (7, 60), (30, 300), (300, 10800)]   # 4/10s is implied by 1/5s
    assert p.limiter.try_acquire("trade-search", blocking=False) is True
    assert p.limiter.try_acquire("trade-search", blocking=False) is False, "the limiter really is the new one (1 per 5 s)"


def test_the_sites_real_fetch_rules_become_a_working_limiter():
    p = _fresh("trade-fetch")
    p.observe_headers(200, FETCH_HEADERS)
    p.penalty_until = 0.0
    assert _rates(p) == [(3, 4), (8, 12), (50, 300), (500, 10800)]   # the two 4-second rules: the stricter one
    assert [p.limiter.try_acquire("trade-fetch", blocking=False) for _ in range(4)] == [True, True, True, False]


def test_a_full_limiter_says_retry_after_its_shortest_window_not_thirty_seconds():
    p = _fresh("trade-search")
    p.observe_headers(200, SEARCH_HEADERS)
    p.penalty_until = 0.0
    assert client.post("/api/ratelimits/acquire", json={"policy": "trade-search"}).json()["ok"] is True
    r = client.post("/api/ratelimits/acquire", json={"policy": "trade-search"}).json()
    assert r["ok"] is False and r["retry_after_s"] == 5.0, r
