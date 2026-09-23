"""The live price board: each watched currency priced in the reference with spread, depth,
freshness, trend and %-change over the app-wide window; plus the edge table / pair list."""
from __future__ import annotations

import time

from .. import cache, centrality, digest, leaguehistory, marketseries, orderbook, session
from .. import settings as settings_mod
from ..currencies import registry
from ..settings import get_settings
from . import graph
from .graph import INF, counterparts_by_volume   # THE volume rule lives in graph.py; re-exported here

_board_cache: dict = {}
BOARD_TTL_S = 30.0


def board(window_h: int = 24, nums: dict[str, str] | None = None) -> dict:
    """Live price board: each watched currency priced in the reference, with freshness and a
    trend series.

    `window_h` is the trend/%-change horizon (24h, 3d, 7d, 14d from the UI): the sparkline
    spans it and change_pct is measured over it. `nums` is the client's per-card "priced in"
    picks (`{currency: numeraire}`): a card's trend and % are the history of the market it is
    SHOWN in, so a pick that changes the market changes the line with it.

    Prices are R-per-unit (reference currency per 1 of the currency), so bigger = more
    valuable — the natural way to read a price.

    Result is TTL-cached: it runs one history query per watched currency, but the
    underlying digest only changes hourly, so repeated polls are served from memory
    (invalidated when a new live book lands, via orderbook.state["version"])."""
    s0 = get_settings()
    window_h = max(1, int(window_h or 24))
    nums = {str(k): str(v) for k, v in (nums or {}).items() if k != v}
    key = (s0["league"], s0["reference"], tuple(s0["watchlist"]), window_h, s0.get("hub_count"),
           tuple(sorted(nums.items())))
    return cache.memo(_board_cache, key, BOARD_TTL_S, lambda: _board(window_h, nums),
                      version=orderbook.state["version"], max_entries=32)   # one per pick set, bounded


def _board(window_h: int, nums: dict[str, str]) -> dict:
    g = graph.cached_graph()
    s = g.s
    R = s["reference"]
    league = s["league"]
    rv = g.values()                          # THE value table (Graph.values) — every card prices from it
    ranked = counterparts_by_volume(g, rv)   # default numeraire: the highest-volume readable counterpart
    hub_ids = centrality.hubs(g, rv, settings_mod.hub_count(s))   # top PageRank → Board "hub" chip (count user-tunable)
    # One-time: seed the board with the market's hub currencies so a fresh board always shows the
    # central markets. Runs once, only once real hubs are known (skips the cold graph), then the
    # user owns the board — later removals stick (mirrors the _liq_floor_v1 seed in settings.py).
    if hub_ids and not s.get("_hub_seed_v1"):
        missing = centrality.seed_missing(s["watchlist"], hub_ids, R)
        settings_mod.save_settings({"watchlist": s["watchlist"] + missing, "_hub_seed_v1": True})
        s["watchlist"] = s["watchlist"] + missing
    scout = leaguehistory.scout_prices(league)   # poe2scout fallback prices (Exalted), by name/slug
    scout_hist = leaguehistory.scout_history(league)   # poe2scout daily trend, by name/slug
    rows = [_row(g, rv, ranked, hub_ids, c, nums.get(c), window_h, scout, scout_hist)
            for c in s["watchlist"] if c != R]
    rows.sort(key=lambda r: (r["mid"] is None, -(r["mid"] or 0)))   # most valuable first
    # One price table: every number on a card is a ratio of two of these, so nothing on a card
    # can contradict anything else on it (a cranium once read 16.77 div and 4,620 ex at once).
    return {"reference": R, "league": league, "rows": rows, "prices": _prices(g, rv, rows),
            "session": session.status().get("connected", False)}


