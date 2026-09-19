"""'What to hold' leaderboard: rank assets by how well they retain/gain value in
Divine over short/medium/long horizons, with a cross-league forward-return prediction.

- Everything is priced in DIVINE (not the inflating Exalted base) — that's what
  "held value" means to a player.
- HOLD score = horizon return-in-Divine × confidence. Max drawdown is shown as its
  own column, not folded into the score (keeps the ranking readable). Confidence =
  data-shrinkage × liquidity, so thin/obscure items don't top the board on noise.
- Prediction = the league-phase analog: at the current league's day N, average each
  asset's forward Δ-day return from day N across PAST leagues (recency-weighted),
  with the cross-league dispersion as a confidence band.

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
VALUE_FLOOR = 30_000_000.0   # median daily traded VALUE (exalted) for full liquidity confidence.
# The board answers "what's a good place to park currency to beat inflation" — so a hold must
# be liquid *in value* (you can park real wealth), which is why the floor is on exalted/day,
# not raw units: a Mirror trades few units but enormous value; an essence the reverse.
GAMMA = 0.65            # recency weight for past leagues (most recent = weight 1)
MIN_PRED_LEAGUES = 2

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


def _predict(item_id, N, delta, past, weights=None, min_leagues=MIN_PRED_LEAGUES):
    """Forward Δ-day return from day N averaged across past leagues.

    Weighting: by default recency (`GAMMA**rank`, most-recent league = 1). Phase 3 passes a DTW
    `weights` map {league_name: weight} — 'which past league does now resemble' — which REPLACES
    recency. Backward-compatible: weights=None reproduces the original behavior exactly. If the
    weights cover none of the leagues that actually have data for this item (sum ≤ 0), we fall back
    to recency rather than emit a degenerate prediction — so a dead/partial sidecar degrades to Hold's
    original numbers. The returned `weighted` flag records which path was taken."""
    fwd = []                                     # (rank, league, log_return)
    for rank, (lg, per) in enumerate(past):      # past already sorted most-recent first
        s = per.get(item_id)
        if not s:
            continue
        # Both ends smoothed like the current league's (_smooth): a past league's thin daily close
        # is noise — a Cranium at 0.07 → 0.04 div one day read as −43% and dragged the forecast
        # negative while its neighbours were flat.
        if _nearest(s, N) and _nearest(s, N + delta):
            p0, p1 = _smooth(s, N), _smooth(s, N + delta)
            if p0 > 0:
                fwd.append((rank, lg, math.log(p1 / p0)))
    if len(fwd) < min_leagues:
        return None
    wts = [max(0.0, weights.get(lg, 0.0)) for _r, lg, _f in fwd] if weights else None
    used_weights = bool(wts) and sum(wts) > 0
    if not used_weights:
        wts = [GAMMA ** r for r, _lg, _f in fwd]
    vals = [f for _r, _lg, f in fwd]
    wmean = sum(f * w for f, w in zip(vals, wts)) / sum(wts)
    return {"pred": math.exp(wmean) - 1, "band": statistics.pstdev(vals) if len(vals) > 1 else 0.0,
            "n_leagues": len(vals), "weighted": used_weights}


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


def leaderboard(horizon: str = "3d", category: str = "all", numeraire: str = "divine") -> dict:
    if horizon not in HORIZON_DAYS:
        horizon = "3d"
    if numeraire not in NUMERAIRES:
        numeraire = "divine"
    num_id, num_name = NUMERAIRES[numeraire]
    return cache.memo(_cache, f"{horizon}|{category}|{numeraire}", _TTL,
                      lambda: _leaderboard(horizon, category, numeraire, num_id, num_name))


def _leaderboard(horizon: str, category: str, numeraire: str, num_id: int, num_name: str) -> dict:
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
    assets = []
    for iid, series in cur.items():
        if iid == num_id:                       # the numeraire itself (return ≈ 0 by construction)
            continue
        name, cat = meta.get(iid, (str(iid), "?"))
        if category != "all" and cat != category:
            continue
        m = _metrics(series, hz)
        if not m:
            continue
        card = hourly.get(name)
        # ...only when that card's line really is in this numeraire. A thin asset whose card fell
        # back to the reference (or to poe2scout dailies) would otherwise contribute a vs-Exalted
        # return to a board labelled "vs Divine", and Exalted inflates over a league.
        if card and card["change_pct"] is not None and card["trend_num"] == num_tid:
            m["ret"] = card["change_pct"] / 100.0
        pr = _predict(iid, m["cur_age"], delta, past, weights)
        assets.append({
            "id": iid, "name": name, "category": cat,
            "ret_pct": round(m["ret"] * 100, 1), "mdd_pct": round(m["mdd"] * 100, 1),
            # hold = appreciation × (how confident/liquid) × (how stable) — a store-of-value
            # score, not a chase-the-biggest-mover score.
            "hold": round(m["ret"] * m["conf"] * m["stab"], 4), "days": m["n"], "medvol": round(m["valvol"]),
            "confidence": round(m["conf"], 2),
            "pred_pct": round(pr["pred"] * 100, 1) if pr else None,
            "pred_band_pct": round(pr["band"] * 100, 1) if pr else None,
            "pred_leagues": pr["n_leagues"] if pr else 0,
        })
    assets.sort(key=lambda x: -x["hold"])
    cats = sorted({a["category"] for a in assets})
    return {"league": cur_name, "horizon": horizon, "delta_days": delta, "window_h": delta * 24,
            "pred_weighted": weights is not None,   # Phase 3: forward pred is DTW-weighted vs recency
            "numeraire": numeraire, "numeraire_name": num_name,
            "numeraires": [{"id": k, "name": v[1]} for k, v in NUMERAIRES.items()],
            "categories": ["all"] + cats, "count": len(assets), "assets": assets}
