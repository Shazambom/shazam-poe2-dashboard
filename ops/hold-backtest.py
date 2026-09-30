#!/usr/bin/env python3
"""Hold smoke test: replay the Hold board day by day through a league, hold its top 10, and grade it.

The window (24h / 3d / 7d / 14d — the topbar picker, `frontend/src/lib/horizonStore.js`) is how long
the player plans to hold (owner, 2026-09-30). For every league-day t and every window, rebuild the
board Hold would have shown FOR THAT WINDOW from the prices known on day t, buy its top N in equal
parts, hold them for exactly that window, and see what happened. A ranking the window doesn't move
fails (`window_grade`). Read-only: the DB opens with mode=ro and DATA_DIR points
at a throwaway dir.

    python3 ops/hold-backtest.py --db market.sqlite                     # current league, all horizons, verdict
    python3 ops/hold-backtest.py --db ... --league all                  # every league (holdout check)
    python3 ops/hold-backtest.py --db ... --scorer my.py:fn             # grade a candidate score
    python3 ops/hold-backtest.py --db ... --show-day 12 --horizon 7d    # one day's board and outcomes
    python3 ops/hold-backtest.py --db ... --json out.json
  exit 0 = every threshold met on the graded league(s); 1 = a threshold missed.
  "days/out": days with a readable board / days whose hold has ended. What the LIST is (churn, blue,
  owner, chase) is graded every day up to today; what HOLDING it did, only once the hold has ended.

The portfolio (a player holding the top N, equal parts, bought on the board's day):
  * entry = smoothed price at t+2, exit = smoothed price H days later. `_smooth` spans ±1 day, so
    t+2 shares no close with the day-t board (the measurement trap in
    docs/bugs/2026-09-20-hold-open-items-handoff.md). Prices are in Divine, Hold's numeraire.
  * ret      — the portfolio's return (mean of the picks' simple returns), in Divine
  * vs board — ret minus the same portfolio built from EVERY eligible asset (the "no advice" basket)
  * beat     — share of days the portfolio beat that basket
  * kept     — share of days the portfolio held its value (ret >= 0)
  * crash    — share of picks that lost more than 20% over the hold
  * crash_ratio — crash over the same share for every eligible asset (1 = no safer than no advice)
  * dd       — the portfolio's worst peak-to-trough drop during the hold (median over days)
  * churn    — share of today's top N that wasn't in yesterday's (a hold list should settle)
  * blue     — share of the top N in the board's most expensive fifth
  * owner    — share of days at least one of the owner's named stores of value is in the top N
  * ret_pct / crash_pct — the top N's percentile among NULL_DRAWS random N-item lists from the same day's
               board (return: higher is better; crash share: lower is better). A skill-free list sits
               near 50 — the fair bar when a few big winners carry the basket's average
  * window_overlap — per league: the share of the top N ranks that carry the same name on the 24h
               board and the 14d board, averaged over days. window_same — the share of (day, pair of windows) with identical scores.
               A ranking that ignores the holding period has both at 1
  * chase    — share of the top N that JUMPED: their rise over the board's horizon, above the pace of
               their own trend before it, is in the board's top tenth. A steady climber is on the
               upswing (wanted); a jump is "just went up" (owner: don't over-weight it)

Replay limit: production takes an item's return from the hourly exchange card where one exists; the
hourly history doesn't reach back over a league, so the replay uses the daily closes production
falls back to. The metrics, value floor, drawdown cap and `hold_score` are production code, imported.

A --scorer is `file.py:function`, called as fn(entries, ctx) -> {item_id: score} (higher first).
`entries` = [(item_id, name, category, metrics, series)] for every asset production's gate admits
on day t; `series` = {age: (price_div, value_ex)} cut at age <= t. `ctx` = {"t", "hz", "hold", "past", "k", "league", "regime"}:
`hz` = `hold` = the days the player plans to hold (the window), `past` the earlier leagues [(league, per)] most recent first.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import sqlite3
import statistics
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="hold-backtest-"))   # never the app's dir
sys.path.insert(0, str(ROOT / "backend"))

from app import holdscore as H, leagueregime as LR, marketseries as M   # noqa: E402

# The topbar's choices (frontend/src/lib/horizonStore.js HORIZONS): label -> window hours.
SELECTIONS = {"24h": 24, "3d": 72, "7d": 168, "14d": 336}
TOP = 10
CRASH = -0.20
ENTRY_GAP = 2
# The owner's own examples of a good place to park currency (2026-09-14).
OWNER_PICKS = ("Hinekora's Lock", "Mirror of Kalandra", "Omen of Whittling", "Omen of Dextral Annulment")
TREND_DAYS = 14   # the pace a jump is measured against
PHASES = ((1, 7), (8, 14), (15, 30), (31, 60), (61, 999))

# What "Hold did its job" means for a player who holds the top 10, per horizon, averaged over every
# graded day of the league. Hold's job (owner): suggest good, SAFE places to park currency against
# inflation. So it must beat the no-advice basket, keep value most of the time, rarely crash, and
# be a list you can act on — not a different ten names every day.
THRESHOLDS = {
    "vs_board": ("min", 0.0),    # the top 10 out-earn holding everything eligible
    "beat": ("min", 0.55),       # ...on most days, not on one lucky streak
    "kept": ("min", 0.75),       # the portfolio holds its value in Divine on 3 days of 4
    "crash_ratio": ("max", 0.50),  # the picks crash (lose >20%) at most half as often as the basket
    "dd": ("min", -0.10),        # the portfolio's typical worst dip during the hold stays within 10%
    "churn": ("max", 0.30),      # at most 3 of the 10 names change day to day
    "owner": ("min", 0.50),      # one of the owner's stores of value is on the list most days
    "chase": ("max", 0.20),      # at most 2 of the 10 are the board's biggest recent jumps (owner:
                                 # Hold must not over-weight what just went up)
    # The window is the holding period, so it must move the board (owner, 2026-09-30). Per league:
    "window_overlap": ("max", 0.60),  # the 24h and 14d top 10s agree on at most 6 of 10 ranks (measured
                                      # 2026-09-30: 0.27–0.46 per league; a window-blind ranking is 1)
    "window_same": ("max", 0.0),      # no two windows ever show the same scores
}
WINDOW_KEYS = ("window_overlap", "window_same")   # graded per league (`window_verdict`), not per window
FAR_PAIR = ("24h", "14d")


_RAW: dict = {}   # raw (exalted) rows per league, for the regime detector


def load(db: str):
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    meta = M.read_meta(c)
    by: dict[str, list] = {}
    for lg, iid, day, close, vol in M.read_rows(c):
        by.setdefault(lg, []).append((iid, day, close, vol))
    return meta, by


def production(entries, ctx):
    """What ships: `holdscore.hold_rank`, the ranking /api/hold orders its board by."""
    return H.hold_rank([(e[0], e[4]) for e in entries], ctx["t"], ctx["k"], ctx["past"], ctx.get("regime"),
                       hold=ctx.get("hold"))


def by_price(entries, ctx):
    """Baseline: the most expensive eligible asset first — "just buy the blue chips"."""
    return {e[0]: math.log(e[4][ctx["t"]][0]) for e in entries}


BUILTIN = {"production": production, "price": by_price}


def load_scorer(spec: str):
    if spec in BUILTIN:
        return BUILTIN[spec]
    path, fn = spec.rsplit(":", 1)
    mod_spec = importlib.util.spec_from_file_location("hold_scorer", path)
    mod = importlib.util.module_from_spec(mod_spec)
    mod_spec.loader.exec_module(mod)
    return getattr(mod, fn)


def board_days(window_h: int) -> int:
    """The window's own board: the days the player plans to hold."""
    return window_h // 24


