"""Live order book: cached pair books plus a priority fetch queue.

Nothing is fetched on a timer by default. Pairs enter the queue when:
  0 — a user forces one loop to refresh ("Refresh this loop")
  1 — the UI asks to refresh the pairs behind the top-N displayed loops
  2 — the optional background sweep is on (settings.background_sweep)

The worker drains the queue one request at a time through the gateway's "trade"
policy, **batching by `want`**: every pending pair that wants the same currency goes
out in a single request with `have=[X1, X2, ...]` (the pattern Exiled Exchange 2 uses
for its bulk price check). The response holds at most ~100 listings across all those
pairs, grouped back out by `offers[].exchange.currency`; a pair that got starved by
the cap while `total` exceeds it is re-queued on its own, once.

A pair fetched within `min_refetch_s` is served from cache unless forced (and even
forced fetches respect a short hard floor). Books persist in SQLite so restarts don't
re-fetch, and a data version counter lets route results be cached and invalidated.

Endpoint semantics: POST /api/trade2/exchange/poe2/<league> with have=[A..], want=[B]
returns sellers offering B for each A — the directed edges A -> B.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from itertools import permutations

from . import db, digest, gateway, pairscore, session
from .config import ORDERBOOK_SWEEP_SECONDS, TRADE_EXCHANGE_URL
from .datapolicy import ORDERBOOK_HISTORY_RETENTION_H
from .settings import get_settings

log = logging.getLogger(__name__)

# DEPRECATED 2026-09-17 (owner directive) — see docs/market-data-sources.md. This module queries the
# trade WEBSITE's Bulk Item Exchange (`POST /api/trade2/exchange`): whisper-based listings, a
# different venue from the in-game Currency Exchange that the hourly digest, the gold-fee model
# and every loop describe. Listings there are unfilled asks — bait and lowball bids — and they
# were overriding executed prices. GGG exposes no live order book for the in-game exchange, so
# the hourly digest is the SOLE source for prices and loops. With this False nothing is queued or
# fetched and stored books never reach the graph. `exchange_post` stays in use as the session probe.
BULK_EXCHANGE_ENABLED = False

HARD_FLOOR_S = 5      # even a forced refetch of the same pair waits this long
BATCH_MAX_HAVE = 10   # haves per request WE want (GGG's cap as of 2026-09-17; it was >= 12 before); more dilutes the ~100-listing response cap.
                      # GGG enforces its own (unpublished, changeable) cap — see state["have_cap"].
RESULT_CAP = 100      # practical ceiling of listings the exchange returns per call
STARVED_DEPTH = 3     # a pair with fewer offers than this, under the cap, gets a solo re-query

state = {"enabled": False, "last_fetch": None, "last_error": None, "pairs_fetched": 0,
         "requests": 0, "padded": 0, "in_flight": None, "queue": 0, "version": 0, "url_form": "poe2/{league}",
         "have_cap": BATCH_MAX_HAVE}   # learned down from BATCH_MAX_HAVE when the exchange says "Too many"

_queue: asyncio.PriorityQueue = asyncio.PriorityQueue()
_pending: dict[tuple[str, str], list[asyncio.Future]] = {}
_queued_priority: dict[tuple[str, str], int] = {}
_solo: set[tuple[str, str]] = set()   # starved pairs re-queried on their own; never batched again
_seq = 0


# ------------------------------------------------------------------ parsing
def _parse_offers(payload: dict, haves: list[str], want: str) -> dict[str, list[dict]]:
    """Split one (possibly multi-have) response into per-pair ladders, best rate first."""
    books: dict[str, list[dict]] = {h: [] for h in haves}
    for listing_id, entry in (payload.get("result") or {}).items():
        listing = entry.get("listing") or {}
        acct = (listing.get("account") or {}).get("name")
        for off in listing.get("offers") or []:
            ex, it = off.get("exchange") or {}, off.get("item") or {}
            have = ex.get("currency")
            if have not in books or it.get("currency") != want:
                continue
            give, get = ex.get("amount"), it.get("amount")
            if not give or not get:
                continue
            books[have].append({"listing_id": listing_id, "account": acct, "give": give, "get": get,
                                "rate": get / give, "stock": it.get("stock") or get,
                                "whisper": it.get("whisper") or listing.get("whisper")})
    for b in books.values():
        b.sort(key=lambda o: o["rate"], reverse=True)
    return books


# ------------------------------------------------------------------ cache
def cached_at(league: str, have: str, want: str) -> int | None:
    with db.q() as c:
        r = c.execute("SELECT fetched_at FROM orderbook WHERE league=? AND have=? AND want=?",
                      (league, have, want)).fetchone()
    return r["fetched_at"] if r else None


def latest_books(league: str, max_age_s: int) -> dict[tuple[str, str], dict]:
    if not BULK_EXCHANGE_ENABLED:
        return {}
    since = int(time.time()) - max_age_s
    with db.q() as c:
        rows = c.execute("SELECT have, want, fetched_at, offers FROM orderbook WHERE league=? AND fetched_at>=?",
                         (league, since)).fetchall()
    out = {}
    for r in rows:
        offers = json.loads(r["offers"])
        if not offers:
            continue
        out[(r["have"], r["want"])] = {"offers": offers, "rate": offers[0]["rate"], "stock": offers[0]["stock"],
                                       "depth": len(offers), "age_s": time.time() - r["fetched_at"],
                                       "fetched_at": r["fetched_at"]}
    return out


def pair_history(league: str, have: str, want: str, hours: int = 48) -> list[dict]:
    since = int(time.time()) - hours * 3600
    with db.q() as c:
        rows = c.execute("""SELECT fetched_at, best_rate, best_stock, depth FROM orderbook_history
                            WHERE league=? AND have=? AND want=? AND fetched_at>=? ORDER BY fetched_at""",
                         (league, have, want, since)).fetchall()
    return [dict(r) for r in rows]


# ------------------------------------------------------------------ fetching
def exchange_url(league: str) -> str:
    return f"{TRADE_EXCHANGE_URL}/{state['url_form'].format(league=league)}"


async def exchange_post(league: str, body: dict, cookie: str, *, retries: int = 2):
    """The one exchange POST: headers, session cookie, and the one-time URL-form fallback (two URL
    forms are in use by live tools). Returns the raw response; callers map status codes."""
    headers = {"Accept": "application/json", "Content-Type": "application/json",
               "Origin": "https://www.pathofexile.com", "X-Requested-With": "XMLHttpRequest",
               "Referer": f"https://www.pathofexile.com/trade2/exchange/poe2/{league}"}
    r = await gateway.request("POST", exchange_url(league), policy="trade", retries=retries,
                              json=body, headers=headers, cookies={"POESESSID": cookie})
    if r.status_code == 404 and state["url_form"] == "poe2/{league}":
        state["url_form"] = "{league}"
        log.info("exchange: switching to URL form without realm segment")
        r = await gateway.request("POST", exchange_url(league), policy="trade", retries=retries,
                                  json=body, headers=headers, cookies={"POESESSID": cookie})
    return r


async def _post(league: str, body: dict, cookie: str):
    r = await exchange_post(league, body, cookie)
    if r.status_code in (401, 403):
        raise PermissionError("exchange rejected the session (reconnect it in Settings)")
    if r.status_code >= 400:
        # GGG explains a rejection in the body ({"error": {"code", "message"}}); httpx's
        # raise_for_status() drops it, which left `last_error` saying only "400 Bad Request".
        raise RuntimeError(f"exchange HTTP {r.status_code}: {r.text[:300]}")
    state["requests"] += 1
    return r.json()


def _store(league: str, have: str, want: str, offers: list[dict]) -> None:
    now = int(time.time())
    with db.tx() as c:
        c.execute("INSERT OR REPLACE INTO orderbook(league, have, want, fetched_at, offers) VALUES(?,?,?,?,?)",
                  (league, have, want, now, json.dumps(offers)))
        best = offers[0] if offers else None
        c.execute("INSERT INTO orderbook_history VALUES(?,?,?,?,?,?,?)",
                  (league, have, want, now, best["rate"] if best else None,
                   best["stock"] if best else None, len(offers)))
    state.update(last_fetch=now, last_error=None)
    state["pairs_fetched"] += 1
    state["version"] += 1


async def _fetch_batch(league: str, haves: list[str], want: str, cookie: str,
                       requested: set[str]) -> tuple[dict[str, list[dict]], list[str]]:
    """One request for want=W, have=[...]. Returns per-have books and the *requested*
    haves that were starved by the result cap and deserve a solo follow-up. Padded
    haves are best-effort: stored if they got anything, silently dropped otherwise."""
    body = {"query": {"status": {"option": "online"}, "have": haves, "want": [want]},
            "sort": {"have": "asc"}, "engine": "new"}
    payload = await _post(league, body, cookie)
    books = _parse_offers(payload, haves, want)
    total = payload.get("total") or len(payload.get("result") or {})
    capped = len(haves) > 1 and total >= RESULT_CAP
    starved = [h for h, b in books.items() if h in requested and capped and len(b) < STARVED_DEPTH]
    for have, offers in books.items():
        if capped and not offers and (have in starved or have not in requested):
            continue  # empty under the cap is an artefact, not a market fact
        _store(league, have, want, offers)
    session.mark_ok()
    return books, starved


# ------------------------------------------------------------------ queue
def request_pairs(pairs: list[tuple[str, str]], priority: int = 1, force: bool = False,
                  max_age_s: int | None = None) -> list[asyncio.Future]:
    """Queue pairs that need fetching; return futures for those queued (fresh ones are skipped)."""
    global _seq
    if not BULK_EXCHANGE_ENABLED:
        return []
    s = get_settings()
    league = s["league"]
    max_age = HARD_FLOOR_S if force else (max_age_s if max_age_s is not None else s["min_refetch_s"])
    loop = asyncio.get_event_loop()
    futs = []
    now = time.time()
    for have, want in dict.fromkeys(pairs):
        if have == want:
            continue
        ts = cached_at(league, have, want)
        if ts and now - ts < max_age:
            continue
        fut = loop.create_future()
        key = (have, want)
        if key in _pending:
            _pending[key].append(fut)
        else:
            _pending[key] = [fut]
            _queued_priority[key] = priority
            _seq += 1
            # within a tier, pairs from the best loops (margin, margin/gold) go first
            _queue.put_nowait((priority, -pairscore.score(have, want), _seq, have, want))
        futs.append(fut)
    state["queue"] = _queue.qsize()
    return futs


async def wait_for(futs: list[asyncio.Future], timeout: float) -> dict:
    if not futs:
        return {"waited": 0, "done": 0, "timed_out": False}
    done, pending = await asyncio.wait(futs, timeout=timeout)
    return {"waited": len(futs), "done": len(done), "timed_out": bool(pending)}


def _too_many(exc: Exception) -> bool:
    """The exchange's 400 for a batch over ITS have-cap: {"error":{"code":2,"message":"Too many
    items `have` items selected."}} (first seen 2026-09-17, when 12 stopped being accepted)."""
    return "Too many" in str(exc) and "have" in str(exc)


