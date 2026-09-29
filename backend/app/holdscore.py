"""'What to hold' leaderboard: good, safe places to park currency against inflation, with a
cross-league forward-return prediction. Research, diagnosis and sources: docs/hold-research.md;
smoke test: ops/hold-backtest.py.

- Everything is priced in DIVINE (not the inflating Exalted base) — that's what
  "held value" means to a player.
- Ranking = `hold_rank`: value kept since the league's prices settled and a steady climb (one
  signal), a smooth path, a high price, and the item's record in earlier leagues, each ranked on the
  day and averaged; the list settles over a few days.
  The horizon sets the return column and the forecast, not the order.
- Prediction = the league-phase analog: at the current league's day N, average each
  asset's forward Δ-day return from the days around N (±PRED_WINDOW) across PAST
  leagues (recency-weighted), with the dispersion as a confidence band.

Pure Python (stdlib only) — the data is a few hundred items × ~150 days.
"""
from __future__ import annotations

import math
import statistics

from . import analytics, cache, db, devtelemetry, leagueregime, marketseries
from .marketseries import league_age as _age
from .settings import get_settings

DIVINE_ID = marketseries.DIVINE_ID
# Numeraires to price "held value" against. Divine = liquid default; Mirror & Lock
# (Hinekora's Lock) are the hardest anchors but trade thinly, so coverage is lower.
NUMERAIRES = {k: (a.item_id, a.name) for k, a in marketseries.ANCHORS.items() if k != "chaos"}
HORIZON_DAYS = {"1d": 1, "3d": 3, "7d": 7}   # fast-league day horizons (daily poe2scout data)
MAX_HORIZON_DAYS = 7                          # hold scores are tuned to a week; longer windows clamp


def horizon_for(window_h: int | None = None, horizon: str | None = None) -> str:
    """The app-wide window (hours) → Hold's day-horizon string, clamped to MAX_HORIZON_DAYS.
    `horizon` (1d|3d|7d) is the legacy spelling and wins when given."""
    if horizon in HORIZON_DAYS:
        return horizon
    if window_h:
        days = min(MAX_HORIZON_DAYS, marketseries.win_days(window_h))
        return max((h for h, d in HORIZON_DAYS.items() if d <= days), key=HORIZON_DAYS.get)
    return "3d"
SHRINK_K = 8            # data-count shrinkage: confidence = n/(n+K)
# --- eligibility (measured 2026-09-20; see docs/bugs/2026-09-20-hold-ranks-against-its-own-forecast.md)
CAUTION_K = 2.0         # the Caution dial's default. The dip's weight in `hold_rank` is k / CAUTION_K,
                        # so the default weighs it like every other signal.
# k is a USER DIAL (owner directive 2026-09-20): a CAUTION slider on the Hold page, persisted as the
# `hold_caution` setting. 0 = the dip doesn't count; higher = favour the steadier asset. The rank
# is monotone in every signal at every position, so the dial changes preference, never sense.
CAUTION_RANGE = (0.0, 6.0)
MDD_CAP = -0.40         # exclude anything that fell worse than this. Tightest cap that still
                        # spares Mirror/Hinekora (at -35% they drop out 25%/27% of early days).
MIN_DAYS = 4            # a score needs at least this many days behind it
VALUE_PERCENTILE = 0.50  # keep the top half of the DAY's traded value — RELATIVE, because the
                        # value scale shifts ~14x between leagues and an absolute floor is either
                        # unreachable or arbitrary. A relative cut can never empty the board.
VALUE_FLOOR = 30_000_000.0   # median daily traded VALUE (exalted) for full liquidity confidence.
# The board answers "what's a good place to park currency to beat inflation" — so a hold must
# be liquid *in value* (you can park real wealth), which is why the floor is on exalted/day,
# not raw units: a Mirror trades few units but enormous value; an essence the reverse.
GAMMA = 0.65            # recency weight for past leagues (most recent = weight 1)
MIN_PRED_LEAGUES = 2
PRED_WINDOW = 5         # the board's forecast reads start days N±5 in each past league, not day N
                        # alone. Early-league 3d IC: +0.263 at ±0 -> +0.317 at ±5 (see the handoff).
# The forecast is SHOWN as arrows (direction + 1-3 strength), never a %: only its ordering was ever
# validated, and its ± is 4-22x too narrow. Past ARROW_LAST_DAY the arrows stop telling the truth
# (3d: a down arrow fell 16% of the time vs 30% chance), so the board drops the column.
ARROW_LAST_DAY = 14
ARROW_DASH_SHARE = 0.25  # the weakest quarter of the day's forecasts shows a dash, not an arrow
ARROW_HORIZONS = ("3d", "7d")  # 1d red arrows are a coin flip (fell 46% vs 48% chance), so the 1d
                               # column keeps its place but shows only dashes