def path(series, t, days):
    """Smoothed prices from entry (t+GAP) to exit, or None when the league hasn't reached the exit
    day yet or the asset stopped trading around either end."""
    a0, a1 = t + ENTRY_GAP, t + ENTRY_GAP + days
    if max(series) < a1 or not H._nearest(series, a0) or not H._nearest(series, a1):
        return None
    pts = [H._smooth(series, a) for a in range(a0, a1 + 1) if H._nearest(series, a, tol=2)]
    return pts if pts[0] > 0 and pts[-1] > 0 else None


def board_for_day(per, meta, t, hz, scorer, past, k, hold=None, league=None, regime=None, scores_out=None):
    """The board Hold would have shown on league-day t: production metrics and gate, then `scorer`.
    `scores_out` (a dict) receives the scores the board was ordered by."""
    entries = []
    for iid, full in per.items():
        if t not in full:
            continue
        s = {a: v for a, v in full.items() if a <= t}
        m = H._metrics(s, hz)
        if m:
            name, cat = meta.get(iid, (str(iid), "?"))
            entries.append((iid, name, cat, m, s))
    cut = H.value_cut([e[3] for e in entries])
    elig = [e for e in entries if H.eligible(e[3], cut)]
    scores = scorer(elig, {"t": t, "hz": hz, "hold": hold or hz, "past": past, "k": k, "league": league,
                           "regime": regime})
    elig = [e for e in elig if scores.get(e[0]) is not None]
    if scores_out is not None:
        scores_out.update({e[0]: scores[e[0]] for e in elig})
    elig.sort(key=lambda e: -scores[e[0]])
    return elig