def cards(ids, window_h: int = 24, picks: dict[str, str] | None = None) -> dict[str, dict]:
    """Board cards for any currencies the graph prices, on the board or not: {id: row}, each
    built exactly like a board card (_row) and shown in `picks[id]` when given, else the volume
    rule's numeraire. The volume ranking, hubs and poe2scout lookups are computed once for the
    batch, so Hold/Movers can card hundreds of assets."""
    g = graph.cached_graph()
    rv = g.values()
    R = g.s["reference"]
    window_h = max(1, int(window_h or 24))
    league = g.s["league"]
    ranked = counterparts_by_volume(g, rv)
    hub_ids = centrality.hubs(g, rv, settings_mod.hub_count(g.s))
    scout, scout_hist = leaguehistory.scout_prices(league), leaguehistory.scout_history(league)
    picks = picks or {}
    ids = [c for c in dict.fromkeys(ids) if c != R and rv.get(c)]
    # One card: its own queries. Many: read the window once (digest.window_history).
    shared = digest.window_history(league, window_h + RATE_WARMUP_H) if len(ids) > 1 else None
    history = _priced_history(league, window_h, shared)
    return {c: _row(g, rv, ranked, hub_ids, c, picks.get(c) if picks.get(c) != c else None, window_h,
                    scout, scout_hist, history)
            for c in ids}


def asset(c: str, window_h: int = 24, num: str | None = None, numeraires=()) -> dict | None:
    """ONE board card (see `cards`) plus the prices the client needs to show it in `num` or any
    of `numeraires`. None when the graph has no value for `c`."""
    row = cards([c], window_h, {c: num} if num else None).get(c)
    if row is None:
        return None
    g = graph.cached_graph()
    prices = _prices(g, g.values(), [row], extra=[n for n in numeraires if n != c])
    return {"row": row, "prices": prices, "reference": g.s["reference"]}

# How long a conversion rate may be carried forward over a gap in its own series. Past this the
# second leg is not really trading, and the combined line would be the first leg scaled by a
# constant — which reports the first leg's move as if it were the move in the shown currency.
CARRY_MAX_H = 6


def _align(a: list[dict], b: list[dict], op) -> list[dict]:
    """Combine two hourly series hour by hour (`b` carried forward over gaps up to CARRY_MAX_H),
    so a line moves between currencies at each hour's own rate, not at today's constant."""
    out, j, last, last_h = [], 0, None, 0
    for p in a:
        while j < len(b) and b[j]["hour"] <= p["hour"]:
            last, last_h = b[j]["rate"], b[j]["hour"]
            j += 1
        if last and p["hour"] - last_h <= CARRY_MAX_H * 3600:
            out.append({"hour": p["hour"], "rate": op(p["rate"], last)})
    return out


def _fold_series(series: list[dict], until: int | None = None) -> list[dict]:
    """A market's per-hour series folded into its PRICE at each hour: the same volume-weighted,
    decayed rate `digest.window_rates` gives the number, evaluated at every point instead of only
    at the newest one. Carried forward as a running sum, so it costs one pass.

    Without it the line is what each hour printed, and a quiet market's hour is one or two trades:
    Divine <-> Distilled Emotion (2026-09-20) traded a single unit at 0.01 for seven hours and then
    one at 1.00, so the number read 0.01 under a line ending at a hundred times that. Each point is
    a weighted mediant of hours the market really traded at, so the line can no more draw a price
    nobody paid than the number can.

    `/api/market/history` deliberately does NOT go through here — that page is the record of what
    executed, and folding it would erase the trades it exists to show."""
    if not series or series[0].get("volume_a") is None:
        return series            # a caller's own rate-only series: nothing to weight by, so as-is
    # Each point is `_fold_rates` over the RATE_WINDOW_H before it — the same rows, the same
    # weights the number gets at that hour — so the line's end IS the number. Rows older than
    # the window leave the running sums at their decayed weight; decay alone never expires them,
    # and a burst two days ago would otherwise bend today's end away from today's number.
    window = digest.RATE_WINDOW_H * 3600
    pts = [p for p in series if p.get("volume_a") and p.get("volume_b")]   # `pair_history` never emits an empty side
    out, na, nb, prev, start = [], 0.0, 0.0, None, 0
    for i, p in enumerate(pts):
        if prev is not None:
            decay = 2.0 ** (-((p["hour"] - prev) / 3600.0) / digest.RATE_HALF_LIFE_H)
            na *= decay
            nb *= decay
        prev = p["hour"]
        while pts[start]["hour"] < p["hour"] - window:                  # expired: take it back out
            q = pts[start]
            w = 2.0 ** (-((p["hour"] - q["hour"]) / 3600.0) / digest.RATE_HALF_LIFE_H)
            na -= w * q["volume_a"]
            nb -= w * q["volume_b"]
            start += 1
        na += p["volume_a"]
        nb += p["volume_b"]
        if na > 0:
            out.append({**p, "rate": nb / na})
    if out and until is not None and until > out[-1]["hour"]:
        # One more point at `until`: the same fold, decayed and expired forward to that hour.
        decay = 2.0 ** (-((until - prev) / 3600.0) / digest.RATE_HALF_LIFE_H)
        na *= decay
        nb *= decay
        while start < len(pts) and pts[start]["hour"] < until - window:
            q = pts[start]
            w = 2.0 ** (-((until - q["hour"]) / 3600.0) / digest.RATE_HALF_LIFE_H)
            na -= w * q["volume_a"]
            nb -= w * q["volume_b"]
            start += 1
        if start < len(pts) and na > 0:
            out.append({"hour": until, "rate": nb / na, "volume_a": 0, "volume_b": 0})
    return out