_cache: dict = {}            # leaderboard results
_ctx_cache: dict = {}        # build_context per (league setting, numeraire)
_TTL = 600
_CTX_TTL = 300


def invalidate() -> None:
    cache.clear(_cache)
    cache.clear(_ctx_cache)


def _build_league(rows, num_id) -> tuple[dict[int, dict[int, tuple[float, float]]], str | None]:
    """rows: (item_id, day, close_ex, volume) for ONE league. Returns
    {item_id: {age: (price_in_numeraire, volume)}} and the league's day-0 date. Days on
    which the numeraire didn't trade are dropped (thin anchors → sparser series)."""
    num = {day: close for iid, day, close, _v in rows if iid == num_id and close}
    days = sorted({r[1] for r in rows})
    if not days:
        return {}, None
    day0 = days[0]
    per: dict[int, dict[int, tuple[float, float]]] = {}
    for iid, day, close, vol in rows:
        n = num.get(day)
        if n and close:
            # (price in numeraire, daily traded value in exalted). Value is numeraire-
            # independent so the liquidity floor holds across the vs-Divine/Mirror/Lock toggles.
            per.setdefault(iid, {})[_age(day, day0)] = (close / n, (vol or 0) * close)
    return per, day0


def _nearest(series: dict[int, tuple[float, float]], target: int, tol: int = 2):
    if target in series:
        return series[target]
    best, bd = None, tol + 1
    for a, v in series.items():
        if abs(a - target) < bd:
            bd, best = abs(a - target), v
    return best if bd <= tol else None


def _smooth(series: dict[int, tuple[float, float]], target: int) -> float:
    """Median price over the target day and its immediate neighbours — robust to the
    single-day outliers that thin poe2scout daily closes are riddled with (a lone spike
    otherwise turns a flat asset into a fake +3000% mover)."""
    vals = [series[a][0] for a in (target - 1, target, target + 1) if a in series]
    if not vals:
        near = min(series, key=lambda a: abs(a - target))
        vals = [series[near][0]]
    return statistics.median(vals)


def _metrics(series: dict[int, tuple[float, float]], hz_days: int):
    ages = sorted(series)
    if len(ages) < 2:
        return None
    last_age = ages[-1]
    last = _smooth(series, last_age)
    # base = price hz_days ago; if the league is younger than the horizon, fall back
    # to the earliest price (so a young league still shows on the 7d board).
    cand = [a for a in ages if a <= last_age - hz_days]
    base_age = cand[-1] if cand else ages[0]
    base = _smooth(series, base_age)
    if not base:
        return None
    prices = [series[a][0] for a in ages]
    peak, mdd = prices[0], 0.0
    for p in prices:
        peak = max(peak, p)
        mdd = min(mdd, p / peak - 1)
    valvol = statistics.median(series[a][1] for a in ages)   # daily traded value, exalted
    depth = len(ages) / (len(ages) + SHRINK_K)               # enough data points?
    liq = min(1.0, valvol / VALUE_FLOOR)                      # can you park real wealth here?
    stab = max(0.15, 1 + mdd)                                 # a good park doesn't crash
    return {"ret": last / base - 1, "mdd": mdd, "n": len(ages), "valvol": valvol,
            "conf": depth * liq, "stab": stab, "cur_age": last_age}


def clamp_k(v) -> float:
    """The dial arrives from a slider over HTTP, so treat it as hostile: anything unreadable
    falls back to the default and anything out of range clamps into it."""
    try:
        k = float(v)
    except (TypeError, ValueError):
        return CAUTION_K
    if math.isnan(k):
        return CAUTION_K
    lo, hi = CAUTION_RANGE
    return min(max(k, lo), hi)