NULL_DRAWS = 2000


def random_null(rets, crashed, top, n=NULL_DRAWS, seed=0):
    """Where the top list sits among `n` random lists of the same size drawn from the same board:
    (return percentile — higher is better, crash-share percentile — higher means it crashed MORE).
    `rets`/`crashed` are per board item (simple return over the hold, lost > 20%); `top` = the
    list's indices into them. Ties count half. A skill-free list lands near 50 on both
    (Bessembinder 2018: a few big winners carry the average, so the mean is the wrong bar)."""
    import random
    k = len(top)
    if k == 0 or len(rets) <= k:
        return None, None
    r_top = statistics.fmean(rets[i] for i in top)
    c_top = sum(crashed[i] for i in top) / k
    rnd = random.Random(seed)
    idx = range(len(rets))
    below_r = below_c = 0.0
    for _ in range(n):
        pick = rnd.sample(idx, k)
        r = statistics.fmean(rets[i] for i in pick)
        c = sum(crashed[i] for i in pick) / k
        below_r += 1.0 if r < r_top else 0.5 if r == r_top else 0.0
        below_c += 1.0 if c < c_top else 0.5 if c == c_top else 0.0
    return 100 * below_r / n, 100 * below_c / n


def portfolio(paths):
    """Equal parts of each path, rebased to 1: (return, worst peak-to-trough drop)."""
    n = min(len(p) for p in paths)
    value = [statistics.fmean(p[i] / p[0] for p in paths) for i in range(n)]
    peak, dd = value[0], 0.0
    for v in value:
        peak = max(peak, v)
        dd = min(dd, v / peak - 1)
    return statistics.fmean(p[-1] / p[0] for p in paths) - 1, dd


def jump(series, t, hz, trend_days=TREND_DAYS):
    """How far the last `hz` days' rise outran the asset's own pace before them: log return over
    [t-hz, t] minus hz × the daily log slope over the `trend_days` before t-hz (smoothed prices).
    None without enough history for the trend."""
    a0 = t - hz
    pts = [(a, math.log(H._smooth(series, a))) for a in range(a0 - trend_days, a0 + 1) if a in series]
    if len(pts) < 4 or a0 not in series or t not in series:
        return None
    mx, my = statistics.fmean(a for a, _ in pts), statistics.fmean(y for _, y in pts)
    sxx = sum((a - mx) ** 2 for a, _ in pts)
    slope = sum((a - mx) * (y - my) for a, y in pts) / sxx if sxx else 0.0
    return math.log(H._smooth(series, t) / H._smooth(series, a0)) - hz * slope


BOARD_KEYS = ("churn", "blue", "owner", "chase")                 # what the list is: every day
OUTCOME_KEYS = ("ret", "vs_board", "beat", "kept", "crash", "ret_pct", "crash_pct")      # what holding it did: days whose hold has ended


