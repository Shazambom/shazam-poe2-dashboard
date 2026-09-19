"""Biggest movers: the full poe2scout currency universe ranked by % change over a window.
Deliberately DISTINCT from the Hold leaderboard (holdscore) — Hold ranks by a store-of-value
score (return × confidence × stability); Movers is raw market movement, both gainers AND
crashers, so a volatile spike or crash surfaces here but not in Hold.

Also serves a single asset's detail so the expand modal (CardDetail) can zoom into any item from
Hold, Movers or the Board's pulse strip. An asset the exchange trades is measured by the HOURLY
exchange card the board builds (arbitrage.cards): this hour's price and the % over exactly the
window, in the market the volume rule shows it in. Anything else falls back to poe2scout's DAILY
series in `league_daily`.
"""
from __future__ import annotations

import statistics
import time

from . import cache, db, marketseries
from .leaguehistory import _slug
from .settings import get_settings

_DAY = 86400
# Median daily traded VALUE (Exalted) floor: mutes thin-item noise so a lone daily-close
# blip on an illiquid item can't top the movers list. Value (not units) so it's fair
# across a Mirror (few units, huge value) vs an essence (many units, small value).
MIN_VALUE_EX = 100_000.0

_cache: dict = {}
_movers_cache: dict = {}     # ranked movers per (league, window, n, floor, direction)
_TTL = 300


_win_days = marketseries.win_days


def _reference() -> str:
    """The league base every mover is measured against (the app's reference currency)."""
    return get_settings()["reference"]


def _current_series():
    """(current_league, {item_id: [(t_epoch, close_ex, value_ex)] oldest→newest},
    {item_id: (name, category)}) — the current league's daily series. Cached ~5 min."""
    league = get_settings()["league"]
    return cache.memo(_cache, league, _TTL, lambda: _build_current_series(league))


def _build_current_series(league: str):
    # Read + shaping live in the stdlib `marketseries` module (shared with the analytics sidecar);
    # here we only pick which league to view (needs settings + the lh_current kv).
    with db.q() as c:
        meta = marketseries.read_meta(c)
        rows = marketseries.read_rows(c)          # all leagues, ORDER BY league, day
    cur_name = marketseries.pick_league(rows, league, db.kv_get(marketseries.CURRENT_LEAGUES_KEY, []))
    series = marketseries.build_series(rows, cur_name)
    return cur_name, series, meta


def current_league() -> str | None:
    """The league the board/movers currently resolve to (the user's setting, or the newest league
    with data). The one place callers should get 'which league are we showing' — via the shared
    5-min cache, so it's cheap to call."""
    return _current_series()[0]


def _change_pct(pts, window_days):
    """% change of close over the window: last close vs the close at (or nearest before)
    the window start — the same measure the price board uses for its scout-sourced rows."""
    return marketseries.change_over(pts, window_days * _DAY, t=lambda p: p[0], v=lambda p: p[1])[1]


def exchange_cards(names, window_h: int, num: str | None = None) -> dict[str, dict]:
    """{name: board card} for every poe2scout item name the exchange prices with HOURLY data
    (live/digest), shown in `num` (a trade id) or the volume rule's numeraire — the card builder
    draws its line in that same currency. Names the exchange doesn't trade are absent, so callers
    fall back to the poe2scout dailies for them."""
    from . import arbitrage
    tids = {nm: _trade_id(nm) for nm in names}
    rows = arbitrage.cards([t for t in tids.values() if t], window_h,
                           {t: num for t in tids.values() if t} if num else None)
    return {nm: rows[t] for nm, t in tids.items()
            if t and t in rows and rows[t]["source"] in ("live", "digest")}


def top_movers(window_h: int = 24, n: int = 3, min_value_ex: float = MIN_VALUE_EX,
               direction: str = "both") -> dict:
    return cache.memo(_movers_cache, (get_settings()["league"], window_h, n, min_value_ex, direction), _TTL,
                      lambda: _top_movers(window_h, n, min_value_ex, direction), max_entries=32)