def _lower_cap(n: int) -> int:
    """Next cap to try after a batch of `n` was rejected: by 2 while large (each probe is a wasted
    rate-limited request), by 1 once small (don't overshoot a cap of 5 down to 3)."""
    return max(1, n - 2 if n > 6 else n - 1)


def _take_batch(first_have: str, want: str) -> list[str]:
    """Pull every other pending pair that wants `want` into this request (solo re-queries excluded)."""
    haves = [first_have]
    if (first_have, want) in _solo:
        return haves
    for (h, w) in list(_pending):
        if w == want and h not in haves and (h, w) not in _solo and len(haves) < state["have_cap"]:
            haves.append(h)
    return haves


def _pad(haves: list[str], want: str, league: str, s: dict) -> list[str]:
    """Fill the free slots of a request with the haves that trade into `want` most."""
    if not s.get("batch_pad"):
        return haves
    cap = min(int(s.get("batch_max_have") or BATCH_MAX_HAVE), state["have_cap"])
    if len(haves) >= cap:
        return haves
    # 1) pairs that keep appearing in the best loops, 2) pairs the market trades most,
    # 3) the watchlist — first come first served into the free slots.
    ranked = pairscore.ranked_haves(want)
    for h, _ in digest.partners(league, want):
        if h not in ranked:
            ranked.append(h)
    for h in s["watchlist"]:
        if h not in ranked:
            ranked.append(h)
    now = time.time()
    padded = list(haves)
    for h in ranked:
        if len(padded) >= cap:
            break
        if h == want or h in padded or (h, want) in _solo:
            continue
        ts = cached_at(league, h, want)
        if ts and now - ts < s["min_refetch_s"]:
            continue
        padded.append(h)
    state["padded"] += len(padded) - len(haves)
    return padded