# A point at the LEFT edge of the window needs the hours before it, or the start of a 24h line
# would be folded from one or two hours while its right-hand end had two days behind it — a line
# that droops at the left for no reason. Read a window's worth of warm-up, draw only the window.
RATE_WARMUP_H = int(digest.RATE_WINDOW_H)


def _priced_history(league: str, window_h: int, shared=None, now: int | None = None):
    """`history(a, b, h)` giving the PRICE of b in a at each hour (`_fold_series`), rather than
    what that hour printed. `shared` is the batch reader (`digest.window_history`) when one card's
    worth of queries would be repeated across hundreds of assets. The line always reaches `now`
    (the clock's hour): its last point is the same 48h fold the number is, so it ends on the
    number whether the market traded this hour or two days ago (owner, 2026-09-23)."""
    span = window_h + RATE_WARMUP_H
    base = shared if shared is not None else (
        lambda a, b, _h: digest.pair_history(league, a, b, span))   # noqa: E731
    end = digest._hour(time.time()) if now is None else now

    def history(a, b, h):
        folded = _fold_series(base(a, b, span), until=end)
        if not folded:
            return folded
        # A folded line's last hour IS `end`; a caller's own rate-only series keeps its own end.
        cutoff = folded[-1]["hour"] - h * 3600
        shown = [p for p in folded if p["hour"] >= cutoff]
        if len(shown) < 2:
            # Nothing traded inside the window: a flat line from the last trade to now, not a dot.
            shown = folded[-2:]
        return shown
    return history


def _series(g, c: str, n: str, window_h: int, history, seen=()) -> list[dict]:
    """The hourly price of `c` in `n`, built from the markets that PRICE them (Graph.priced_by),
    the same chain the number itself comes from.

    A card shown in a currency its own market doesn't trade used to draw the reference market's
    line instead: a Preserved Cranium priced in Chaos showed the number from its Divine market
    (14.67 div) under a line from its thin Exalted market (−19.9%), while its real markets moved
    −17.2% and −18.2%. Both legs walk up to the reference and divide, so the line is always the
    markets that set the price, expressed in the currency on screen."""
    if c == n or c in seen or n in seen:
        return []
    p = g.priced_by.get(c)
    if p == n:                                            # n is the market that prices c
        return history(c, n, window_h)
    if g.priced_by.get(n) == c:                           # ... or the other way round
        return [{"hour": h["hour"], "rate": 1.0 / h["rate"]} for h in history(n, c, window_h) if h["rate"]]
    to_ref_c = _to_ref(g, c, window_h, history, seen)
    to_ref_n = _to_ref(g, n, window_h, history, seen)
    if len(to_ref_c) < 2 or len(to_ref_n) < 2:
        return []
    return _align(to_ref_c, to_ref_n, lambda x, y: x / y)


