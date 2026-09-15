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

import datetime as _dt
import statistics
import time

from . import db
from .leaguehistory import _slug
from .settings import get_settings

_DAY = 86400
# Median daily traded VALUE (Exalted) floor: mutes thin-item noise so a lone daily-close
# blip on an illiquid item can't top the movers list. Value (not units) so it's fair
# across a Mirror (few units, huge value) vs an essence (many units, small value).
MIN_VALUE_EX = 100_000.0

_cache: dict = {}
_TTL = 300


def _win_days(window_h: int) -> int:
    return max(1, round((window_h or 24) / 24))


def _current_series():
    """(current_league, {item_id: [(t_epoch, close_ex, value_ex)] oldest→newest},
    {item_id: (name, category)}) — the current league's daily series. Cached ~5 min."""
    league = get_settings()["league"]
    hit = _cache.get(league)
    if hit and time.time() - hit[0] < _TTL:
        return hit[1]
    with db.q() as c:
        meta = {r["item_id"]: (r["name"], r["category"]) for r in c.execute("SELECT item_id, name, category FROM item_meta")}
        rows = c.execute("SELECT league, item_id, day, close, volume FROM league_daily WHERE close>0 ORDER BY league, day").fetchall()
    day0s: dict[str, str] = {}
    for r in rows:                       # rows are ORDER BY league, day → first day per league is day-0
        day0s.setdefault(r["league"], r["day"])
    cur_name = league
    if cur_name not in day0s:            # viewing a league with no data → newest league that does
        current = set(db.kv_get("lh_current", []))
        cur_name = next((l for l in day0s if l in current), None) or (max(day0s, key=lambda l: day0s[l] or "") if day0s else None)
    series: dict[int, list] = {}
    for r in rows:
        if r["league"] != cur_name:
            continue
        try:
            t = int(_dt.datetime.strptime(r["day"], "%Y-%m-%d").replace(tzinfo=_dt.timezone.utc).timestamp())
        except Exception:
            continue
        series.setdefault(r["item_id"], []).append((t, r["close"], (r["volume"] or 0) * r["close"]))
    out = (cur_name, series, meta)
    _cache[league] = (time.time(), out)
    return out


def _change_pct(pts, window_days):
    """% change of close over the window: last close vs the close at (or nearest before)
    the window start — the same measure the price board uses for its scout-sourced rows."""
    if len(pts) < 2:
        return None
    last_t, last_c = pts[-1][0], pts[-1][1]
    start = last_t - window_days * _DAY
    prior = [p for p in pts if p[0] <= start]
    base = prior[-1] if prior else pts[0]
    if not base[1]:
        return None
    return (last_c - base[1]) / base[1] * 100


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


def asset_row(q: str, window_h: int = 24) -> dict | None:
    """A single asset's CardDetail-shaped detail for the Board's expand modal, priced in
    the league base (Exalted = the board reference). `q` is a name or slug."""
    wd = _win_days(window_h)
    cur_name, series, meta = _current_series()
    ql = q.strip().lower()
    iid = next((k for k, (name, _c) in meta.items() if name.lower() == ql or _slug(name) == ql), None)
    if iid is None or iid not in series:
        return None
    pts = series[iid]
    name, cat = meta[iid]
    last_t = pts[-1][0]
    # Scope the detail graph to the SELECTED window so the line matches the headline % (a
    # full-league graph made a 3-day +557% trough-bounce look flat). Start at the exact base
    # point change_pct measures from — the newest point at/before the window start — so the
    # first plotted value IS the % denominator and the graph rises by change_pct across the
    # window. Falls back to the whole series if there's no point before the window start.
    start = last_t - wd * _DAY
    prior = [p for p in pts if p[0] <= start]
    base = prior[-1] if prior else pts[0]
    win_pts = [base] + [p for p in pts if p[0] > start]
    if len(win_pts) < 2:                       # degenerate (e.g. brand-new item): show a bit more
        win_pts = pts[-2:] if len(pts) >= 2 else pts
    trend = [{"t": p[0], "v": p[1]} for p in win_pts]
    ch = _change_pct(pts, wd)
    row = {"id": _slug(name), "name": name, "category": cat,
           "mid": pts[-1][1], "buy": None, "sell": None, "spread": None, "spread_pct": None,
           "source": "scout", "age_s": max(0, int(time.time()) - last_t), "depth": None,
           "trend": trend, "change_pct": round(ch, 1) if ch is not None else None,
           "medvol": round(statistics.median(p[2] for p in pts)), "pref_num": "divine"}
    # Reference-currency (Exalted per unit) prices for the hard numeraires, keyed by the
    # REGISTRY ids the client's Cur/board use ("divine", not poe2scout's "divine-orb"), so
    # CardDetail can reprice into them and show "value in other currencies".
    from . import leaguehistory
    sp = leaguehistory.scout_prices(cur_name)
    prices = {"exalted": 1.0}
    for rid, nm in (("divine", "divine orb"), ("chaos", "chaos orb"), ("mirror", "mirror of kalandra")):
        if sp.get(nm):
            prices[rid] = sp[nm]
    return {"row": row, "prices": prices, "reference": "exalted"}