def _settle(key: tuple[str, str], result) -> None:
    for f in _pending.pop(key, []):
        if not f.done():
            f.set_exception(result) if isinstance(result, Exception) else f.set_result(result)
    _queued_priority.pop(key, None)
    _solo.discard(key)


async def worker() -> None:
    global _seq
    while True:
        priority, _, _, have, want = await _queue.get()
        state["queue"] = _queue.qsize()
        if (have, want) not in _pending:      # already served as part of an earlier batch
            _queue.task_done()
            continue
        cookie = session.get_cookie()
        state["enabled"] = bool(cookie)
        s = get_settings()
        requested = _take_batch(have, want)
        if not cookie:
            for h in requested:
                _settle((h, want), PermissionError("no trade session connected"))
            _queue.task_done()
            continue
        haves = _pad(requested, want, s["league"], s) if (have, want) not in _solo else requested
        state["in_flight"] = f"{'+'.join(requested)}{'(+%d)' % (len(haves) - len(requested)) if len(haves) > len(requested) else ''}->{want}"
        try:
            books, starved = await _fetch_batch(s["league"], haves, want, cookie, set(requested))
        except Exception as exc:
            state["last_error"] = f"{'+'.join(haves)}->{want}: {exc}"
            log.warning("orderbook batch failed %s->%s: %s", haves, want, exc)
            if _too_many(exc) and len(haves) > 1:
                # Over the exchange's have-cap: learn it and retry the SAME pairs in smaller
                # batches. Their futures stay pending — callers never see this rejection.
                state["have_cap"] = _lower_cap(len(haves))
                log.info("orderbook: exchange have-cap is below %d, now batching %d", len(haves), state["have_cap"])
                for h in requested:
                    _seq += 1
                    _queue.put_nowait((priority, -pairscore.score(h, want), _seq, h, want))
            else:
                for h in requested:
                    _settle((h, want), exc)
        else:
            for h in requested:
                if h in starved and (h, want) not in _solo:
                    # keep its futures pending and re-queue it alone at the same priority
                    _seq += 1
                    _solo.add((h, want))
                    _queue.put_nowait((priority, -pairscore.score(h, want), _seq, h, want))
                    log.info("orderbook: %s->%s starved by result cap, re-querying alone", h, want)
                else:
                    _settle((h, want), books.get(h, []))
        finally:
            state["in_flight"] = None
            state["queue"] = _queue.qsize()
        _queue.task_done()
        await asyncio.sleep(0)  # yield between requests even if the gateway didn't wait