def _top_movers(window_h: int, n: int, min_value_ex: float, direction: str) -> dict:
    """direction: 'both' (default) ranks by |% change| — spikes AND crashes; 'up' keeps only
    gainers (biggest first); 'down' keeps only losers (biggest drop first). The Hold page's
    'Positive movers' board uses 'up' to show only upward swings.

    An asset the exchange trades moves by its HOURLY card (exchange_cards): the % over exactly
    the window, measured in the league base so every row is comparable (`num` on each row — the
    zoom opens in it, so the card's % is the number clicked). Anything else moves by poe2scout's
    daily closes, in the same base."""
    wd = _win_days(window_h)
    cur_name, series, meta = _current_series()
    liquid = {}
    for iid, pts in series.items():
        medval = statistics.median(p[2] for p in pts)
        if medval >= min_value_ex:
            liquid[iid] = medval
    # Ranked in the league base, one currency for every row: a % against Divine and a % against
    # Exalted are not comparable, and sorting them together makes an asset that only sat still
    # while Exalted inflated look like a mover.
    base = _reference()
    hourly = exchange_cards([meta.get(iid, (str(iid), "?"))[0] for iid in liquid], window_h, base)
    out = []
    for iid, medval in liquid.items():
        name, cat = meta.get(iid, (str(iid), "?"))
        card = hourly.get(name)
        # the daily fallback is smoothed exactly like the card's (_median3), or the row and the
        # card it opens disagree for the same asset
        ch, num = (card["change_pct"], card["trend_num"]) if card else (_change_pct(_median3(series[iid]), wd), base)
        if ch is None:
            continue
        if direction == "up" and ch <= 0:
            continue
        if direction == "down" and ch >= 0:
            continue
        out.append({"id": _slug(name), "name": name, "category": cat,
                    "change_pct": round(ch, 1), "medvol": round(medval), "num": num})
    if direction == "up":
        out.sort(key=lambda x: -x["change_pct"])     # biggest gain first
    elif direction == "down":
        out.sort(key=lambda x: x["change_pct"])       # biggest drop first
    else:
        out.sort(key=lambda x: -abs(x["change_pct"]))  # biggest absolute move first
    return {"league": cur_name, "window_h": window_h, "delta_days": wd, "direction": direction,
            "count": len(out), "assets": out[:n]}


def _median3(pts):
    """A daily series with each value replaced by the median of it and its neighbouring DAYS —
    the same smoothing the Hold board applies (holdscore._smooth, which is also day-keyed, so a
    series with missing days smooths identically in both). Thin poe2scout closes are riddled with
    single-day spikes, and Hold and this card used to disagree wildly about the same asset (one
    read +2,467% where the other read +4,935%) purely because only one of them smoothed."""
    by_day = {p[0]: p[1] for p in pts}
    out = []
    for t, v, vol in pts:
        win = [by_day[d] for d in (t - _DAY, t, t + _DAY) if d in by_day]
        out.append((t, statistics.median(win), vol))
    return out


def _carry_forward(anchor_pts, days) -> dict:
    """{day: close} for each of `days`, using the anchor's close that day or its latest earlier one."""
    out, j, last = {}, 0, None
    for t in days:
        while j < len(anchor_pts) and anchor_pts[j][0] <= t:
            last = anchor_pts[j][1]
            j += 1
        if last:
            out[t] = last
    return out


def _trade_id(name: str) -> str | None:
    """The exchange's id for a poe2scout item name (registry trade ids: "hinekoras-lock", not
    the slug of every name), or None when the exchange doesn't trade it."""
    from .currencies import registry
    want = name.strip().lower()
    for cand in (want, _slug(name)):
        if cand in registry.by_id:
            return cand
    return next((cid for cid, cur in registry.by_id.items() if cur.name.lower() == want), None)


def _anchor_ids() -> list[str]:
    """The anchor numeraires (marketseries.ANCHORS) as exchange trade ids — the card's
    "priced in" choices, Hold's numeraires included."""
    from .currencies import registry
    return [registry.resolve_meta(a.metadata_id) or k for k, a in marketseries.ANCHORS.items()]


def asset_row(q: str, window_h: int = 24, num: str | None = None) -> dict | None:
    """A single asset's CardDetail-shaped detail for the expand modal (Hold, Movers, the Board's
    pulse strip). `q` is a name or slug; `num` the numeraire the card is shown in (Hold passes
    its anchor slug).

    An asset the exchange trades is the SAME card the board builds (arbitrage.asset): this
    hour's price, the volume rule's numeraire, and the hourly trend and % of the market it is
    shown in — a daily close is a day behind a market that moves 15% a day. Anything the
    exchange doesn't trade falls back to poe2scout's daily closes (`_daily_row`)."""
    from . import arbitrage
    from .currencies import registry
    if num in marketseries.ANCHORS:                                  # Hold passes the anchor slug
        num = registry.resolve_meta(marketseries.ANCHORS[num].metadata_id) or num
    tid = _trade_id(q)
    if tid:
        card = arbitrage.asset(tid, window_h, num, numeraires=["exalted", *_anchor_ids(), *([num] if num else [])])
        if card and card["row"]["source"] in ("live", "digest"):    # the exchange prices it
            return card
    return _daily_row(q, window_h, num)


