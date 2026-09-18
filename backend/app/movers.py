"""Biggest movers: the full poe2scout currency universe ranked by |% change| over a
window. Deliberately DISTINCT from the Hold leaderboard (holdscore) — Hold ranks by a
store-of-value score (return × confidence × stability, priced in Divine); Movers is raw
market movement in the league base (Exalted, = the board's reference), both gainers AND
crashers, so a volatile spike or crash surfaces here but not in Hold.

Also serves a single asset's price/volume detail so the Board's expand modal (CardDetail)
can zoom into any pulse-strip item, not just watchlist currencies. Both draw from the same
poe2scout DAILY series in `league_daily` that Hold uses, but rank/shape it differently.

Pure Python (stdlib only); a few hundred items × ~150 days, cached briefly.
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
_TTL = 300


_win_days = marketseries.win_days


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


def top_movers(window_h: int = 24, n: int = 3, min_value_ex: float = MIN_VALUE_EX,
               direction: str = "both") -> dict:
    """direction: 'both' (default) ranks by |% change| — spikes AND crashes; 'up' keeps only
    gainers (biggest first); 'down' keeps only losers (biggest drop first). The Hold page's
    'Positive movers' board uses 'up' to show only upward swings."""
    wd = _win_days(window_h)
    cur_name, series, meta = _current_series()
    out = []
    for iid, pts in series.items():
        ch = _change_pct(pts, wd)
        if ch is None:
            continue
        if direction == "up" and ch <= 0:
            continue
        if direction == "down" and ch >= 0:
            continue
        medval = statistics.median(p[2] for p in pts)
        if medval < min_value_ex:
            continue
        name, cat = meta.get(iid, (str(iid), "?"))
        out.append({"id": _slug(name), "name": name, "category": cat,
                    "change_pct": round(ch, 1), "medvol": round(medval)})
    if direction == "up":
        out.sort(key=lambda x: -x["change_pct"])     # biggest gain first
    elif direction == "down":
        out.sort(key=lambda x: x["change_pct"])       # biggest drop first
    else:
        out.sort(key=lambda x: -abs(x["change_pct"]))  # biggest absolute move first
    return {"league": cur_name, "window_h": window_h, "delta_days": wd, "direction": direction,
            "count": len(out), "assets": out[:n]}


_ANCHORS = ("divine", "chaos", "exalted", "mirror")


def asset_row(q: str, window_h: int = 24, num: str | None = None) -> dict | None:
    """A single asset's CardDetail-shaped detail for the Board's expand modal. `q` is a name
    or slug. ONE source: the poe2scout daily closes. The number, the line and the % are all
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
    pts = series[iid]
    name, cat = meta[iid]
    last_t = pts[-1][0]
    # Daily closes (Exalted) of the anchor numeraires, keyed by day, from the same table.
    from .currencies import registry
    anchor_series = {}
    for rid in _ANCHORS:
        aname = str(registry.name(rid)).lower()
        aid = next((k for k, (n, _c) in meta.items() if n.lower() == aname), None)
        if aid in series:
            anchor_series[rid] = {p[0]: p[1] for p in series[aid]}
    anchor_series["exalted"] = None                 # the base itself: 1 per day
    # Reference (Exalted per unit) prices of the anchors on the latest day, so the client can
    # show "value in other currencies" and reprice the card among them.
    prices = {"exalted": 1.0}
    for rid, days in anchor_series.items():
        if days and days.get(last_t):
            prices[rid] = days[last_t]
    row_id = _slug(name)
    # The numeraire the card is shown in: the client's pick if it is priced, else Divine when
    # the asset is worth at least one (the board's readability rule), else Exalted.
    # Never against itself (the row is slug-keyed, "divine-orb"; the anchors are trade ids).
    itself = next((rid for rid in _ANCHORS if str(registry.name(rid)).lower() == name.lower()), None)
    pref = "divine" if (prices.get("divine") and pts[-1][1] / prices["divine"] >= 1.0) else "exalted"
    if num in prices and num != itself:
        pref = num
    if pref == itself:
        pref = "exalted" if itself != "exalted" else "divine"
    days_n = anchor_series.get(pref)
    in_num = pts if days_n is None else [(t, v / days_n[t], val) for t, v, val in pts if days_n.get(t)]
    if len(in_num) < 2:
        in_num, pref = pts, "exalted"
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
           "mid": pts[-1][1], "buy": None, "sell": None, "spread": None, "spread_pct": None,
           "source": "scout", "age_s": max(0, int(time.time()) - last_t), "depth": None,
           "trend": trend, "trend_num": pref, "change_pct": round(ch, 1) if ch is not None else None,
           "medvol": round(statistics.median(p[2] for p in pts)), "pref_num": pref}
    return {"row": row, "prices": prices, "pairs": {}, "reference": "exalted"}