def prune_history() -> int:
    """Drop orderbook_history rows past ORDERBOOK_HISTORY_RETENTION_H (readers use 48h). Runs
    from the background sweeper, never on a request."""
    cutoff = int(time.time()) - ORDERBOOK_HISTORY_RETENTION_H * 3600
    with db.tx() as c:
        return c.execute("DELETE FROM orderbook_history WHERE fetched_at < ?", (cutoff,)).rowcount


async def sweeper() -> None:
    """Optional low-priority background sweep of the whole watchlist; also the home of the
    orderbook_history retention prune (one row lands per live fetch, forever otherwise)."""
    while True:
        try:
            await asyncio.to_thread(prune_history)
        except Exception as exc:
            log.warning("orderbook: prune failed: %s", exc)
        s = get_settings()
        if s.get("background_sweep") and session.get_cookie():
            pairs = list(permutations(s["watchlist"], 2)) + [tuple(p) for p in s.get("extra_pairs", [])]
            request_pairs(pairs, priority=2, max_age_s=s["live_max_age_s"])
        await asyncio.sleep(ORDERBOOK_SWEEP_SECONDS)


async def leagues(force: bool = False) -> list[dict]:
    """League ids as the trade site names them (cached a day). Public endpoint, trade policy."""
    cached = db.kv_get("trade_leagues")
    if cached and not force and time.time() - cached["at"] < 86400:
        return cached["leagues"]
    r = await gateway.request("GET", "https://www.pathofexile.com/api/trade2/data/leagues", policy="trade",
                              headers={"Accept": "application/json"})
    r.raise_for_status()
    out = [{"id": l.get("id"), "text": l.get("text", l.get("id"))} for l in r.json().get("result", []) if l.get("id")]
    db.kv_set("trade_leagues", {"at": time.time(), "leagues": out})
    return out


def request_refresh() -> None:
    s = get_settings()
    request_pairs(list(permutations(s["watchlist"], 2)), priority=2, max_age_s=s["min_refetch_s"])
