"""Ingest GGG's public hourly Currency Exchange digest.

GET https://web.poecdn.com/api/currency-exchange/poe2/<unix_hour>

Each response holds every market pair that traded in that hour, across all leagues.
We store rows per (hour, league, market) and derive an executed-volume-weighted rate:
    rate(A->B) ≈ volume_traded[B] / volume_traded[A]
i.e. how many B were exchanged per A over the hour. That is the most honest "what
actually cleared" number available; lowest/highest_ratio are kept raw for reference.
"""
from __future__ import annotations

import asyncio
import logging
import time

import httpx

from . import cache, db, gateway, settings
from .datapolicy import MARKET_RETENTION_DAYS
from .config import DIGEST_BACKFILL_HOURS, DIGEST_POLL_SECONDS, GGG_DIGEST_URL
from .currencies import registry

log = logging.getLogger(__name__)

state = {"last_hour": None, "last_fetch": None, "last_error": None, "rows": 0}


def _hour(ts: float) -> int:
    return int(ts) - int(ts) % 3600


async def _fetch(hour_id: int | None) -> dict:
    url = GGG_DIGEST_URL + (f"/{hour_id}" if hour_id else "")
    r = await gateway.request("GET", url, policy="digest")
    r.raise_for_status()
    return r.json()


def _store(hour: int, markets: list[dict]) -> int:
    rows = []
    for m in markets:
        pair = m.get("market_pair") or []
        if len(pair) != 2:
            continue
        a, b = pair
        vt, ls, hs, lr, hr = (m.get(k, {}) for k in
                              ("volume_traded", "lowest_stock", "highest_stock", "lowest_ratio", "highest_ratio"))
        registry.resolve_meta(a)
        registry.resolve_meta(b)
        rows.append((
            hour, m.get("league", ""), m.get("market_id", f"{a}|{b}"), a, b,
            vt.get(a), vt.get(b), ls.get(a), ls.get(b), hs.get(a), hs.get(b),
            lr.get(a), lr.get(b), hr.get(a), hr.get(b),
        ))
    with db.tx() as c:
        c.executemany(
            "INSERT OR REPLACE INTO digest_markets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows
        )
    return len(rows)


async def sync_once() -> None:
    cursor = db.kv_get("digest_cursor")
    if cursor is None:
        cursor = _hour(time.time() - DIGEST_BACKFILL_HOURS * 3600)
    elif state["last_hour"] is None:
        state["last_hour"] = cursor - 3600   # restart: reflect what's already stored
    for _ in range(500):  # safety cap per sync pass
        try:
            data = await _fetch(cursor)
        except (httpx.HTTPError, gateway.RateLimited) as exc:
            if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 404:
                # the tip hour isn't published yet — caught up, not an error
                state.update(last_fetch=time.time(), last_error=None)
                return
            state["last_error"] = str(exc)
            log.warning("digest fetch failed: %s", exc)
            return
        markets = data.get("markets", [])
        nxt = data.get("next_change_id")
        n = _store(cursor, markets)
        state.update(last_hour=cursor, last_fetch=time.time(), last_error=None, rows=n)
        if nxt is None or nxt == cursor:
            break
        cursor = nxt
        db.kv_set("digest_cursor", cursor)
    db.kv_set("digest_cursor", cursor)


def prune_old() -> int:
    """Drop digest rows older than MARKET_RETENTION_DAYS (the longest reader window is 14d, so
    nothing can miss them). Runs in the background sync loop, never on a request."""
    cutoff = _hour(time.time()) - MARKET_RETENTION_DAYS * 86400
    with db.tx() as c:
        return c.execute("DELETE FROM digest_markets WHERE hour < ?", (cutoff,)).rowcount


ANALYZE_EVERY_S = 3600.0
_last_analyze = 0.0


def maybe_analyze(stored: bool) -> None:
    """Keep the planner's statistics honest as hours land. Statistics taken once, when the DB
    was empty, would tell SQLite the digest's pair index is worthless and send every card's
    history back to scanning the window. Hourly at most, and only after new rows."""
    global _last_analyze
    if not stored or time.time() - _last_analyze < ANALYZE_EVERY_S:
        return
    _last_analyze = time.time()
    db.analyze()


async def run_forever() -> None:
    while True:
        try:
            before = state["last_hour"]
            await sync_once()
            n = await asyncio.to_thread(prune_old)
            await asyncio.to_thread(maybe_analyze, state["last_hour"] != before)
            if n:
                log.info("digest: pruned %d rows older than %dd", n, MARKET_RETENTION_DAYS)
        except Exception as exc:  # never let the loop die
            log.exception("digest loop error: %s", exc)
        await asyncio.sleep(DIGEST_POLL_SECONDS)


