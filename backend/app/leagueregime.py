"""League regime from market state: EARLY (price discovery), MID (settled), LATE (winding down).

Hold ranks each regime on its own signal set (holdscore.REGIME_SETS), blended by these memberships.
Design and per-league validation: docs/hold-research.md "Regimes".

Stdlib only. Causal: the answer for league-day t reads only days <= t, and every scale is the
league's own (no threshold tuned on past leagues).

Two signals, each with a boundary that comes from what it measures, not from a fit:

  persistence p_t   Cross-sectional Spearman correlation between each liquid item's relative
                    return over (t-H, t] and over (t-2H, t-H] (H = 3 days), taken as the median of
                    the last WEEK daily values. While prices are still being discovered an item
                    that re-priced up keeps going up (p > 0); once prices are found, moves are
                    noise and partly reverse (p <= 0). The boundary is p = 0. Ranks make it blind
                    to the numeraire and to the common drift (Exalted inflation).
  activity R_t      Traded value in Divine (sum close*volume / Divine-in-Exalted), trailing
                    WEEK median, divided by its running peak. 1 - R_t is the share of the
                    league's peak activity that has left. The boundary is "half has left".

Memberships (sum to 1):
    a     = clamp(0.5 + p_t / (2 * max(running max of p, |p_t|)))   # 1 at the opening's persistence,
                                                                    # 0.5 at p = 0
    late  = 1 - R_t
    early = R_t * a
    mid   = R_t * (1 - a)
The returned memberships are the trailing-WEEK mean of those daily values (no flicker at a
boundary). Before persistence can be measured (the first 2H days, and until at least half of
the day's traded items have the full 2H-day history) a = 1: a league with no price history is
in price discovery by definition.
"""
from __future__ import annotations

import datetime as _dt
import math
import statistics

from . import marketseries

DIVINE_ID = marketseries.DIVINE_ID
H = 3               # return leg, days (two legs = one week of history)
WEEK = 7            # smoothing window: removes the weekday/weekend cycle and a partial last day
LIQUID_SHARE = 0.5  # the day's top half by traded value (holdscore.VALUE_PERCENTILE)
MIN_ITEMS = 10

_memo: dict = {}


def _age(day, day0):
    if isinstance(day, int):
        return day - day0
    return (_dt.date.fromisoformat(day) - _dt.date.fromisoformat(day0)).days


def from_rows(rows) -> dict:
    """rows for ONE league: (item_id, day, close_ex, volume) or (league, item_id, day, close_ex,
    volume); day is 'YYYY-MM-DD' or an int league-day. -> {item_id: {age: (close_ex, volume)}}."""
    rows = [r[1:] if len(r) == 5 else r for r in rows]
    rows = [r for r in rows if r[2]]
    if not rows:
        return {}
    day0 = min(r[1] for r in rows)
    per: dict = {}
    for iid, day, close, vol in rows:
        per.setdefault(iid, {})[_age(day, day0)] = (float(close), float(vol or 0))
    return per


def _spearman(a, b) -> float:
    def rk(v):
        o = sorted(range(len(v)), key=v.__getitem__)
        r = [0.0] * len(v)
        i = 0
        while i < len(o):                       # average ranks over ties
            j = i
            while j + 1 < len(o) and v[o[j + 1]] == v[o[i]]:
                j += 1
            for k in range(i, j + 1):
                r[o[k]] = (i + j) / 2
            i = j + 1
        return r
    ra, rb = rk(a), rk(b)
    ma, mb = statistics.fmean(ra), statistics.fmean(rb)
    num = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    den = math.sqrt(sum((x - ma) ** 2 for x in ra) * sum((y - mb) ** 2 for y in rb))
    return num / den if den else 0.0


def _raw_persistence(per, t):
    span = range(t - 2 * H, t + 1)
    have = [i for i, s in per.items() if all(d in s and s[d][0] > 0 for d in span)]
    # the market has to have existed through the window: at least half of today's traded items
    if len(have) < max(MIN_ITEMS, sum(1 for s in per.values() if t in s) / 2):
        return None
    have.sort(key=lambda i: -per[i][t][0] * per[i][t][1])
    have = have[:max(MIN_ITEMS, int(len(have) * LIQUID_SHARE))]
    r1 = [math.log(per[i][t][0] / per[i][t - H][0]) for i in have]
    r0 = [math.log(per[i][t - H][0] / per[i][t - 2 * H][0]) for i in have]
    return _spearman(r0, r1)


def timeline(per: dict, divine_id: int = DIVINE_ID) -> list[dict]:
    """One dict per league-day 0..T with the inputs and the memberships (causal)."""
    T = max((max(s) for s in per.values() if s), default=-1)
    div = per.get(divine_id, {})
    raw_p, val, out, daily = [], [], [], []
    peak_p, peak_v, last_rate = None, 0.0, None
    for t in range(T + 1):
        if t in div and div[t][0] > 0:
            last_rate = div[t][0]
        v = sum(s[t][0] * s[t][1] for s in per.values() if t in s)
        val.append(v / last_rate if last_rate else 0.0)
        rp = _raw_persistence(per, t) if t >= 2 * H else None
        if rp is not None:
            raw_p.append(rp)
        p = statistics.median(raw_p[-WEEK:]) if raw_p else None
        vs = statistics.median(val[-WEEK:])
        peak_v = max(peak_v, vs)
        R = vs / peak_v if peak_v > 0 else 1.0
        if p is None:
            a = 1.0
        else:
            peak_p = p if peak_p is None else max(peak_p, p)
            scale = max(peak_p, abs(p)) or 1.0
            a = min(1.0, max(0.0, 0.5 + p / (2 * scale)))
        daily.append({"early": R * a, "mid": R * (1 - a), "late": 1 - R})
        # memberships = the trailing-WEEK mean of the daily ones: the same window as the inputs,
        # so a one-day wobble around a boundary can't flip the label
        last = daily[-WEEK:]
        w = {k: statistics.fmean(d[k] for d in last) for k in ("early", "mid", "late")}
        out.append({"t": t, "p": p, "raw_p": rp, "R": R, "value_div": vs, "a": a, **w,
                    "regime": max(w, key=w.get)})
    return out


def regime(data, t: int, divine_id: int = DIVINE_ID) -> dict:
    """{'early': w, 'mid': w, 'late': w} for league-day t (weights sum to 1).

    `data`: one league's raw rows (see from_rows) or a per dict {item_id: {age: (close_ex,
    volume)}}. (holdscore's Divine-priced per can't be used: it drops the Divine rate the
    activity signal needs.) Memoized per data object, so calling it for every t is cheap."""
    key = id(data)
    hit = _memo.get(key)
    if hit is None or hit[0] is not data:
        per = data if isinstance(data, dict) else from_rows(data)
        hit = (data, timeline(per, divine_id))
        _memo.clear()
        _memo[key] = hit
    tl = hit[1]
    if not tl:
        return {"early": 1.0, "mid": 0.0, "late": 0.0}
    row = tl[min(max(t, 0), len(tl) - 1)]
    return {k: row[k] for k in ("early", "mid", "late")}