def _to_ref(g, c: str, window_h: int, history, seen=()) -> list[dict]:
    """The hourly price of `c` in the reference, up its pricing chain."""
    R = g.s["reference"]
    if c == R or c in seen:
        return []
    p = g.priced_by.get(c)
    if p is None:
        return []
    legs = history(c, p, window_h)
    if p == R or len(legs) < 2:
        return legs
    up = _to_ref(g, p, window_h, history, (*seen, c))     # `c` is only marked as we leave it
    return _align(legs, up, lambda x, y: x * y) if len(up) >= 2 else []



def _row(g, rv: dict[str, float], ranked, hub_ids, c: str, pick: str | None, window_h: int,
         scout, scout_hist, history=None) -> dict:
    """One card: `c` priced in the reference, shown in `pick` (the client's "priced in" choice)
    or the volume rule's default, with the trend and % of the market it is shown in."""
    s = g.s
    R = s["reference"]
    league = s["league"]
    if history is None:                          # the price of b in a, hour by hour
        history = _priced_history(league, window_h)
    mid = rv.get(c)     # includes the poe2scout fallback threaded through ref_values
    # Default numeraire: the highest-VOLUME counterpart whose price stays readable.
    # Cheap currencies' biggest market is often Divine (huge value moves even on
    # modest flow), which would print a useless micro-price (Regal = 0.0034 div) — so
    # walk down the volume ranking and take the first counterpart the card is worth at
    # least ONE of. That is how prices are quoted by hand: a card is never shown in a
    # currency worth more than the card (a 0.5 floor once put Chaos "in Omen of Abyssal
    # Echoes" at 0.43 the hour that omen out-traded Exalted). Divine keeps its Chaos
    # market, omens keep Divine, Regal/Chaos/Vaal drop to Exalted. Currencies with no
    # liquid, readable market (poe2scout-only, or thin digest) tier by value instead.
    MIN_READABLE = 1.0   # numeraire units per 1 of the currency; below this, step down
    pref, seen = None, set()
    for _volr, other in ranked.get(c, ()):
        if other == c or other in seen:
            continue
        seen.add(other)
        nv = rv.get(other)
        if nv and mid and mid / nv >= MIN_READABLE:
            pref = other
            break
    if pref is None:
        mv, dv = rv.get("mirror"), rv.get("divine")
        if mid and mv and mid >= mv:
            pref = "mirror"
        elif mid and dv and mid >= dv:
            pref = "divine"
        else:
            pref = R
    # Universal rule: NOTHING is ever priced against itself (a 1:1 is useless).
    if pref == c:
        pref = "divine" if (c != "divine" and rv.get("divine")) else R
    # Trend + %-change over the selected window (24h/3d/7d/14d), from the SAME market the
    # card's price comes from. When the volume rule prices the card by its own market with
    # the numeraire it is shown in (the user's pick, else `pref`; omens in Divine: thousands
    # of trades an hour), the line and the % are that market's history — the omen↔reference
    # market trades a handful of times an hour and once drew a −29% line under a card whose
    # real market moved −12%. Otherwise the reference market's history (hourly digest), else
    # poe2scout dailies. `trend_num` says which currency the points are in, so the client
    # can reprice them into any numeraire.
    # The numeraire the card is shown in: the client's pick, with the client's own
    # fallbacks (BoardView.numFor) so the two never disagree about which market is drawn.
    shown = pick or pref
    if shown == c:
        shown = "divine" if (c != "divine" and rv.get("divine")) else R
    if not rv.get(shown):
        shown = R
    # ONE decision for the whole row: does the card's own market with `shown` price it (the value
    # table)? Then source, freshness and the trend all describe THAT market; otherwise they all
    # describe the reference market. (Bid/ask/spread were cut on 2026-09-23: with the bulk-exchange
    # books gone the digest gives one window rate both ways, so they were the number twice.)
    direct = g.direct_rate(c, shown)
    # The card's own market prices it when that market is the one the value table used (either
    # orientation — Graph.priced_by says so). Deriving it from a float identity instead silently
    # failed on every live pair with a spread, and those cards fell back to the reference market.
    own_market = shown != R and (g.priced_by.get(c) == shown or g.priced_by.get(shown) == c)
    mkt = shown if own_market else R
    buy_edge = g.edges.get((mkt, c))     # c per mkt
    sell_edge = g.edges.get((c, mkt))    # mkt per c
    edges = [e for e in (buy_edge, sell_edge) if e]
    # Source label + freshness: live/digest exchange data; a currency the exchange graph
    # doesn't cover is priced from poe2scout ("scout"); anything else valued only via
    # multi-hop is "derived".
    kinds = {e.kind for e in edges}
    in_scout = bool(leaguehistory.scout_lookup(scout, c))
    source = ("live" if "live" in kinds else "digest" if "digest" in kinds
              else "scout" if (not kinds and in_scout) else ("derived" if mid is not None else None))
    age = min((e.age_s for e in edges), default=None)
    # The line under the number is the same markets as the number, expressed in the currency the
    # card is shown in (_series). Failing that, its price against the reference; failing that,
    # poe2scout dailies.
    trend, trend_num = [], R
    hist = _series(g, c, shown, window_h, history)
    if len(hist) >= 2:
        trend = [{"t": h["hour"], "v": h["rate"]} for h in hist]
        trend_num = shown
    if len(trend) < 2:
        hist = _to_ref(g, c, window_h, history) or history(c, R, window_h)
        trend = [{"t": h["hour"], "v": h["rate"]} for h in hist]
        trend_num = R
    if len(trend) < 2:   # not on the exchange digest → draw from poe2scout dailies
        sh = leaguehistory.scout_lookup(scout_hist, c)
        if sh:
            cutoff = sh[-1]["t"] - window_h * 3600
            trend = [p for p in sh if p["t"] >= cutoff] or sh[-2:]
            trend_num = "exalted"          # poe2scout closes are Exalted whatever the reference
    # change over the window = latest vs the point at (or nearest before) the window start.
    change_pct = marketseries.change_over(trend, window_h * 3600)[1]
    return {
        "id": c, "name": registry.name(c), "mid": mid, "source": source, "age_s": age,
        "trend": trend, "trend_num": trend_num, "change_pct": change_pct,
        "pref_num": pref, "hub": c in hub_ids,
    }