# ------------------------------------------------------------------ queries
def traded_bounds(rows) -> dict[tuple[str, str], tuple[float, float]]:
    """(cheapest, dearest) `cur_a` per `cur_b` that actually EXECUTED in each market across the
    window — one observation per traded hour.

    Not the digest's ratio columns: those are what was LISTED, and the book is full of bait (the
    divine<->exalted market carries a 1:1 listing beside the real 1:500, which reads as a 500x
    spread and would price a Divine at 3 Exalted). What people paid is solid: an active market
    repeats it hour after hour, an inactive one wanders by orders of magnitude."""
    out: dict[tuple[str, str], tuple[float, float]] = {}
    for r in rows:
        if not r["vol_a"] or not r["vol_b"]:
            continue
        px = r["vol_a"] / r["vol_b"]                        # a per b, what this hour traded at
        prev = out.get((r["cur_a"], r["cur_b"]))
        out[(r["cur_a"], r["cur_b"])] = (min(px, prev[0]), max(px, prev[1])) if prev else (px, px)
    return out


def directed_rates(a: str, b: str, r, age: float, bounds: tuple[float, float] | None = None,
                   wide_spread: float | None = None, rate: float | None = None,
                   volume: tuple[float, float] | None = None) -> dict[tuple[str, str], dict]:
    """The directed edges one traded hour of the a<->b market supports. An edge a->b hands you b,
    so someone must have been STANDING there offering b: the receiving side's standing stock
    (`hi_stock_*`) must be > 0. No sellers → no edge in that direction — traded volume is never a
    stand-in for stock (Esh's Radiance "for 13 chaos": zero Radiance ever listed for chaos, only
    chaos bids that a holder occasionally dumps into).

    `bounds` is (cheapest, dearest) `a` per `b` traded across the window (`traded_bounds`). When
    they are `wide_spread` apart this market is INACTIVE — nobody quotes it — and its executed
    average is a price nobody will give you: you buy at the dearest and sell at the cheapest,
    never in the middle (owner, 2026-09-19 — a Tecrod's Gaze that sells for 12 divine was offered
    at 471 exalted because one sparse hour traded 2 of them for 175 ex). A market that repeats its
    price keeps that price.

    `rate` is that market's `a` per `b` across the whole window (`window_rates`) and is what an
    ACTIVE market is priced at; without it the newest hour alone sets the price, which for a quiet
    market is one or two trades. The two mechanisms divide the space: `wide_spread` is the >2x
    trip-wire that gives up on a market, `rate` is the denoiser underneath it. Both directions come
    from the ONE number rather than from two divisions, so their product stays within a single
    rounding step of 1 — a market that traded against itself would be a free two-hop loop."""
    lo, hi = bounds or (0.0, 0.0)
    s = settings.get_settings()
    wide = settings.wide_spread(s) if wide_spread is None else wide_spread
    inactive = bool(lo > 0 and hi > 0 and wide > 0 and hi / lo >= wide)
    px = rate if rate else (r["vol_a"] / r["vol_b"])                 # a per b
    if inactive and volume and _deep(r, px, volume, settings.depth_hours(s), settings.depth_balance(s)):
        inactive = False                                             # wide, but a book stands on both sides
    to_b = (1.0 / hi) if inactive else (1.0 / px)                    # b per a — you pay the dearest
    to_a = lo if inactive else px                                    # a per b — you take the cheapest
    # `quoted_rate` is what the market would be priced at if it were quoted (the window rate),
    # carried on every edge so the value table can quote a currency's busiest market whatever
    # its spread says (Graph.quote_busiest_markets — the volume rule, owner 2026-09-23).
    out: dict[tuple[str, str], dict] = {}
    if r["hi_stock_b"]:
        out[(a, b)] = {"rate": to_b, "stock": r["hi_stock_b"], "inactive": inactive, "quoted_rate": 1.0 / px,
                       "volume_from": r["vol_a"], "volume_to": r["vol_b"], "hour": r["hour"], "age_s": age}
    if r["hi_stock_a"]:
        out[(b, a)] = {"rate": to_a, "stock": r["hi_stock_a"], "inactive": inactive, "quoted_rate": px,
                       "volume_from": r["vol_b"], "volume_to": r["vol_a"], "hour": r["hour"], "age_s": age}
    return out