def grade_day(board, per, t, days, top, prev_top, hz=None):
    """The day's grade, or None when the board is too thin to read (under 2×top eligible).
    The list's own properties are graded every day; the holding outcome only once the hold has
    ended (`graded` says which)."""
    if len(board) < 2 * top:
        return None
    prices = sorted(e[4][t][0] for e in board)
    q80 = prices[int(0.8 * (len(prices) - 1))]
    names = {e[1] for e in board[:top]}
    jumps = {e[0]: jump(e[4], t, hz or days) for e in board}
    ranked = sorted(v for v in jumps.values() if v is not None)
    hot = ranked[int(0.9 * (len(ranked) - 1))] if ranked else math.inf
    ids = {e[0] for e in board[:top]}
    g = {"t": t, "eligible": len(board), "graded": False,
         "churn": None if prev_top is None else len(ids - prev_top) / len(ids),
         "blue": sum(e[4][t][0] >= q80 for e in board[:top]) / top,
         "owner": float(any(n in names for n in OWNER_PICKS)),
         "chase": sum((jumps[e[0]] if jumps[e[0]] is not None else -math.inf) >= hot for e in board[:top]) / top,
         "top": [e[1] for e in board[:top]],
         **{k: None for k in OUTCOME_KEYS}, "dd": None, "board_crash": None}
    paths = {e[0]: path(per[e[0]], t, days) for e in board}
    live = [e for e in board if paths[e[0]]]
    picks = [e for e in board[:top] if paths[e[0]]]
    if len(live) < 2 * top or len(picks) < top // 2:
        return g
    ret, dd = portfolio([paths[e[0]] for e in picks])
    base, _ = portfolio([paths[e[0]] for e in live])
    crash = lambda es: sum(paths[e[0]][-1] / paths[e[0]][0] - 1 < CRASH for e in es) / len(es)
    g.update(graded=True, ret=ret, vs_board=ret - base, beat=float(ret > base), kept=float(ret >= 0), dd=dd,
             crash=crash(picks), board_crash=crash(live))
    rets = [paths[e[0]][-1] / paths[e[0]][0] - 1 for e in live]
    pos = {e[0]: i for i, e in enumerate(live)}
    g["ret_pct"], g["crash_pct"] = random_null(rets, [r < CRASH for r in rets],
                                               [pos[e[0]] for e in picks], seed=t)
    return g


def summarize(days):
    graded = [d for d in days if d["graded"]]
    out = {"days": len(days), "graded": len(graded)}
    for k in BOARD_KEYS + OUTCOME_KEYS:
        v = [d[k] for d in (days if k in BOARD_KEYS else graded) if d[k] is not None]
        out[k] = statistics.fmean(v) if v else None
    out["dd"] = statistics.median(d["dd"] for d in graded) if graded else None
    base = statistics.fmean(d["board_crash"] for d in graded) if graded else 0
    out["crash_ratio"] = (out["crash"] / base if base else 0.0 if out["crash"] == 0 else None) if graded else None
    return out


def verdict(summary) -> list[str]:
    """The thresholds `summary` misses, as readable lines ([] = pass)."""
    miss = []
    for k, (way, lim) in THRESHOLDS.items():
        if k in WINDOW_KEYS:
            continue
        v = summary.get(k)
        if v is None or (v < lim if way == "min" else v > lim):
            miss.append(f"{k} {'—' if v is None else f'{v:+.3f}'} ({'≥' if way == 'min' else '≤'} {lim:+.2f})")
    return miss


def window_grade(boards, top=TOP):
    """Does the window move the board? `boards` = {label: {day: (top ids, {item_id: score})}}.
    window_overlap: the mean, over days both exist, of the share of FAR_PAIR's top ranks with the same name.
    window_same: the share of (day, pair of windows) whose scores are identical. None when unmeasured."""
    a, b = (boards.get(x, {}) for x in FAR_PAIR)
    over = [sum(x == y for x, y in zip(a[t][0], b[t][0])) / top for t in a if t in b]
    labels = list(boards)
    pairs = [(x, y, t) for i, x in enumerate(labels) for y in labels[i + 1:] for t in boards[x] if t in boards[y]]
    same = [boards[x][t][1] == boards[y][t][1] for x, y, t in pairs]
    return {"window_overlap": statistics.fmean(over) if over else None,
            "window_same": sum(same) / len(same) if same else None}


def window_verdict(w) -> list[str]:
    """The window thresholds `w` (a `window_grade`) misses, as readable lines ([] = pass)."""
    miss = []
    for k in WINDOW_KEYS:
        way, lim = THRESHOLDS[k]
        v = w.get(k)
        if v is None or (v < lim if way == "min" else v > lim):
            miss.append(f"{k} {'—' if v is None else f'{v:.2f}'} ({'≥' if way == 'min' else '≤'} {lim:.2f})")
    return miss


def phase_of(t):
    return next(f"{lo}-{hi}" if hi < 999 else f"{lo}+" for lo, hi in PHASES if lo <= t <= hi)


_W: dict = {}   # per-process state for the pool workers (loaded once per process)


def _init(db, numeraire, scorer_spec, k, top):
    meta, built, day0, num_id = build(db, numeraire)
    _W.update(meta=meta, built=built, day0=day0, num_id=num_id, scorer=load_scorer(scorer_spec), k=k, top=top)


def _league_ctx(league):
    """(per, past) for a league, memoized per process."""
    key = ("ctx", league)
    if key not in _W:
        built, day0 = _W["built"], _W["day0"]
        per = dict(built[league][0])
        per.pop(_W["num_id"], None)
        past = sorted(((lg, built[lg][0]) for lg in day0 if day0[lg] < day0[league]),
                      key=lambda x: day0[x[0]], reverse=True)
        _W[key] = (per, past, regime_for(_RAW, league))
    return _W[key]