def _daily_row(q: str, window_h: int = 24, num: str | None = None) -> dict | None:
    """The poe2scout-daily card, for assets the exchange doesn't trade. ONE source: the daily
    closes. The number, the line and the % are all
    that series expressed in the numeraire the card is shown in (`num`, else Divine when the
    asset is worth at least one, else Exalted) — divided day by day by the numeraire's OWN
    daily close, so a card priced in Divine moves the way it moved against Divine. (Mixing an
    exchange rate into the headline while the % stayed in Exalted printed +29% on assets that
    were flat in Divine.)"""
    wd = _win_days(window_h)
    cur_name, series, meta = _current_series()
    ql = q.strip().lower()
    iid = next((k for k, (name, _c) in meta.items() if name.lower() == ql or _slug(name) == ql), None)
    if iid is None or iid not in series:
        return None
    pts = series[iid]                        # raw closes; the RATIO is what gets smoothed, below
    name, cat = meta[iid]
    last_t = pts[-1][0]
    # Daily closes (Exalted) of the anchor numeraires from the same table (marketseries.ANCHORS,
    # the one anchor vocabulary — Hold's numeraires included). A day the anchor has no close for
    # carries its latest earlier close, so a late backfill never drops a numeraire.
    # Keyed by REGISTRY trade id ("hinekoras-lock", not the anchor slug "lock") — that is
    # what the client's Cur icons/names and its "priced in" list resolve.
    from .currencies import registry
    anchor_series: dict[str, dict | None] = {"exalted": None}        # the base itself: 1 per day
    for key, anchor in marketseries.ANCHORS.items():
        rid = registry.resolve_meta(anchor.metadata_id) or key
        if anchor.item_id in series and anchor.item_id != iid:
            anchor_series[rid] = _carry_forward(series[anchor.item_id], [p[0] for p in pts])
    # Reference (Exalted per unit) prices of the anchors on the asset's latest day, so the
    # client can show "value in other currencies" and reprice the card among them.
    prices = {"exalted": 1.0}
    for rid, days in anchor_series.items():
        if days and days.get(last_t):
            prices[rid] = days[last_t]
    row_id = _slug(name)
    # The numeraire the card is shown in: the client's pick if it is priced, else Divine when
    # the asset is worth at least one (the board's readability rule), else Exalted. Never
    # against itself (the anchors were skipped for the asset's own item id above).
    pref = "divine" if (prices.get("divine") and pts[-1][1] / prices["divine"] >= 1.0) else "exalted"
    if num in prices:
        pref = num
    days_n = anchor_series.get(pref)
    in_num = pts if days_n is None else [(t, v / days_n[t], val) for t, v, val in pts if days_n.get(t)]
    if len(in_num) < 2:
        in_num, pref = pts, "exalted"
    # Smooth the price IN THE NUMERAIRE, in that order — exactly what the Hold board scores
    # (holdscore._build_league divides, then _smooth takes the median). Smoothing each series
    # first and dividing after gives a different number, and Hold and this card then disagree
    # about the same asset (one read +902%, the other +1,054%).
    in_num = _median3(in_num)
    # Scope the detail graph to the SELECTED window so the line matches the headline % (a
    # full-league graph made a 3-day +557% trough-bounce look flat). Start at the exact base
    # point change_pct measures from — the newest point at/before the window start — so the
    # first plotted value IS the % denominator and the graph rises by change_pct across the
    # window. Falls back to the whole series if there's no point before the window start.
    start = in_num[-1][0] - wd * _DAY
    base, ch = marketseries.change_over(in_num, wd * _DAY, t=lambda p: p[0], v=lambda p: p[1])
    win_pts = [base] + [p for p in in_num if p[0] > start]
    if len(win_pts) < 2:                       # degenerate (e.g. brand-new item): show a bit more
        win_pts = in_num[-2:] if len(in_num) >= 2 else in_num
    trend = [{"t": p[0], "v": p[1]} for p in win_pts]
    row = {"id": row_id, "name": name, "category": cat,
           # mid stays Exalted per unit (the client's contract: mid / prices[num] = the shown
           # price), and it equals the last trend point × prices[pref] by construction.
           "mid": in_num[-1][1] * prices.get(pref, 1.0), "buy": None, "sell": None, "spread": None, "spread_pct": None,
           "source": "scout", "age_s": max(0, int(time.time()) - last_t), "depth": None,
           "trend": trend, "trend_num": pref, "change_pct": round(ch, 1) if ch is not None else None,
           "medvol": round(statistics.median(p[2] for p in pts)), "pref_num": pref}
    return {"row": row, "prices": prices, "reference": "exalted"}