def _deep(r, a_per_b: float, volume: tuple[float, float], min_hours: float, min_balance: float) -> bool:
    """Whether the standing stock on BOTH sides of a market is a book: each side covers
    `min_hours` of that side's executed volume, and the thin side (in the deep side's units)
    holds at least `min_balance` of the deep one. A wide spread with this behind it is a market
    that is merely wide (owner, 2026-09-23); without it, one order against a wall is not."""
    va_h, vb_h = volume
    sa, sb = r["hi_stock_a"] or 0, r["hi_stock_b"] or 0
    hours = min(sa / va_h if va_h else 0.0, sb / vb_h if vb_h else 0.0)
    ua, ub = sa, sb * a_per_b                                        # both in a's units
    balance = min(ua, ub) / max(ua, ub) if max(ua, ub) else 0.0
    return hours >= min_hours and balance >= min_balance


def latest_rates(league: str, max_age_hours: int = 6) -> dict[tuple[str, str], dict]:
    """Directed rate map {(from, to): {...}} from the most recent hour(s) with data."""
    since = _hour(time.time()) - max_age_hours * 3600
    with db.q() as c:
        rows = c.execute(
            """SELECT * FROM digest_markets WHERE league=? AND hour>=? ORDER BY hour DESC""",
            (league, since),
        ).fetchall()
    bounds = traded_bounds(rows)            # how far the executed hours ran, per market
    # The pricing window is never narrower than the rows it prices: a setting past RATE_WINDOW_H
    # would otherwise leave the older markets to their newest hour alone.
    priced = window_rates(league, max(RATE_WINDOW_H, max_age_hours))
    day = pair_volume(league, 24)           # each side's executed units per hour: the depth yardstick
    wide = settings.wide_spread(settings.get_settings())
    out: dict[tuple[str, str], dict] = {}
    for r in rows:
        a = registry.resolve_meta(r["cur_a"])
        b = registry.resolve_meta(r["cur_b"])
        if not a or not b or not r["vol_a"] or not r["vol_b"]:
            continue
        if (a, b) in out or (b, a) in out:  # newest hour already recorded
            continue
        out.update(directed_rates(a, b, r, time.time() - (r["hour"] + 3600),
                                  bounds.get((r["cur_a"], r["cur_b"])), wide,
                                  priced.get((r["cur_a"], r["cur_b"])),
                                  volume=(day.get((a, b), 0.0), day.get((b, a), 0.0))))
    return out


# ------------------------------------------------------------------ what a market is priced at
# A quiet market trades once or twice a day, so in 13% of market-hours the window above holds
# exactly ONE traded hour — and 87% of those move 1-2 units, where a single misclick becomes the
# price for hours. `traded_bounds` cannot catch it: one hour means lo == hi, which reads as a
# perfectly steady market. Pricing from a longer window instead, each hour weighted by what it
# traded and halved every RATE_HALF_LIFE_H, cut rates that miss the next day's executed average by
# 2x from 5.2% of active market-hours to 3.8%, and by 5x from 0.7% to 0.3% (197,398 market-hours
# of the owner's DB, 2026-09-20). A busy market does not move: its own recent hours already carry
# nearly all the weight, which is what makes one rule safe for every market.
#
# The result is a weighted MEDIANT of hours the market really traded at, so it can never fall
# outside them — we cannot print a price nobody paid. `tests/test_window_rates.py` holds that, and
# the exactness of the summation, over every market in the production DB.
RATE_HALF_LIFE_H = 12.0
RATE_WINDOW_H = 48                  # 4 half-lives; older hours are worth under 6% of the newest

_rate_cache: dict[tuple[str, int], tuple[float, object, dict]] = {}


def window_rates(league: str, hours: int = RATE_WINDOW_H) -> dict[tuple[str, str], float]:
    """`cur_a` per `cur_b` for every market that traded in the window, keyed on the raw metadata
    ids `traded_bounds` uses. Rebuilt only when a new digest hour lands — `latest_rates` runs on
    every graph build, and the graph is rebuilt every few seconds."""
    return cache.memo(_rate_cache, (league, hours), 86_400.0,
                      lambda: _window_rates(league, hours),
                      version=state["last_hour"], max_entries=8)


def _window_rates(league: str, hours: int) -> dict[tuple[str, str], float]:
    now = _hour(time.time())
    with db.q() as c:
        rows = c.execute("SELECT hour, cur_a, cur_b, vol_a, vol_b FROM digest_markets "
                         "WHERE league=? AND hour>=?" + TRADED_ONLY,
                         (league, now - hours * 3600)).fetchall()
    return _fold_rates(rows, now)