# --- the ranking (2026-09-28; docs/hold-research.md, smoke test ops/hold-backtest.py) -------------
# Hold is a store-of-value list: what kept its value since the league's prices settled and climbs
# steadily (one signal: kept + trend, half each), didn't dip, is expensive, and held its value in
# earlier leagues. Each signal is ranked against the day's board and the ranks are averaged with
# fixed weights — four past leagues cannot tune weights. Chosen by an arena of four designs
# (docs/hold-research.md "Arena"); graded by ops/hold-backtest.py on every league.
DISCOVERY_DAY = 7   # a league's opening week is price discovery; kept value is measured from here
SKIP_DAYS = 3       # kept value stops SKIP_DAYS ago, so a jump in the last days doesn't count
TREND_DAYS = 14     # the climb is read over the TREND_DAYS before the last TREND_SKIP days
TREND_SKIP = 2
SETTLE_DAYS = 3     # an asset's score is its mean over the last SETTLE_DAYS days: the list settles
# The record: in earlier leagues, the share of RECORD_HOLD-day holds (started from DISCOVERY_DAY) that
# kept RECORD_KEEP of their value. An item's place in PoE2's economy — how it drops, whether crafting
# consumes it — repeats every league, so its record stands in for sink and supply data we don't have.
# Neither number is fitted: 14 days is the longest hold the app offers, −20% the smoke test's crash
# line. Only league-days <= RECORD_TO count: a past league's first two months are over before the next
# league starts, so a replayed day never reads the future, and the record never changes once read.
RECORD_HOLD = 14
RECORD_KEEP = 0.80
RECORD_TO = 60
RECORD_MIN_WINDOWS = 20   # about three weeks of one league
_record_cache: dict = {}


def _signals(series: dict[int, tuple[float, float]], t: int) -> dict | None:
    """kept / dip / trend / price for one asset as of league-day t, on smoothed prices (`_smooth`:
    a thin asset's single odd close is neither a crash nor a gain)."""
    s = {a: v for a, v in series.items() if a <= t}
    if len(s) < 2:
        return None
    ages = sorted(s)
    sm = {a: _smooth(s, a) for a in ages}
    if min(sm.values()) <= 0:
        return None
    base = next((a for a in ages if a >= DISCOVERY_DAY and t - a >= SKIP_DAYS), ages[0])
    end = next((a for a in reversed(ages) if a <= t - SKIP_DAYS), None)
    # None = not measurable yet (no settled span before the skip); it is left out, never a 0
    kept = math.log(sm[end] / sm[base]) if end is not None and end > base else None
    peak, dip = None, 0.0
    for a in ages:
        if a >= min(base, DISCOVERY_DAY):
            peak = sm[a] if peak is None else max(peak, sm[a])
            dip = min(dip, sm[a] / peak - 1)
    win = [a for a in ages if t - TREND_DAYS - TREND_SKIP <= a <= t - TREND_SKIP]
    trend = None
    if len(win) >= 5:
        ys = [math.log(sm[a]) for a in win]
        mx, my = statistics.fmean(win), statistics.fmean(ys)
        sxx = sum((x - mx) ** 2 for x in win)
        sxy = sum((x - mx) * (y - my) for x, y in zip(win, ys))
        syy = sum((y - my) ** 2 for y in ys)
        trend = (sxy / sxx) * (sxy * sxy / (sxx * syy)) if sxx and syy else 0.0
    # steadiness of the settled climb: mean/sd of daily moves (Sharpe-style) and net/total movement
    # (efficiency ratio), both from DISCOVERY_DAY to SKIP_DAYS ago
    moves = [math.log(sm[b] / sm[a]) for a, b in zip(ages, ages[1:])
             if b - a == 1 and DISCOVERY_DAY <= a and b <= t - SKIP_DAYS]
    sd = statistics.pstdev(moves) if len(moves) >= 4 else 0.0
    steady = (statistics.fmean(moves) / sd if sd > 0 else 0.0) if len(moves) >= 4 else None
    total = sum(abs(x) for x in moves)
    eff = sum(moves) / total if len(moves) >= 5 and total > 0 else None
    # is trading in it picking up? traded value this week vs the week before
    now = [s[a][1] for a in range(t - 6, t + 1) if a in s]
    before = [s[a][1] for a in range(t - 13, t - 6) if a in s]
    vol_trend = math.log((sum(now) + 1) / (sum(before) + 1)) if len(now) >= 3 and len(before) >= 3 else None
    return {"kept": kept, "dip": dip, "trend": trend, "price": math.log(s[ages[-1]][0]),
            "steady": steady, "eff": eff, "vol_trend": vol_trend}


def _pct_ranks(vals: list[float]) -> list[float]:
    """Each value's rank on the day, 0 (worst) … 1 (best); ties share the mean rank."""
    n = len(vals)
    order = sorted(range(n), key=lambda i: vals[i])
    out = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and vals[order[j + 1]] == vals[order[i]]:
            j += 1
        for p in range(i, j + 1):
            out[order[p]] = ((i + j) / 2) / max(1, n - 1)
        i = j + 1
    return out


