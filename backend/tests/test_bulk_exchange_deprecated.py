"""The trade site's Bulk Item Exchange is DEPRECATED as a price source (owner, 2026-09-17).

`POST /api/trade2/exchange` is the WEBSITE's whisper-based listing board — a different venue from
the in-game Currency Exchange (automated order book, gold fees) that the hourly digest, the gold
model and every loop describe. Its listings are unfilled asks: bait ("Omen of Light for 1 exalt"),
lowball bids (divine "sells" for 300 when it trades at 440). GGG exposes NO live order book for the
in-game exchange (developer docs: the currency-exchange endpoint is "purely historical", hourly,
never the current hour) — so the hourly digest is the sole source for prices and loops.
See docs/market-data-sources.md.

Deprecated, not deleted: the code stays behind `orderbook.BULK_EXCHANGE_ENABLED` (False).

    python -m pytest backend/tests/test_bulk_exchange_deprecated.py -q
"""
import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import db, orderbook  # noqa: E402


def test_the_switch_is_off():
    assert orderbook.BULK_EXCHANGE_ENABLED is False


def test_nothing_is_queued_or_fetched_when_deprecated(monkeypatch):
    monkeypatch.setattr(orderbook, "BULK_EXCHANGE_ENABLED", False)
    monkeypatch.setattr(orderbook, "cached_at", lambda league, h, w: None)

    async def go():
        futs = orderbook.request_pairs([("divine", "exalted"), ("chaos", "divine")], force=True)
        return futs, await orderbook.wait_for(futs, timeout=1)

    futs, waited = asyncio.new_event_loop().run_until_complete(go())
    assert futs == [] and orderbook._queue.empty()
    assert waited == {"waited": 0, "done": 0, "timed_out": False}      # refresh endpoints return at once


def test_stored_whisper_listings_never_reach_the_graph(monkeypatch):
    """Books fetched before the deprecation are still in market.sqlite; they must not leak back in."""
    with db.tx() as c:
        c.execute("INSERT OR REPLACE INTO orderbook(league, have, want, fetched_at, offers) VALUES(?,?,?,?,?)",
                  ("T", "exalted", "omen-of-light", int(time.time()), json.dumps([{"rate": 1.0, "stock": 4}])))
    monkeypatch.setattr(orderbook, "BULK_EXCHANGE_ENABLED", False)
    assert orderbook.latest_books("T", 3600) == {}
    monkeypatch.setattr(orderbook, "BULK_EXCHANGE_ENABLED", True)
    assert ("exalted", "omen-of-light") in orderbook.latest_books("T", 3600)   # the code path still works
