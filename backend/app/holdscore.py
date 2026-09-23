"""'What to hold' leaderboard: rank assets by how well they retain/gain value in
Divine over short/medium/long horizons, with a cross-league forward-return prediction.

- Everything is priced in DIVINE (not the inflating Exalted base) — that's what
  "held value" means to a player.
- HOLD score = horizon return-in-Divine × confidence. Max drawdown is shown as its
  own column, not folded into the score (keeps the ranking readable). Confidence =
  data-shrinkage × liquidity, so thin/obscure items don't top the board on noise.
- Prediction = the league-phase analog: at the current league's day N, average each
  asset's forward Δ-day return from the days around N (±PRED_WINDOW) across PAST
  leagues (recency-weighted), with the dispersion as a confidence band.

Pure Python (stdlib only) — the data is a few hundred items × ~150 days.
"""
from __future__ import annotations

import math
import statistics

from . import analytics, cache, db, marketseries
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
# --- ranking contract (measured 2026-09-20; see docs/bugs/2026-09-20-hold-ranks-against-its-own-forecast.md)
# The score is SIGN-SAFE: it composes in log-space over strictly positive factors, so a worse
# drawdown always lowers it. The old `ret * conf * stab` multiplied a SIGNED return by factors in
# [0,1], which reverses a penalty below zero — a deeper crash made the score less negative and
# ranked it HIGHER (61% of negative-return pairs were inverted on the owner's DB).
CAUTION_K = 2.0            # drawdown weight. Backtested: k=2 reproduces the old crash rate (5%) and
                        # blue-chip mix with better drawdowns; safety saturates at k=3.
# k is a USER DIAL (owner directive 2026-09-20): a CAUTION slider on the Hold page, persisted as the
# `hold_caution` setting. 0 = rank on return alone; higher = favour the steadier asset. Capped
# at 6 because the backtest shows drawdown flat at -14.0% from k=3 up, so beyond that the dial
# costs return and buys nothing. Monotonicity holds at EVERY position, so the slider can change
# what the board prefers but can never reintroduce the sign bug.
CAUTION_RANGE = (0.0, 6.0)
MDD_CAP = -0.40         # exclude anything that fell worse than this. Tightest cap that still
                        # spares Mirror/Hinekora (at -35% they drop out 25%/27% of early days).
MIN_DAYS = 4            # a score needs at least this many days behind it
VALUE_PERCENTILE = 0.50  # keep the top half of the DAY's traded value — RELATIVE, because the
                        # value scale shifts ~14x between leagues and an absolute floor is either
                        # unreachable or arbitrary. A relative cut can never empty the board.
_EPS = 1e-12            # keeps log() finite at a total loss without disturbing any real ordering
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


def hold_score(m: dict, k: float | None = None) -> float:
    """The ranking score: `log(1 + ret) + k * log(1 + mdd)` (k defaults to CAUTION_K).

    Both terms are logs of strictly positive quantities — growth (what 1 unit became) and
    steadiness (what 1 unit was worth at the trough relative to its peak) — so the score is
    monotone in BOTH axes on either side of zero, at every k. A deeper drawdown always costs,
    whether the asset gained or lost. Reads `mdd` rather than the clamped `stab` so ordering
    survives among assets that all crashed hard."""
    return (math.log(max(_EPS, 1.0 + m["ret"]))
            + (CAUTION_K if k is None else k) * math.log(max(_EPS, 1.0 + m["mdd"])))


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


def _rank(entries, k: float, cut: float | None = None):
    """[(iid, name, cat, metrics)] → the ones worth ranking, best first.

    Eligibility is a HARD gate, not a weight: an asset either trades enough value to park wealth
    in, has enough days behind it and hasn't already fallen off a cliff — or it is not an answer
    to "what should I hold" at all. `cut` is the day's value threshold; computed over `entries`
    when the caller doesn't pass the whole-universe one."""
    if cut is None:
        cut = value_cut([e[3] for e in entries])
    keep = [e for e in entries if eligible(e[3], cut)]
    keep.sort(key=lambda e: -hold_score(e[3], k))
    return keep


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
        entries.append((iid, name, cat, m))

    cut = value_cut([e[3] for e in entries])    # the day's threshold, over everything
    cats = sorted({cat for _i, _n, cat, _m in entries})   # dropdown reads the full universe
    board = _rank(entries, k, cut)              # the whole day's ranked board, every category
    # The forecast column exists only through ARROW_LAST_DAY, and carries arrows only on
    # ARROW_HORIZONS (1d keeps the column, all dashes). Arrows rank each forecast against the WHOLE
    # board, so viewing one category can't restyle an asset.
    shown = max((m["cur_age"] for *_x, m in entries), default=0) <= ARROW_LAST_DAY
    arrow_of = {}
    if shown and horizon in ARROW_HORIZONS:
        preds = [(_predict(iid, m["cur_age"], delta, past, weights, window=PRED_WINDOW) or {}).get("pred")
                 for iid, _n, _c, m in board]
        arrow_of = dict(zip((e[0] for e in board), arrows(preds)))

    assets = []
    for iid, name, cat, m in board:
        if category != "all" and cat != category:
            continue
        assets.append({
            "id": iid, "name": name, "category": cat,
            "ret_pct": round(m["ret"] * 100, 1), "mdd_pct": round(m["mdd"] * 100, 1),
            # log(1 + return) + k*log(1 + drawdown) — sign-safe, so a deeper crash always costs.
            "hold": round(hold_score(m, k), 4), "days": m["n"], "medvol": round(m["valvol"]),
            "confidence": round(m["conf"], 2),
            "pred_arrows": arrow_of.get(iid),
        })
    return {"league": cur_name, "horizon": horizon, "delta_days": delta, "window_h": delta * 24,
            "pred_weighted": weights is not None,   # Phase 3: forward pred is DTW-weighted vs recency
            "numeraire": numeraire, "numeraire_name": num_name,
            "numeraires": [{"id": nk, "name": nv[1]} for nk, nv in NUMERAIRES.items()],
            "categories": ["all"] + cats, "count": len(assets), "assets": assets,
            "k": k, "k_range": list(CAUTION_RANGE), "pred_shown": shown}