def _fold_rates(rows, now: int) -> dict[tuple[str, str], float]:
    """Fold traded hours into one `cur_a` per `cur_b` per market. Pure over the rows, so a test
    can push the whole production DB through it and check the answer against exact summation."""
    acc: dict[tuple[str, str], list[float]] = {}
    for r in rows:
        va, vb = r["vol_a"], r["vol_b"]
        if not va or not vb:                # a side with no volume has no rate to contribute
            continue
        w = 2.0 ** (-((now - r["hour"]) / 3600.0) / RATE_HALF_LIFE_H)
        e = acc.get((r["cur_a"], r["cur_b"]))
        if e is None:
            e = acc[(r["cur_a"], r["cur_b"])] = [0.0, 0.0]
        e[0] += w * va
        e[1] += w * vb
    return {k: a / b for k, (a, b) in acc.items() if b > 0}


# An hour with no volume on a side has no rate, so the history readers below pass over it. Asking
# SQLite not to hand it over is the same judgement one step earlier: a fifth of the rows, never
# materialised. Written to match `not va or not vb` exactly, NULL and 0 alike — proved equal for
# every market in `tests/test_query_plans.py`, and over the owner's DB (933,985 rows, 9,538
# markets, 0 differences). The rows stay in the table; only these two readers skip them, and the
# Python guard below stays as the thing that can never divide by zero.
TRADED_ONLY = " AND vol_a IS NOT NULL AND vol_a <> 0 AND vol_b IS NOT NULL AND vol_b <> 0"


def pair_history(league: str, a: str, b: str, hours: int = 168) -> list[dict]:
    """Hourly series for the a<->b market, expressed as b per a."""
    metas_a = registry.metas(a)
    metas_b = registry.metas(b)
    if not metas_a or not metas_b:
        return []
    since = _hour(time.time()) - hours * 3600
    with db.q() as c:
        rows = c.execute(
            ("""SELECT * FROM digest_markets WHERE league=? AND hour>=?
                AND ((cur_a IN ({a}) AND cur_b IN ({b})) OR (cur_a IN ({b}) AND cur_b IN ({a})))"""
             + TRADED_ONLY + " ORDER BY hour").format(
                a=",".join("?" * len(metas_a)), b=",".join("?" * len(metas_b))),
            (league, since, *metas_a, *metas_b, *metas_b, *metas_a),
        ).fetchall()
    series = []
    for r in rows:
        flipped = r["cur_a"] in metas_b
        va, vb = (r["vol_b"], r["vol_a"]) if flipped else (r["vol_a"], r["vol_b"])
        if not va or not vb:
            continue
        series.append({"hour": r["hour"], "rate": vb / va, "volume_a": va, "volume_b": vb})
    return series


def window_history(league: str, hours: int = 168):
    """`pair_history` for MANY pairs over one window: the window's rows are read ONCE (one index
    range scan) and grouped by market, and the returned `history(a, b)` answers any pair from
    memory exactly as `pair_history(league, a, b, hours)` would. Per-pair queries cost a table
    lookup for every row in the window (the (league, hour) index doesn't carry the pair), which
    made carding hundreds of assets (Hold, Movers) take tens of seconds."""
    since = _hour(time.time()) - hours * 3600
    with db.q() as c:
        rows = c.execute("SELECT hour, cur_a, cur_b, vol_a, vol_b FROM digest_markets "
                         "WHERE league=? AND hour>=?" + TRADED_ONLY, (league, since)).fetchall()
    by_pair: dict[tuple[str, str], list] = {}
    for r in rows:
        by_pair.setdefault((r["cur_a"], r["cur_b"]), []).append(r)

    def history(a: str, b: str, _hours: int | None = None) -> list[dict]:
        metas_a, metas_b = registry.metas(a), registry.metas(b)
        found = []
        for ma in metas_a:
            for mb in metas_b:
                found += [(r, False) for r in by_pair.get((ma, mb), ())]
                found += [(r, True) for r in by_pair.get((mb, ma), ())]
        series = []
        for r, flipped in sorted(found, key=lambda x: x[0]["hour"]):
            va, vb = (r["vol_b"], r["vol_a"]) if flipped else (r["vol_a"], r["vol_b"])
            if not va or not vb:
                continue
            series.append({"hour": r["hour"], "rate": vb / va, "volume_a": va, "volume_b": vb})
        return series
    return history