def _record(iid, past) -> float | None:
    """The item's record in `past` [(league, per)]: the share of RECORD_HOLD-day holds, started from
    DISCOVERY_DAY and ending by RECORD_TO, that kept RECORD_KEEP of their value (smoothed prices).
    None with fewer than RECORD_MIN_WINDOWS holds."""
    ok = n = 0
    for lg, per in past:
        full = per.get(iid)
        if not full:
            continue
        ps = {a: v for a, v in full.items() if a <= RECORD_TO + 1}
        key = (lg, iid, len(ps), max(ps, default=-1), ps.get(max(ps, default=-1)))
        if key not in _record_cache:
            sm = {a: _smooth(ps, a) for a in ps}
            wins = [(sm[a], sm[a + RECORD_HOLD]) for a in sm
                    if a >= DISCOVERY_DAY and a + RECORD_HOLD <= RECORD_TO and a + RECORD_HOLD in sm and sm[a] > 0]
            _record_cache[key] = (sum(p1 >= RECORD_KEEP * p0 for p0, p1 in wins), len(wins))
        o, w = _record_cache[key]
        ok, n = ok + o, n + w
    return ok / n if n >= RECORD_MIN_WINDOWS else None


# Each league regime (leagueregime: EARLY price discovery, MID settled, LATE winding down) ranks on
# the signals measured to work in it across the leagues (docs/hold-research.md "Regimes"); each set's
# weights sum to its own scale and the day's weights are the regime memberships' blend. Early is the
# 2026-09-28 ranking; mid drops price (it predicts LOWER returns once prices settle, 0/4 leagues) for
# signals positive in 4/4; late keeps what protects when momentum reverses.
REGIME_SETS = {
    "early": {"kept": 0.5, "trend": 0.5, "dip": 1.0, "price": 1.0, "record": 1.0},
    "mid": {"kept": 0.5, "trend": 0.5, "haven": 1.0, "vol_trend": 1.0, "steady": 1.0, "dip": 1.0,
            "record": 1.0},
    "late": {"price": 1.0, "haven": 1.0, "eff": 1.0, "dip": 1.0},
}
_EARLY_ONLY = {"early": 1.0, "mid": 0.0, "late": 0.0}


def _regime_weights(reg: dict, k: float, t: int) -> dict:
    """The day's signal weights: each regime's set scaled to sum 1, blended by `reg`'s memberships.
    The dip carries the Caution dial (k / CAUTION_K); before discovery settles there is no climb."""
    w: dict = {}
    for r, share in reg.items():
        if share <= 0:
            continue
        st = dict(REGIME_SETS[r])
        if t < DISCOVERY_DAY:
            st.pop("kept", None)
            st.pop("trend", None)
        tot = sum(st.values())
        for name, v in st.items():
            w[name] = w.get(name, 0.0) + share * v / tot
    if "dip" in w:
        w["dip"] *= k / CAUTION_K
    return w