def _prices(g, rv: dict[str, float], rows: list[dict], extra=()) -> dict:
    R = g.s["reference"]
    # Reference-currency price (R per unit) for every currency usable as a numeraire,
    # so the client can reprice any card into any of them. Reference itself is 1.
    need = {R} | set(extra) | {r["id"] for r in rows} | {r["pref_num"] for r in rows} | {r["trend_num"] for r in rows}
    prices = {i: (1.0 if i == R else rv.get(i)) for i in need if i == R or rv.get(i)}
    if "exalted" not in prices and R != "exalted":
        # A scout-only card's trend is in Exalted (dailies) — the client needs its reference price.
        ex = rv.get("exalted")
        if ex:
            prices["exalted"] = ex
    return prices


def board_pairs() -> list[tuple[str, str]]:
    s = get_settings()
    R = s["reference"]
    pairs = []
    for c in s["watchlist"]:
        if c != R:
            pairs.append((R, c))
            pairs.append((c, R))
    return pairs


def edge_table() -> list[dict]:
    g = graph.cached_graph()
    ref = g.values()
    rows = []
    for (a, b), e in g.edges.items():
        rows.append({
            "from": a, "to": b, "from_name": registry.name(a), "to_name": registry.name(b),
            "kind": e.kind, "rate": e.rate, "age_s": e.age_s,
            "capacity_in": None if e.capacity_in() == INF else e.capacity_in(),
            "capacity_ref": None if e.capacity_ref(ref) == INF else e.capacity_ref(ref),
            "depth": len(e.ladder), "meta": e.meta,
        })
    rows.sort(key=lambda r: (r["from_name"], r["to_name"]))
    return rows
