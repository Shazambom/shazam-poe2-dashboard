"""The exchange's `have` cap is GGG's to change — the fetcher must learn it, not hard-code it.

2026-09-17: pathofexile.com started answering a 12-have batch with
    400 {"error":{"code":2,"message":"Too many items `have` items selected."}}
and EVERY live order-book fetch failed (0 pairs fetched; the graph fell back to digest-only
rates, which is where the Arbitrage tab's phantom +780% loops come from). The cap is now
adaptive: on that rejection the worker lowers `state["have_cap"]`, re-queues the SAME pairs
(their futures stay pending — nobody gets an error) and retries with a smaller batch.

    python -m pytest backend/tests/test_orderbook_cap.py -q
"""
import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import orderbook, session  # noqa: E402

TOO_MANY = RuntimeError('exchange HTTP 400: {"error":{"code":2,"message":"Too many items `have` items selected."}}')


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    monkeypatch.setitem(orderbook.state, "have_cap", 12)      # as it was the day GGG lowered theirs
    orderbook._pending.clear(); orderbook._queued_priority.clear(); orderbook._solo.clear()
    while not orderbook._queue.empty():
        orderbook._queue.get_nowait()
    yield
    orderbook._pending.clear(); orderbook._queued_priority.clear(); orderbook._solo.clear()


def test_recognises_only_the_too_many_rejection():
    assert orderbook._too_many(TOO_MANY)
    assert not orderbook._too_many(RuntimeError('exchange HTTP 400: {"error":{"code":2,"message":"Unknown item"}}'))
    assert not orderbook._too_many(PermissionError("exchange rejected the session"))


def test_cap_steps_down_and_never_below_one():
    seen, n = [], 12
    while n > 1:
        n = orderbook._lower_cap(n)
        seen.append(n)
    assert seen == [10, 8, 6, 5, 4, 3, 2, 1]         # by 2 while large (few wasted requests), then by 1
    assert orderbook._lower_cap(1) == 1


def test_take_batch_and_pad_respect_the_learned_cap(monkeypatch):
    orderbook.state["have_cap"] = 5
    for i in range(9):
        orderbook._pending[(f"h{i}", "chaos")] = []
    assert len(orderbook._take_batch("h0", "chaos")) == 5
    monkeypatch.setattr(orderbook.pairscore, "ranked_haves", lambda want: [f"p{i}" for i in range(20)])
    monkeypatch.setattr(orderbook.digest, "partners", lambda league, want: [])
    monkeypatch.setattr(orderbook, "cached_at", lambda league, h, w: None)
    s = {"batch_pad": True, "batch_max_have": 12, "watchlist": [], "min_refetch_s": 60}
    assert len(orderbook._pad(["h0", "h1"], "chaos", "L", s)) == 5
    s["batch_max_have"] = 3                           # a user setting BELOW the learned cap still wins
    assert len(orderbook._pad(["h0", "h1"], "chaos", "L", s)) == 3


def test_worker_learns_the_cap_and_every_future_still_resolves(monkeypatch):
    calls = []

    async def fake_fetch(league, haves, want, cookie, requested):
        calls.append(len(haves))
        if len(haves) > 8:                            # GGG's cap, unknown to us
            raise TOO_MANY
        return {h: [{"rate": 1.0, "stock": 5}] for h in haves}, []

    monkeypatch.setattr(orderbook, "_fetch_batch", fake_fetch)
    monkeypatch.setattr(orderbook, "_pad", lambda haves, want, league, s: haves)
    monkeypatch.setattr(orderbook, "cached_at", lambda league, h, w: None)
    monkeypatch.setattr(session, "get_cookie", lambda: "x")

    async def go():
        futs = orderbook.request_pairs([(f"h{i}", "chaos") for i in range(12)], force=True)
        task = asyncio.ensure_future(orderbook.worker())
        res = await orderbook.wait_for(futs, timeout=5)
        task.cancel()
        return res, futs

    res, futs = asyncio.new_event_loop().run_until_complete(go())
    assert res == {"waited": 12, "done": 12, "timed_out": False}
    assert all(f.exception() is None for f in futs)   # the rejection never reached a caller
    assert calls[:3] == [12, 10, 8]                   # two wasted requests, then it fits
    assert orderbook.state["have_cap"] == 8
    assert max(calls[2:]) <= 8


def test_a_single_have_rejection_is_a_real_error(monkeypatch):
    async def fake_fetch(league, haves, want, cookie, requested):
        raise TOO_MANY

    monkeypatch.setattr(orderbook, "_fetch_batch", fake_fetch)
    monkeypatch.setattr(orderbook, "_pad", lambda haves, want, league, s: haves)
    monkeypatch.setattr(orderbook, "cached_at", lambda league, h, w: None)
    monkeypatch.setattr(session, "get_cookie", lambda: "x")

    async def go():
        futs = orderbook.request_pairs([("h0", "chaos")], force=True)
        task = asyncio.ensure_future(orderbook.worker())
        await orderbook.wait_for(futs, timeout=5)
        task.cancel()
        return futs

    futs = asyncio.new_event_loop().run_until_complete(go())
    assert isinstance(futs[0].exception(), RuntimeError)     # no infinite retry at cap 1