def _haven(entries, t: int) -> dict:
    """Safe-haven reading (Baur & Lucey 2010): each asset's mean daily log move relative to the board's
    median on the board's worst third of days since DISCOVERY_DAY. {item_id: value}."""
    moves = {}
    for e in entries:
        s = {a: v for a, v in e[1].items() if a <= t}
        sm = {a: _smooth(s, a) for a in s if a >= DISCOVERY_DAY - 1}
        moves[e[0]] = {b: math.log(sm[b] / sm[b - 1]) for b in sm if b - 1 in sm and sm[b] > 0 and sm[b - 1] > 0}
    board = {}
    for d in range(DISCOVERY_DAY, t + 1):
        rs = [m[d] for m in moves.values() if d in m]
        if len(rs) >= 10:
            board[d] = statistics.median(rs)
    if len(board) < 3:
        return {}
    worst = sorted(board, key=lambda d: (board[d], d))[:max(3, len(board) // 3)]
    out = {}
    for iid, m in moves.items():
        rel = [m[d] - board[d] for d in worst if d in m]
        if len(rel) >= 3:
            out[iid] = statistics.fmean(rel)
    return out


def _rank_day(entries, t: int, k: float, past=(), reg: dict | None = None) -> dict:
    """One day's composite: {item_id: 0..1}. `entries` = [(item_id, series, ...)]; `reg` = the day's
    regime memberships (None: early)."""
    sig = [(e[0], _signals(e[1], t)) for e in entries]
    sig = [(i, x) for i, x in sig if x]
    if not sig:
        return {}
    weights = _regime_weights(reg or _EARLY_ONLY, k, t)
    haven = _haven(entries, t) if weights.get("haven") else {}
    for iid, x in sig:
        x["record"] = _record(iid, past) if past and weights.get("record") else None
        x["haven"] = haven.get(iid)
    # Each signal is ranked among the assets it can be measured for; an asset's score averages the
    # signals it has. A signal nobody has yet (early league) simply doesn't weigh. The record is the
    # exception once earlier leagues exist: no record is a neutral rank, not a missing one, so a new
    # item gets neither credit nor blame for a history it doesn't have.
    num = [0.0] * len(sig)
    den = [0.0] * len(sig)
    for name, w in weights.items():
        if not w:
            continue
        have = [i for i, (_iid, x) in enumerate(sig) if x[name] is not None]
        if len(have) >= 2:
            for i, r in zip(have, _pct_ranks([sig[i][1][name] for i in have])):
                num[i] += w * r
                den[i] += w
        if name == "record" and past:
            for i, (_iid, x) in enumerate(sig):
                if x["record"] is None:
                    num[i] += w * 0.5
                    den[i] += w
    return {iid: (num[i] / den[i] if den[i] else 0.5) for i, (iid, _x) in enumerate(sig)}


def _hold_scores(entries, t: int, k: float | None = None, past=(), regime=None) -> dict:
    """Hold's ranking as of league-day t: {item_id: score in 0..1}, higher first. `entries` =
    [(item_id, series, ...)] — the day's eligible board; `past` = earlier leagues [(league, per)];
    `regime` = a function league-day -> memberships (leagueregime), None for the early set. Each
    asset's score is its mean composite over the last SETTLE_DAYS days (its series as it stood each
    day), so the list settles."""
    k = CAUTION_K if k is None else k
    acc: dict = {}
    for back in range(SETTLE_DAYS):
        tt = t - back
        # an earlier day counts for an asset only if it traded that day (a stale close isn't a read);
        # today counts for every eligible asset
        day = [e for e in entries if tt in e[1]] if back else list(entries)
        for iid, v in _rank_day(day, tt, k, past, regime(tt) if regime else None).items():
            acc.setdefault(iid, []).append(v)
    return {iid: statistics.fmean(v) for iid, v in acc.items()}


# A settled market vetoes items that are sliding (docs/hold-research.md "Loop 5"). Down-vs-up volatility
# (Chen, Hong & Stein 2001 DUVOL) flags future crashes in every league; thin-market noise is symmetric,
# so it doesn't flag a rarely traded hedge the way plain downside volatility did. During price discovery
# every price swings, so the veto waits until the regime is no longer mostly early.
VETO_TOP = 10         # the list a player acts on
VETO_MAX = 3          # at most this many swapped out a day (keeps the list settled)
VETO_QUANTILE = 0.8   # flagged: the board's top fifth by down-vs-up volatility
VETO_DAYS = 14


def _duvol(series, t: int) -> float | None:
    """log(σ_down / σ_up) of the last VETO_DAYS daily log moves of the smoothed price, split at their
    mean. ≈ 0 for symmetric noise; > 0 when it falls harder than it rises."""
    s = {a: v for a, v in series.items() if a <= t}
    sm = {a: _smooth(s, a) for a in s if a >= t - VETO_DAYS - 1}
    r = [math.log(sm[a] / sm[a - 1]) for a in range(t - VETO_DAYS + 1, t + 1)
         if a in sm and a - 1 in sm and sm[a] > 0 and sm[a - 1] > 0]
    if len(r) < 7:
        return None
    m = statistics.fmean(r)
    down = [x - m for x in r if x < m]
    up = [x - m for x in r if x >= m]
    if len(down) < 2 or len(up) < 2:
        return None
    sd = math.sqrt(statistics.fmean(x * x for x in down))
    su = math.sqrt(statistics.fmean(x * x for x in up))
    return math.log(sd / su) if sd > 0 and su > 0 else None


def _crash_flags(entries, t: int) -> dict:
    """{item_id: True/False}: in the board's top VETO_QUANTILE by down-vs-up volatility."""
    d = {e[0]: _duvol(e[1], t) for e in entries}
    vals = sorted(v for v in d.values() if v is not None)
    if len(vals) < 10:
        return {}
    cut = vals[int(VETO_QUANTILE * (len(vals) - 1))]
    return {i: (v is not None and v > cut) for i, v in d.items()}


def hold_rank(entries, t: int, k: float | None = None, past=(), regime=None) -> dict:
    """Hold's ranking as of league-day t: {item_id: score in 0..1}, higher first (`_hold_scores`), then,
    once prices have settled, up to VETO_MAX sliding items leave the top VETO_TOP for the next unflagged
    ones below them."""
    sc = _hold_scores(entries, t, k, past, regime)
    reg = regime(t) if regime else None
    if not reg or reg.get("early", 1.0) >= 0.5:
        return sc
    return _apply_veto(sc, _crash_flags([e for e in entries if e[0] in sc], t))


def _apply_veto(sc: dict, flags: dict) -> dict:
    """Up to VETO_MAX flagged items leave the top VETO_TOP for the next UNFLAGGED items below it; the new
    order is kept, then the refills, then everyone else in their old order. The day's score values are
    reassigned down the new order, so the list stays 0..1 and monotone."""
    order = sorted(sc, key=lambda i: -sc[i])
    vetoed = [i for i in order[:VETO_TOP] if flags.get(i)][:VETO_MAX]
    refill = [i for i in order[VETO_TOP:] if not flags.get(i)][:len(vetoed)]
    if not refill:
        return sc
    vetoed = vetoed[:len(refill)]
    keep = [i for i in order[:VETO_TOP] if i not in vetoed]
    moved = set(keep) | set(refill)
    new = keep + refill + [i for i in order if i not in moved]
    values = [sc[i] for i in order]
    return {i: values[p] for p, i in enumerate(new)}


def value_cut(rows) -> float:
    """The day's traded-value threshold: the VALUE_PERCENTILE quantile over `rows`. Relative, so
    it means the same thing on league-day 2 as on day 60 and across leagues."""
    vals = sorted(r["valvol"] for r in rows)
    if not vals:
        return 0.0
    return vals[min(len(vals) - 1, int(VALUE_PERCENTILE * len(vals)))]


def eligible(m: dict, cut: float) -> bool:
    """Can this asset be ranked at all? Enough traded value to actually park wealth in, enough
    days to have measured it, and it hasn't already fallen off a cliff. Value (not unit count)
    is what clears the floor, so a rare-but-precious asset qualifies on its own terms."""
    return m["valvol"] >= cut and m["n"] >= MIN_DAYS and m["mdd"] >= MDD_CAP


def _rank(entries, k: float, cut: float | None = None, t: int | None = None, past=(), regime=None):
    """[(iid, name, cat, metrics, series)] → (the ones worth ranking, best first, {iid: score}).

    Eligibility is a HARD gate, not a weight: an asset either trades enough value to park wealth
    in, has enough days behind it and hasn't already fallen off a cliff — or it is not an answer
    to "what should I hold" at all. `cut` is the day's value threshold; computed over `entries`
    when the caller doesn't pass the whole-universe one. The order is `hold_rank` as of league-day
    `t` (default: the newest day any entry has)."""
    if cut is None:
        cut = value_cut([e[3] for e in entries])
    keep = [e for e in entries if eligible(e[3], cut)]
    if t is None:
        t = max((max(e[4]) for e in keep), default=0)
    score = hold_rank([(e[0], e[4]) for e in keep], t, k, past, regime)
    keep = [e for e in keep if e[0] in score]
    keep.sort(key=lambda e: -score[e[0]])
    return keep, score


def _predict(item_id, N, delta, past, weights=None, min_leagues=MIN_PRED_LEAGUES, window=0):
    """Forward Δ-day return from day N averaged across past leagues.

    `window` reads start days N-window..N+window in each past league and averages them, so one
    freak day can't carry a league's contribution. 0 = the single aligned day (the league-arc's
    behaviour; Hold passes PRED_WINDOW).

    Weighting: by default recency (`GAMMA**rank`, most-recent league = 1). Phase 3 passes a DTW
    `weights` map {league_name: weight} — 'which past league does now resemble' — which REPLACES
    recency. Backward-compatible: weights=None reproduces the original behavior exactly. If the
    weights cover none of the leagues that actually have data for this item (sum ≤ 0), we fall back
    to recency rather than emit a degenerate prediction — so a dead/partial sidecar degrades to Hold's
    original numbers. The returned `weighted` flag records which path was taken."""
    fwd = []                                     # (rank, league, log_return)
    reads = []                                   # every start-day read, all leagues — the band
    for rank, (lg, per) in enumerate(past):      # past already sorted most-recent first
        s = per.get(item_id)
        if not s:
            continue
        # Both ends smoothed like the current league's (_smooth): a past league's thin daily close
        # is noise — a Cranium at 0.07 → 0.04 div one day read as −43% and dragged the forecast
        # negative while its neighbours were flat.
        rets = []
        for a in range(max(0, N - window), N + window + 1):   # never before the league began
            if _nearest(s, a) and _nearest(s, a + delta):
                p0, p1 = _smooth(s, a), _smooth(s, a + delta)
                if p0 > 0:
                    rets.append(math.log(p1 / p0))
        if rets:
            fwd.append((rank, lg, statistics.fmean(rets)))
            reads.extend(rets)
    if len(fwd) < min_leagues:
        return None
    wts = [max(0.0, weights.get(lg, 0.0)) for _r, lg, _f in fwd] if weights else None
    used_weights = bool(wts) and sum(wts) > 0
    if not used_weights:
        wts = [GAMMA ** r for r, _lg, _f in fwd]
    vals = [f for _r, _lg, f in fwd]
    wmean = sum(f * w for f, w in zip(vals, wts)) / sum(wts)
    return {"pred": math.exp(wmean) - 1, "band": statistics.pstdev(reads) if len(reads) > 1 else 0.0,
            "n_leagues": len(vals), "weighted": used_weights}


def arrows(preds) -> list:
    """The day's forecasts → arrows: +1..+3 up, -1..-3 down, 0 = dash, None = no forecast.

    Direction is the forecast's sign; strength is its rank within that direction today (strongest
    third = 3), and the weakest ARROW_DASH_SHARE of the day shows a dash. Rank, not size, because
    the forecast's ordering is measured and its magnitude isn't — so this is scale-free."""
    live = [i for i, p in enumerate(preds) if p is not None]
    out = [None] * len(preds)
    weakest = sorted(live, key=lambda i: abs(preds[i]))[:int(ARROW_DASH_SHARE * len(live))]
    dashed = set(weakest) | {i for i in live if preds[i] == 0}
    for i in dashed:
        out[i] = 0
    for sign in (1, -1):
        side = sorted((i for i in live if i not in dashed and preds[i] * sign > 0),
                      key=lambda i: abs(preds[i]))
        for pos, i in enumerate(side):
            out[i] = sign * (1 + pos * 3 // len(side))
    return out


def build_context(num_id: int):
    """Shared league-building for Hold + the league-arc: read all league_daily (via the shared
    marketseries reader), price everything in `num_id`, resolve the current league the same way
    movers does (marketseries.pick_league), and sort the rest most-recent-first. Returns
    (cur_name, cur_per, past, meta) where past = [(league, per), ...]. Memoized 5 min per
    (league setting, numeraire) — the topbar arc chip and every /api/arc open hit this."""
    preferred = get_settings()["league"]
    return cache.memo(_ctx_cache, (preferred, num_id), _CTX_TTL,
                      lambda: _build_context(preferred, num_id), max_entries=8)


def _build_context(preferred: str, num_id: int):
    with db.q() as c:
        meta = marketseries.read_meta(c)
        rows = marketseries.read_rows(c)
        current = movers_current_leagues()
    cur_name = marketseries.pick_league(rows, preferred, current)
    by_league: dict[str, list] = {}
    for r in rows:
        by_league.setdefault(r[0], []).append((r[1], r[2], r[3], r[4]))
    built, day0s = {}, {}
    for lg, rws in by_league.items():
        built[lg], day0s[lg] = _build_league(rws, num_id)
    if cur_name is None:                      # the selected league has no stored dailies
        return None, {}, [], meta
    cur = built.get(cur_name, {})
    past = sorted(((lg, built[lg]) for lg in built if lg != cur_name), key=lambda x: day0s[x[0]] or "", reverse=True)
    return cur_name, cur, past, meta


def regime_of(league: str | None):
    """The league's regime as a function league-day -> memberships (leagueregime), from its raw
    exalted rows. Memoized with the league context, so every board and the arc share one timeline."""
    if not league:
        return None

    def build():
        with db.q() as c:
            per = leagueregime.from_rows(marketseries.read_rows(c, league))
        return lambda t: leagueregime.regime(per, t)
    return cache.memo(_ctx_cache, ("regime", league), _CTX_TTL, build, max_entries=8)


def movers_current_leagues() -> list:
    """The game's currently-live leagues as poe2scout reports them (operational kv)."""
    return db.kv_get(marketseries.CURRENT_LEAGUES_KEY, []) or []


def _arc_weights(cur_name: str) -> dict | None:
    """The sidecar's DTW league-weight vector for the current league, or None (dead/stale sidecar →
    Hold silently uses recency). Only honoured when the cache blob is for the same league."""
    with db.q() as c:
        blob = analytics.read_cache(c, "arc", "current")
    if blob and blob.get("league") == cur_name:
        return blob.get("weights") or None
    return None


def leaderboard(horizon: str = "3d", category: str = "all", numeraire: str = "divine",
                k: float | None = None) -> dict:
    if horizon not in HORIZON_DAYS:
        horizon = "3d"
    if numeraire not in NUMERAIRES:
        numeraire = "divine"
    num_id, num_name = NUMERAIRES[numeraire]
    # The dial is part of the cache key: without it the slider would appear dead for the TTL.
    k = clamp_k(get_settings().get("hold_caution") if k is None else k)
    return cache.memo(_cache, f"{horizon}|{category}|{numeraire}|{k:g}", _TTL,
                      lambda: _leaderboard(horizon, category, numeraire, num_id, num_name, k))


def _leaderboard(horizon: str, category: str, numeraire: str, num_id: int, num_name: str,
                 k: float = CAUTION_K) -> dict:
    cur_name, cur, past, meta = build_context(num_id)
    weights = _arc_weights(cur_name)        # Phase 3: DTW-weight the forward prediction when available
    hz = HORIZON_DAYS[horizon]
    delta = hz

    # The return over the horizon is the exchange's HOURLY card in the numeraire wherever the
    # exchange trades the asset (the same card and % the zoom opens), else the daily closes. The
    # daily series still carries the drawdown, liquidity, confidence and the league-day the
    # cross-league prediction is read from (past leagues only exist as dailies).
    from . import movers
    from .currencies import registry
    anchor = marketseries.ANCHORS[numeraire]
    num_tid = registry.resolve_meta(anchor.metadata_id) or numeraire
    hourly = movers.exchange_cards(
        [meta.get(iid, (str(iid), "?"))[0] for iid in cur if iid != num_id], hz * 24, num_tid)
    # Score the WHOLE universe first: the value floor is relative to the day, so it must be read
    # off every asset that traded, not off whichever category is being viewed.
    entries = []
    for iid, series in cur.items():
        if iid == num_id:                       # the numeraire itself (return ≈ 0 by construction)
            continue
        name, cat = meta.get(iid, (str(iid), "?"))
        m = _metrics(series, hz)
        if not m:
            continue
        card = hourly.get(name)
        # ...only when that card's line really is in this numeraire. A thin asset whose card fell
        # back to the reference (or to poe2scout dailies) would otherwise contribute a vs-Exalted
        # return to a board labelled "vs Divine", and Exalted inflates over a league.
        if card and card["change_pct"] is not None and card["trend_num"] == num_tid:
            m["ret"] = card["change_pct"] / 100.0
        entries.append((iid, name, cat, m, series))

    cut = value_cut([e[3] for e in entries])    # the day's threshold, over everything
    cats = sorted({e[2] for e in entries})      # dropdown reads the full universe
    today = max((m["cur_age"] for _i, _n, _c, m, _s in entries), default=0)
    regime = regime_of(cur_name)
    board, score = _rank(entries, k, cut, today, past, regime)   # the whole day's ranked board, every category
    # The forecast column exists only through ARROW_LAST_DAY, and carries arrows only on
    # ARROW_HORIZONS (1d keeps the column, all dashes). Arrows rank each forecast against the WHOLE
    # board, so viewing one category can't restyle an asset.
    shown = today <= ARROW_LAST_DAY
    arrow_of = {}
    if shown and horizon in ARROW_HORIZONS:
        preds = [(_predict(iid, m["cur_age"], delta, past, weights, window=PRED_WINDOW) or {}).get("pred")
                 for iid, _n, _c, m, _s in board]
        arrow_of = dict(zip((e[0] for e in board), arrows(preds)))

    # beta telemetry (gated off in stable builds): what the board showed, so a beta Hold list can be
    # checked from the log
    reg = regime(today) if regime else {}
    devtelemetry.tlog("hold", f"day={today} hz={horizon} k={k:g} eligible={len(board)} "
                              f"regime={'/'.join(f'{reg.get(r, 0):.2f}' for r in ('early', 'mid', 'late'))} "
                              f"top5={'; '.join(e[1] for e in board[:5])}")
    assets = []
    for iid, name, cat, m, series in board:
        if category != "all" and cat != category:
            continue
        sig = _signals(series, today) or {"dip": m["mdd"]}
        assets.append({
            "id": iid, "name": name, "category": cat,
            # the dip the ranking reads: smoothed, since the league's prices settled
            "ret_pct": round(m["ret"] * 100, 1), "mdd_pct": round(sig["dip"] * 100, 1),
            "hold": round(score[iid] * 100), "days": m["n"], "medvol": round(m["valvol"]),
            "confidence": round(m["conf"], 2),
            "pred_arrows": arrow_of.get(iid),
        })
    return {"league": cur_name, "horizon": horizon, "delta_days": delta, "window_h": delta * 24,
            "pred_weighted": weights is not None,   # Phase 3: forward pred is DTW-weighted vs recency
            "numeraire": numeraire, "numeraire_name": num_name,
            "numeraires": [{"id": nk, "name": nv[1]} for nk, nv in NUMERAIRES.items()],
            "categories": ["all"] + cats, "count": len(assets), "assets": assets,
            "k": k, "k_range": list(CAUTION_RANGE), "pred_shown": shown}