def _day(task):
    """One (league, horizon, day): the board and its grade (churn is filled in by the caller,
    which sees the days in order)."""
    league, hz, hold, t = task
    per, past, regime = _league_ctx(league)
    top = _W["top"]
    scores: dict = {}
    board = board_for_day(per, _W["meta"], t, hz, _W["scorer"], past, _W["k"], hold, league, regime, scores)
    g = grade_day(board, per, t, hold, top, None, hz) if board else None
    # Churn compares against a board worth reading: one with enough eligible assets to be graded
    # itself (a league's first days have a handful, and every name "changes" then).
    ids = [e[0] for e in board[:top]] if len(board) >= 2 * top else None
    return g, ids, scores


def grade_leagues(db, leagues, scorer_spec="production", numeraire="divine", k=H.CAUTION_K, top=TOP,
                  selections=SELECTIONS, workers=None):
    """{league: {selection: {"days": [...], "all": summary, "by_phase": {...}}, "window": window_grade}}
    ("window" only when every window is graded). Every (league, window, day) board is independent,
    so they run across processes."""
    from concurrent.futures import ProcessPoolExecutor
    _init(db, numeraire, scorer_spec, k, top)          # the parent needs the league calendars too
    tasks = []
    for league in leagues:
        per, _p, _r = _league_ctx(league)
        last = max(max(s) for s in per.values())
        for wh in selections.values():
            tasks += [(league, board_days(wh), wh // 24, t) for t in range(1, last + 1)]
    workers = workers or os.cpu_count() or 1
    if workers > 1:
        with ProcessPoolExecutor(workers, initializer=_init, initargs=(db, numeraire, scorer_spec, k, top)) as ex:
            results = list(ex.map(_day, tasks, chunksize=4))
    else:
        results = [_day(x) for x in tasks]
    by = dict(zip(tasks, results))
    out = {}
    for league in leagues:
        per, _p, _r = _league_ctx(league)
        last = max(max(s) for s in per.values())
        out[league] = {}
        boards: dict = {}
        for label, wh in selections.items():
            hz, hold = board_days(wh), wh // 24
            days, prev = [], None
            for t in range(1, last + 1):
                g, ids, scores = by[(league, hz, hold, t)]
                if ids:
                    boards.setdefault(label, {})[t] = (ids, scores)
                if g:
                    g["churn"] = None if prev is None else len(set(ids) - prev) / len(ids)
                    days.append(g)
                prev = set(ids) if ids else None
            phases = {}
            for d in days:
                phases.setdefault(phase_of(d["t"]), []).append(d)
            out[league][label] = {"board_hz": hz, "hold_days": hold, "days": days,
                                  "all": summarize(days) if days else None,
                                  "by_phase": {p: summarize(ds) for p, ds in phases.items()}}
        if all(x in selections for x in FAR_PAIR):
            out[league]["window"] = window_grade(boards, top)
    return out


def regime_for(by, league):
    """The league's market-state regime (leagueregime), from its raw exalted rows."""
    per = LR.from_rows(by.get(league, []))
    return lambda t: LR.regime(per, t)


def build(db, numeraire="divine"):
    meta, by = load(db)
    _RAW.update(by)
    num_id = M.ANCHORS[numeraire].item_id
    built = {lg: H._build_league(rws, num_id) for lg, rws in by.items()}
    day0 = {lg: d0 for lg, (_p, d0) in built.items() if d0}
    return meta, built, day0, num_id


def current_league(day0):
    return max(day0, key=day0.get)


def _row(label, s, miss=None):
    f = lambda v, p=True: "–" if v is None else (f"{v * 100:+.1f}" if p == "s" else f"{v * 100:.0f}%")
    tail = "" if miss is None else ("  PASS" if not miss else "  FAIL: " + "; ".join(miss))
    return (f"{label:>7} {str(s['days']) + '/' + str(s['graded']):>7} {f(s['ret'], 's'):>7} {f(s['vs_board'], 's'):>8} {f(s['beat']):>5} {f(s['kept']):>5} "
            f"{f(s['crash']):>6} {'–' if s['crash_ratio'] is None else f"{s['crash_ratio']:.2f}":>6} {f(s['dd'], 's'):>6} {f(s['churn']):>6} {f(s['blue']):>5} {f(s['owner']):>6} {f(s['chase']):>6} {'–' if s['ret_pct'] is None else f"{s['ret_pct']:.0f}":>5} {'–' if s['crash_pct'] is None else f"{s['crash_pct']:.0f}":>5}{tail}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", required=True, help="a market.sqlite (opened read-only; a copy is safest)")
    ap.add_argument("--league", help="a league name, or 'all'; default: the league that started last")
    ap.add_argument("--scorer", default="production", help="production | price | file.py:function")
    ap.add_argument("--numeraire", default="divine", choices=list(H.NUMERAIRES))
    ap.add_argument("--k", type=float, default=H.CAUTION_K)
    ap.add_argument("--top", type=int, default=TOP)
    ap.add_argument("--horizon", choices=list(SELECTIONS), help="only this horizon")
    ap.add_argument("--show-day", type=int, help="print that day's board and what each pick did")
    ap.add_argument("--json", help="write every board and grade here")
    ap.add_argument("--workers", type=int, help="processes (default: every CPU; 1 = serial)")
    a = ap.parse_args()

    meta, built, day0, num_id = build(a.db, a.numeraire)
    scorer = load_scorer(a.scorer)
    sels = {a.horizon: SELECTIONS[a.horizon]} if a.horizon else SELECTIONS

    if a.show_day is not None:
        league = a.league or current_league(day0)
        label = a.horizon or "7d"
        hz, hold = board_days(SELECTIONS[label]), SELECTIONS[label] // 24
        per = dict(built[league][0]); per.pop(num_id, None)
        past = sorted(((lg, built[lg][0]) for lg in day0 if day0[lg] < day0[league]), key=lambda x: day0[x[0]], reverse=True)
        board = board_for_day(per, meta, a.show_day, hz, scorer, past, a.k, hold, league,
                              regime_for(_RAW, league))
        print(f"{league} · day {a.show_day} · {label} (board {hz}d, hold {hold}d) · {a.scorer} · {len(board)} eligible")
        for i, e in enumerate(board[:max(a.top, 25)], 1):
            p = path(per[e[0]], a.show_day, hold)
            out = "pending" if not p else f"held {(p[-1] / p[0] - 1) * 100:+6.1f}%"
            print(f"{i:3} {e[1][:34]:34} {e[2][:12]:12} {e[4][a.show_day][0]:9.2f} div  past {e[3]['ret'] * 100:+7.1f}%  "
                  f"mdd {e[3]['mdd'] * 100:6.1f}%  {out}")
        return 0

    leagues = sorted(day0, key=day0.get) if a.league == "all" else [a.league or current_league(day0)]
    report, failed = {"scorer": a.scorer, "top": a.top, "thresholds": THRESHOLDS, "leagues": {}}, False
    head = f"{'':>7} {'days/out':>7} {'ret':>7} {'vs board':>8} {'beat':>5} {'kept':>5} {'crash':>6} {'×bd':>6} {'dd':>6} {'churn':>6} {'blue':>5} {'owner':>6} {'chase':>6} {'r%ile':>5} {'c%ile':>5}"
    graded = grade_leagues(a.db, leagues, a.scorer, a.numeraire, a.k, a.top, sels, a.workers)
    for league in leagues:
        res = graded[league]
        print(f"\n═══ {league} · scorer {a.scorer} · hold the top {a.top} · prices in {a.numeraire}")
        win = res.pop("window", None)
        report["leagues"][league] = {**res, "window": win}
        if win:
            miss = window_verdict(win)
            failed |= bool(miss)
            f2 = lambda v: "–" if v is None else f"{v:.2f}"
            print(f"── windows: 24h vs 14d top {a.top}, same name at the same rank {f2(win['window_overlap'])} · "
                  f"identical scores {f2(win['window_same'])} of window pairs"
                  f"  {'PASS' if not miss else 'FAIL: ' + '; '.join(miss)}")
        for label, r in res.items():
            if not r["all"]:
                print(f"── {label}: no graded days yet")
                continue
            print(f"── {label} (board {r['board_hz']}d, held {r['hold_days']}d)\n{head}")
            for p, s in r["by_phase"].items():
                print(_row(p, s))
            miss = verdict(r["all"])
            failed |= bool(miss)
            print(_row("all", r["all"], miss))
    if a.json:
        Path(a.json).write_text(json.dumps(report, indent=1, default=str))
    print("\nverdict:", "FAIL" if failed else "PASS")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