_volume_cache: dict[tuple[str, int], tuple[float, dict]] = {}


def pair_volume(league: str, hours: int = 24) -> dict[tuple[str, str], float]:
    """Executed volume per hour of the *source* currency for each directed pair,
    averaged over the whole window (quiet hours count as zero — that's the point)."""
    return cache.memo(_volume_cache, (league, hours), 600, lambda: _pair_volume(league, hours))


def _pair_volume(league: str, hours: int) -> dict[tuple[str, str], float]:
    since = _hour(time.time()) - hours * 3600
    with db.q() as c:
        rows = c.execute("""SELECT cur_a, cur_b, SUM(vol_a) va, SUM(vol_b) vb FROM digest_markets
                            WHERE league=? AND hour>=? GROUP BY cur_a, cur_b""", (league, since)).fetchall()
    out: dict[tuple[str, str], float] = {}
    for r in rows:
        a, b = registry.resolve_meta(r["cur_a"]), registry.resolve_meta(r["cur_b"])
        if not a or not b:
            continue
        out[(a, b)] = out.get((a, b), 0) + (r["va"] or 0) / hours
        out[(b, a)] = out.get((b, a), 0) + (r["vb"] or 0) / hours
    return out


_partners_cache: dict[tuple[str, str, int], tuple[float, list[tuple[str, float]]]] = {}


def partners(league: str, want: str, hours: int = 168) -> list[tuple[str, float]]:
    """Haves that actually trade into `want`, ranked by executed volume of `want` over
    the window. Drives batch padding: the pairs the market uses most get the free slots."""
    return cache.memo(_partners_cache, (league, want, hours), 600, lambda: _partners(league, want, hours))


def _partners(league: str, want: str, hours: int) -> list[tuple[str, float]]:
    metas = registry.metas(want)
    out: list[tuple[str, float]] = []
    if metas:
        since = _hour(time.time()) - hours * 3600
        ph = ",".join("?" * len(metas))
        with db.q() as c:
            rows = c.execute(
                f"""SELECT cur_a, cur_b, SUM(vol_a) va, SUM(vol_b) vb FROM digest_markets
                    WHERE league=? AND hour>=? AND (cur_a IN ({ph}) OR cur_b IN ({ph}))
                    GROUP BY cur_a, cur_b""", (league, since, *metas, *metas)).fetchall()
        agg: dict[str, float] = {}
        for r in rows:
            if r["cur_a"] in metas:
                other, vol = r["cur_b"], r["va"] or 0
            else:
                other, vol = r["cur_a"], r["vb"] or 0
            tid = registry.resolve_meta(other)
            if tid and tid != want:
                agg[tid] = agg.get(tid, 0) + vol
        out = sorted(agg.items(), key=lambda kv: kv[1], reverse=True)
    return out


def top_markets(league: str, hours: int = 24, limit: int = 40) -> list[dict]:
    since = _hour(time.time()) - hours * 3600
    with db.q() as c:
        rows = c.execute(
            """SELECT cur_a, cur_b, SUM(vol_a) va, SUM(vol_b) vb, COUNT(*) n
               FROM digest_markets WHERE league=? AND hour>=? GROUP BY cur_a, cur_b
               ORDER BY n DESC, va DESC LIMIT ?""",
            (league, since, limit),
        ).fetchall()
    return [
        {"a": registry.resolve_meta(r["cur_a"]) or r["cur_a"], "b": registry.resolve_meta(r["cur_b"]) or r["cur_b"],
         "meta_a": r["cur_a"], "meta_b": r["cur_b"], "volume_a": r["va"], "volume_b": r["vb"], "hours_active": r["n"]}
        for r in rows
    ]


def top_markets_valued(league: str, hours: int, limit: int, by: str, ref_value: dict[str, float]) -> list[dict]:
    """Busiest markets with `value_ex` (traded value in the reference, volume × ref value; the other
    side of the trade is the fallback). `by='activity'` keeps the raw turnover order; `by='value'`
    re-sorts on value_ex. Pulls the full field (not top-N) so a value sort is over every market."""
    rows = top_markets(league, hours, max(limit, 1000))
    for r in rows:
        va = (r.get("volume_a") or 0) * (ref_value.get(r["a"]) or 0)
        vb = (r.get("volume_b") or 0) * (ref_value.get(r["b"]) or 0)
        r["value_ex"] = round(va or vb, 2) if (va or vb) else None
    if by == "value":
        rows.sort(key=lambda r: (r.get("value_ex") or 0), reverse=True)
    return rows[:limit]
