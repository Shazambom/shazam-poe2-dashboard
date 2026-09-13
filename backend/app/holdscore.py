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
import time

from . import db
from .leaguehistory import _age
from .settings import get_settings

DIVINE_ID = 291
# Numeraires to price "held value" against. Divine = liquid default; Mirror & Lock
# (Hinekora's Lock) are the hardest anchors but trade thinly, so coverage is lower.
NUMERAIRES = {"divine": (291, "Divine Orb"), "mirror": (295, "Mirror of Kalandra"),
              "lock": (4287, "Hinekora's Lock")}
HORIZON_DAYS = {"short": 7, "med": 30, "long": None}   # None = whole league
SHRINK_K = 8            # data-count shrinkage: confidence = n/(n+K)
VOL_FLOOR = 200.0       # median daily units for full liquidity confidence
GAMMA = 0.65            # recency weight for past leagues (most recent = weight 1)
MIN_PRED_LEAGUES = 2

_cache: dict[str, tuple[float, dict]] = {}
_TTL = 600


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
            per.setdefault(iid, {})[_age(day, day0)] = (close / n, vol or 0)
    return per, day0


def _nearest(series: dict[int, tuple[float, float]], target: int, tol: int = 2):
    if target in series:
        return series[target]
    best, bd = None, tol + 1
    for a, v in series.items():
        if abs(a - target) < bd:
            bd, best = abs(a - target), v
    return best if bd <= tol else None


def _metrics(series: dict[int, tuple[float, float]], hz_days: int | None):
    ages = sorted(series)
    if len(ages) < 2:
        return None
    prices = [series[a][0] for a in ages]
    last = prices[-1]
    if hz_days is None:
        base = prices[0]
    else:
        # base = price hz_days ago; if the league is younger than the horizon, fall
        # back to the earliest price (so a 9-day league still shows on the 30d board).
        cand = [a for a in ages if a <= ages[-1] - hz_days]
        base = series[cand[-1]][0] if cand else prices[0]
    if not base:
        return None
    peak, mdd = prices[0], 0.0
    for p in prices:
        peak = max(peak, p)
        mdd = min(mdd, p / peak - 1)
    medvol = statistics.median(series[a][1] for a in ages)
    conf = (len(ages) / (len(ages) + SHRINK_K)) * min(1.0, medvol / VOL_FLOOR)
    return {"ret": last / base - 1, "mdd": mdd, "n": len(ages), "medvol": medvol,
            "conf": conf, "cur_age": ages[-1]}


def _predict(item_id, N, delta, past):
    """Forward Δ-day return from day N averaged across past leagues, recency-weighted."""
    fwd, wts = [], []
    for rank, (_lg, per) in enumerate(past):     # past already sorted most-recent first
        s = per.get(item_id)
        if not s:
            continue
        p0, p1 = _nearest(s, N), _nearest(s, N + delta)
        if p0 and p1 and p0[0] > 0:
            fwd.append(math.log(p1[0] / p0[0]))
            wts.append(GAMMA ** rank)
    if len(fwd) < MIN_PRED_LEAGUES:
        return None
    wmean = sum(f * w for f, w in zip(fwd, wts)) / sum(wts)
    return {"pred": math.exp(wmean) - 1, "band": statistics.pstdev(fwd) if len(fwd) > 1 else 0.0,
            "n_leagues": len(fwd)}


def leaderboard(horizon: str = "long", category: str = "all", numeraire: str = "divine") -> dict:
    if horizon not in HORIZON_DAYS:
        horizon = "long"
    if numeraire not in NUMERAIRES:
        numeraire = "divine"
    num_id, num_name = NUMERAIRES[numeraire]
    key = f"{horizon}|{category}|{numeraire}"
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < _TTL:
        return hit[1]

    s = get_settings()
    cur_name = s["league"]
    with db.q() as c:
        meta = {r["item_id"]: (r["name"], r["category"]) for r in c.execute("SELECT item_id, name, category FROM item_meta")}
        rows = c.execute("SELECT league, item_id, day, close, volume FROM league_daily WHERE close>0 ORDER BY league, day").fetchall()
    by_league: dict[str, list] = {}
    for r in rows:
        by_league.setdefault(r["league"], []).append((r["item_id"], r["day"], r["close"], r["volume"]))

    built, day0s = {}, {}
    for lg, rws in by_league.items():
        built[lg], day0s[lg] = _build_league(rws, num_id)
    if cur_name not in built:   # viewing a league with no data yet → pick a current/newest one
        current = set(db.kv_get("lh_current", []))
        cur_name = next((l for l in built if l in current), None) or (max(built, key=lambda l: day0s[l] or "") if built else None)
    cur = built.get(cur_name, {})
    hz = HORIZON_DAYS[horizon]
    delta = hz or 30
    past = sorted(((lg, built[lg]) for lg in built if lg != cur_name), key=lambda x: day0s[x[0]] or "", reverse=True)

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
        pr = _predict(iid, m["cur_age"], delta, past)
        assets.append({
            "id": iid, "name": name, "category": cat,
            "ret_pct": round(m["ret"] * 100, 1), "mdd_pct": round(m["mdd"] * 100, 1),
            "hold": round(m["ret"] * m["conf"], 4), "days": m["n"], "medvol": round(m["medvol"]),
            "confidence": round(m["conf"], 2),
            "pred_pct": round(pr["pred"] * 100, 1) if pr else None,
            "pred_band_pct": round(pr["band"] * 100, 1) if pr else None,
            "pred_leagues": pr["n_leagues"] if pr else 0,
        })
    assets.sort(key=lambda x: -x["hold"])
    cats = sorted({a["category"] for a in assets})
    res = {"league": cur_name, "horizon": horizon, "delta_days": delta,
           "numeraire": numeraire, "numeraire_name": num_name,
           "numeraires": [{"id": k, "name": v[1]} for k, v in NUMERAIRES.items()],
           "categories": ["all"] + cats, "count": len(assets), "assets": assets}
    _cache[key] = (time.time(), res)
    return res
