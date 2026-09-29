#!/usr/bin/env python3
"""The measurements behind Hold's crash conclusions (docs/hold-research.md "Loop 5 — crashes"), so a new
league can re-test them instead of taking them on trust. Read-only, like ops/hold-backtest.py.

    python3 ops/hold-diagnostics.py --db market.sqlite signals          # does a warning sign flag crashes, per league?
    python3 ops/hold-diagnostics.py --db market.sqlite signals --phase settled --hold 14
    python3 ops/hold-diagnostics.py --db market.sqlite topten           # ...within Hold's own top 10?
    python3 ops/hold-diagnostics.py --db market.sqlite floor            # the best crash percentile any list could get
    python3 ops/hold-diagnostics.py --db market.sqlite noise            # how much the crash-cell count moves by chance

A crash = the smoothed price falls below 80% of entry (t+2) at some point in the hold. AUC > 0.5 means
the sign flags crashes; a sign worth building on agrees in >= 4 of 5 leagues. `floor` and `noise` run the
production backtest first (or read its --json via --report).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import random
import statistics
import sys
from pathlib import Path

_spec = importlib.util.spec_from_file_location("hold_backtest", Path(__file__).with_name("hold-backtest.py"))
bt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bt)
H = bt.H


def auc(pos, neg):
    """Probability a random crash scores above a random non-crash (ties half). None without both."""
    if not pos or not neg:
        return None
    allv = sorted([(v, 1) for v in pos] + [(v, 0) for v in neg])
    ranks, i = [0.0] * len(allv), 0
    while i < len(allv):
        j = i
        while j + 1 < len(allv) and allv[j + 1][0] == allv[i][0]:
            j += 1
        for k in range(i, j + 1):
            ranks[k] = (i + j) / 2 + 1
        i = j + 1
    rp = sum(r for r, (_v, y) in zip(ranks, allv) if y)
    return (rp - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))


def _smoothed_returns(s, t, days=14):
    sm = {a: H._smooth(s, a) for a in s if t - days - 2 <= a <= t}
    return [math.log(sm[a] / sm[a - 1]) for a in range(t - days + 1, t + 1)
            if a in sm and a - 1 in sm and sm[a] > 0 and sm[a - 1] > 0]


def warning_signs(series, t) -> dict:
    """The candidate crash signs measured in Loop 5 (higher = more crash-prone if the sign is right)."""
    s = {a: v for a, v in series.items() if a <= t}
    r = _smoothed_returns(s, t)
    out = {"downside_vol": math.sqrt(statistics.fmean(min(x, 0) ** 2 for x in r)) if len(r) >= 7 else None,
           "duvol": H._duvol(series, t)}
    def lr(a, b):
        return math.log(H._smooth(s, b) / H._smooth(s, a)) if a in s and b in s and H._smooth(s, a) > 0 else None
    out["runup_14d"] = lr(t - 14, t)
    base = min((a for a in s if a >= 3), default=None)
    out["gain_since_day3"] = lr(base, t) if base is not None and base < t else None
    return out


def _boards(db, only_top=None, phase=None, hold=7):
    """Yield (league, t, [(entry, crashed)]) walk-forward over every league."""
    meta, built, day0, num = bt.build(db)
    for lg in sorted(day0, key=day0.get):
        per = dict(built[lg][0]); per.pop(num, None)
        past = sorted(((x, built[x][0]) for x in day0 if day0[x] < day0[lg]), key=lambda p: day0[p[0]], reverse=True)
        reg = bt.regime_for(bt._RAW, lg)
        last = max(max(s) for s in per.values())
        scorer = bt.production if only_top else (lambda e, c: {x[0]: 0 for x in e})
        for t in range(4, last - hold - 2):
            early = reg(t).get("early", 1.0)
            if phase == "early" and early < 0.5 or phase == "settled" and early >= 0.5:
                continue
            board = bt.board_for_day(per, meta, t, 7, scorer, past, 2.0, hold, lg, reg)
            if len(board) < 20:
                continue
            rows = []
            for e in (board[:only_top] if only_top else board):
                p = bt.path(per[e[0]], t, hold)
                if p:
                    rows.append((e, min(p) / p[0] < 0.8))
            yield lg, t, rows


def cmd_signals(a, only_top=None):
    res: dict = {}
    for lg, t, rows in _boards(a.db, only_top, a.phase, a.hold):
        for e, crashed in rows:
            for k, v in warning_signs(e[4], t).items():
                if v is not None:
                    res.setdefault(k, {}).setdefault(lg, ([], []))[0 if crashed else 1].append(v)
    where = f"within Hold's top {only_top}" if only_top else "across the eligible board"
    print(f"crash within {a.hold}d, {where}, phase={a.phase or 'all'} — AUC (crashes/obs) per league")
    for k, by in res.items():
        cells = []
        for lg, (pos, neg) in by.items():
            v = auc(pos, neg)
            cells.append((lg, v, len(pos), len(pos) + len(neg)))
        agree = sum(1 for _l, v, c, _n in cells if v is not None and c >= 20 and v > 0.5)
        tot = sum(1 for _l, v, c, _n in cells if v is not None and c >= 20)
        print(f"  {k:16} " + "  ".join(f"{l[:8]} {v:.2f}({c}/{n})" for l, v, c, n in cells if v is not None)
              + f"   agree {agree}/{tot}")


def _report(a):
    if a.report:
        return json.load(open(a.report))["leagues"]
    meta, built, day0, _num = bt.build(a.db)
    return bt.grade_leagues(a.db, sorted(day0, key=day0.get), workers=a.workers)


def p_zero(n, crashes, k=10):
    """Chance a random k-item list from n items (crashes of them crashed) has no crash."""
    return 0.0 if n - crashes < k else math.comb(n - crashes, k) / math.comb(n, k)


def cmd_floor(a):
    """Best possible crash percentile per cell: a never-crashing list scores 50 × P(random list has zero
    crashes) each day (ties count half). A cell above 40 here is out of reach for any ranking."""
    rep = _report(a)
    meta, built, day0, num = bt.build(a.db)
    for lg in rep:
        per = dict(built[lg][0]); per.pop(num, None)
        past = sorted(((x, built[x][0]) for x in day0 if day0[x] < day0[lg]), key=lambda p: day0[p[0]], reverse=True)
        for label, wh in bt.SELECTIONS.items():
            graded = [d["t"] for d in rep[lg][label]["days"] if d["graded"]]
            vals = []
            for t in graded:
                board = bt.board_for_day(per, meta, t, bt.board_days(wh), lambda e, c: {x[0]: 0 for x in e}, past, 2.0)
                live = [p for p in (bt.path(per[e[0]], t, wh // 24) for e in board) if p]
                vals.append(50 * p_zero(len(live), sum(1 for p in live if p[-1] / p[0] - 1 < bt.CRASH)))
            if vals:
                f = statistics.fmean(vals)
                now = rep[lg][label]["all"]["crash_pct"]
                print(f"  {lg[:16]:16} {label:4} best possible {f:5.1f}   Hold {now:5.1f}   {'reachable' if f <= 40 else 'out of reach'}")


def block_bootstrap_counts(cells, n=2000, block=7, line=40.0, seed=1):
    """Resample each cell's daily crash percentiles in `block`-day blocks; count cells at or under `line`."""
    rnd, counts = random.Random(seed), []
    for _ in range(n):
        c = 0
        for ds in cells:
            blocks = [ds[i:i + block] for i in range(0, len(ds), block)]
            samp = [x for _b in blocks for x in rnd.choice(blocks)]
            c += statistics.fmean(samp) <= line
        counts.append(c)
    return sorted(counts)


def cmd_noise(a):
    rep = _report(a)
    cells = [[d["crash_pct"] for d in rep[lg][hz]["days"] if d["graded"] and d["crash_pct"] is not None]
             for lg in rep for hz in ("3d", "7d", "14d")]
    cells = [c for c in cells if c]
    counts = block_bootstrap_counts(cells)
    point = sum(statistics.fmean(c) <= 40 for c in cells)
    n = len(counts)
    print(f"crash cells <= 40 (3d/7d/14d): {point}/{len(cells)}; 7-day-block bootstrap 5/50/95%: "
          f"{counts[n // 20]} / {counts[n // 2]} / {counts[19 * n // 20]}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", required=True)
    ap.add_argument("--report", help="a hold-backtest --league all --json report (floor/noise); else it is run")
    ap.add_argument("--workers", type=int)
    ap.add_argument("--hold", type=int, default=7)
    ap.add_argument("--phase", choices=("early", "settled"))
    ap.add_argument("what", choices=("signals", "topten", "floor", "noise"))
    a = ap.parse_args()
    {"signals": cmd_signals, "topten": lambda x: cmd_signals(x, only_top=10),
     "floor": cmd_floor, "noise": cmd_noise}[a.what](a)


if __name__ == "__main__":
    main()
