"""League inflation: the value of soft currencies measured in a hard-asset
numeraire, indexed to the first 24h of the window = 100.

A "hard" asset (Mirror of Kalandra, Hinekora's Lock) holds value across a league,
so pricing a soft currency in it exposes the soft currency's inflation: rising
index = it now takes MORE of the soft currency to buy one hard asset.

Method: per hour, price each soft currency in the numeraire from executed volume
ratios; suppress single-hour bad prints with a centered rolling median filter and
smooth thin hours with a volume-weighted moving average; rebase each to its first-24h
volume-weighted mean = 100; combine the core liquid currencies into a headline basket
using a Divine-volume-weighted geometric mean. Velocity = 7d OLS log-trend expressed
as %/day; Last 24h = 24h change via marketseries.change_over.

Pure Python on purpose: the data is hourly per league (hundreds of rows), so pandas
/ numpy would only bloat the desktop binary for no speed that matters here.
"""

from __future__ import annotations

import math
import statistics
import time

from . import cache, db, marketseries
from .currencies import registry
from .settings import get_settings

HOUR = 3600

# Hard-asset anchors by GGG metadata id. Divine is dense (appears every hour);
# Mirror and Hinekora are the truest stores of value but trade thinly, so their
# pivot leg is despiked and volume-smoothed before chaining.
ANCHORS: dict[str, tuple[str, str]] = {
    k: (a.name, a.metadata_id)
    for k, a in marketseries.ANCHORS.items()
    if k in ("divine", "mirror", "lock")
}
DEFAULT_ANCHOR = "lock"

# Divine is the pivot: soft currencies almost never trade DIRECTLY against a Mirror
# or Hinekora, but they trade densely against Divine, and Divine trades densely
# against both hard assets. So we price soft→hard as soft→divine × divine→hard.
PIVOT_META = marketseries.ANCHORS["divine"].metadata_id

# Hard-asset stores of value are never plotted as soft currencies in Inflation.
HARD_ANCHOR_METAS = frozenset(
    meta for _, meta in ANCHORS.values() if meta != PIVOT_META
)

# Core liquid currencies always form the default chart and headline basket, independent
# of what niche items a player pins on their Board. Thin orbs (e.g. Regal at ~8 div/hr)
# stay opt-in via watchlist so 1:999 prints never distort the default chart or basket.
CORE_SOFT = ("exalted", "vaal", "chaos", "annul", "divine")

# Outlier suppression, volume-weighted smoothing, and trend velocity constants.
SPIKE_RADIUS = 3  # ±3 neighboring points for centered rolling median
SPIKE_MAX_GAP_H = (
    24  # only compare against neighbors within ±24h (never across multi-day gaps)
)
SPIKE_MAX_LOG_DEV = math.log(
    1.25
)  # flag single-hour prints >25% away from local median
ANCHOR_SMOOTH_H = 3  # ±3h VWMA on thin hard-anchor pivot legs (Lock/Mirror)
SOFT_SMOOTH_H = 2  # ±2h VWMA on soft/divine legs
VELOCITY_WINDOW_H = 7 * 24  # 7-day OLS log-trend for Per day pace (%/day)


_metas = registry.metas


def _hourly_soft_per_hard(
    c, league, soft_metas, hard_metas, since=0
) -> dict[int, tuple[float, float]]:
    """{hour: (soft_units_per_hard_unit, hard_volume)} from executed volume ratios."""
    if not soft_metas or not hard_metas:
        return {}
    sp, hp = ",".join("?" * len(soft_metas)), ",".join("?" * len(hard_metas))
    rows = c.execute(
        f"""SELECT hour, cur_a, cur_b, vol_a, vol_b FROM digest_markets
            WHERE league=? AND hour>=? AND ((cur_a IN ({sp}) AND cur_b IN ({hp}))
                              OR (cur_a IN ({hp}) AND cur_b IN ({sp})))""",
        (league, since, *soft_metas, *hard_metas, *hard_metas, *soft_metas),
    ).fetchall()
    soft_set = set(soft_metas)
    agg: dict[int, list[float]] = {}
    for r in rows:
        vs, vh = (
            (r["vol_a"], r["vol_b"])
            if r["cur_a"] in soft_set
            else (r["vol_b"], r["vol_a"])
        )
        if not vs or not vh:
            continue
        a = agg.setdefault(r["hour"], [0.0, 0.0])
        a[0] += vs
        a[1] += vh
    # soft per hard = volume(soft) / volume(hard)
    return {h: (vs / vh, vh) for h, (vs, vh) in agg.items() if vs > 0 and vh > 0}


def _despike(
    series: dict[int, tuple[float, float]],
    radius: int = SPIKE_RADIUS,
    max_log_dev: float = SPIKE_MAX_LOG_DEV,
) -> dict[int, tuple[float, float]]:
    """Replace isolated single-hour outlier prints with their local neighbor median and zero
    their smoothing weight so bad prints cannot pollute neighboring hours."""
    pts = sorted(series.items())
    if len(pts) < 5:
        return dict(series)
    max_gap_s = SPIKE_MAX_GAP_H * HOUR
    out: dict[int, tuple[float, float]] = {}
    for i, (h, (p, w)) in enumerate(pts):
        lo, hi = max(0, i - radius), min(len(pts), i + radius + 1)
        nb = [
            pts[j][1][0]
            for j in range(lo, hi)
            if j != i and pts[j][1][0] > 0 and abs(pts[j][0] - h) <= max_gap_s
        ]
        if len(nb) < 2:
            out[h] = (p, w)
            continue
        med = statistics.median(nb)
        if p > 0 and med > 0 and abs(math.log(p / med)) > max_log_dev:
            out[h] = (med, 0.0)
        else:
            out[h] = (p, w)
    return out


def _vwma(
    series: dict[int, tuple[float, float]], half_window_h: int
) -> dict[int, tuple[float, float]]:
    """Centered volume-weighted moving average over ±half_window_h hours. Thin hours (e.g. a
    single Lock trade) carry tiny weight compared to normal neighboring hours; despiked hours
    (w == 0) do not pollute neighbors, then inherit neighbor mean weight for downstream basket weighting."""
    pts = sorted(series.items())
    if len(pts) < 3 or half_window_h <= 0:
        return dict(series)
    out: dict[int, tuple[float, float]] = {}
    span = half_window_h * HOUR
    n = len(pts)
    lo = 0
    for h, (p, w) in pts:
        while lo < n and pts[lo][0] < h - span:
            lo += 1
        num = den = 0.0
        cnt = 0
        j = lo
        while j < n and pts[j][0] <= h + span:
            pj, wj = pts[j][1]
            if wj > 0:
                num += pj * wj
                den += wj
                cnt += 1
            j += 1
        price = num / den if den > 0 else p
        weight = w if w > 0 else (den / cnt if cnt > 0 else 0.0)
        out[h] = (price, weight)
    return out


def _rebase(series: dict[int, tuple[float, float]]):
    """-> ({hour: (index, weight)}, base_price). Base = vol-weighted mean of first 24h."""
    pts = sorted(series.items())
    if not pts:
        return {}, None
    base_end = pts[0][0] + 24 * HOUR
    num = den = 0.0
    for h, (p, w) in pts:
        if h < base_end and w > 0:
            num += p * w
            den += w
    base = (num / den) if den else pts[0][1][0]
    return {h: (100.0 * p / base, w) for h, (p, w) in pts}, base


def _ols_daily_pct(
    basket: list[tuple[int, float]], window_s: int = VELOCITY_WINDOW_H * HOUR
) -> float | None:
    """Inflation velocity (%/day) via OLS linear regression on ln(v) against elapsed days.
    Uses every point in [t_end - window_s, t_end] and handles missing hours by real timestamps."""
    if len(basket) < 2:
        return None
    cutoff = basket[-1][0] - window_s
    win = [(t, v) for t, v in basket if t >= cutoff and v > 0]
    if len(win) < 2 or win[-1][0] - win[0][0] < 24 * HOUR:
        return None
    t0 = win[0][0]
    xs = [(t - t0) / (24 * HOUR) for t, _ in win]
    ys = [math.log(v) for _, v in win]
    mx = sum(xs) / len(xs)
    my = sum(ys) / len(ys)
    denom = sum((x - mx) ** 2 for x in xs)
    if denom <= 0:
        return 0.0
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=False)) / denom
    slope = max(-10.0, min(10.0, slope))
    return round((math.exp(slope) - 1) * 100, 2)


_cache: dict[str, tuple[float, dict]] = {}
TTL_S = 300


def compute(anchor_key: str, hours: int = 336) -> dict:
    anchor_key = marketseries.anchor_key(anchor_key, DEFAULT_ANCHOR)
    s = get_settings()
    league = s["league"]
    # Watchlist extras only: order, core softs, and duplicates don't change the output.
    extra_wl = ",".join(sorted(set(s["watchlist"]) - set(CORE_SOFT)))
    ck = f"{league}|{anchor_key}|{hours}|{extra_wl}"
    return cache.memo(
        _cache,
        ck,
        TTL_S,
        lambda: _compute(anchor_key, hours, s, league),
        max_entries=32,
    )


def _compute(anchor_key: str, hours: int, s: dict, league: str) -> dict:
    name, hard_meta = ANCHORS[anchor_key]
    pivot_is_hard = hard_meta == PIVOT_META
    anchor_tid = registry.resolve_meta(hard_meta)

    # Always include the core liquid currencies (excluding the chosen anchor); append extra
    # non-anchor watchlist items so players can toggle them on without cluttering the default view.
    candidates: list[tuple[str, bool]] = []
    seen: set[str] = {anchor_tid} if anchor_tid else set()
    for is_core, group in ((True, CORE_SOFT), (False, s["watchlist"])):
        for tid in group:
            if tid not in seen:
                candidates.append((tid, is_core))
                seen.add(tid)

    since = int(time.time()) - hours * HOUR

    core_percur: dict[str, dict[int, tuple[float, float]]] = {}
    all_percur: dict[str, dict[int, tuple[float, float]]] = {}
    currencies = []
    with db.q() as c:
        # divine→hard per hour (the pivot leg), skipped when the anchor IS divine.
        if pivot_is_hard:
            divine_per_hard: dict[int, tuple[float, float]] = {}
        else:
            raw_dph = _hourly_soft_per_hard(c, league, [PIVOT_META], [hard_meta], since)
            divine_per_hard = _vwma(_despike(raw_dph), ANCHOR_SMOOTH_H)

        if pivot_is_hard or divine_per_hard:
            for tid, is_core in candidates:
                metas = _metas(tid)
                if set(metas) & HARD_ANCHOR_METAS:
                    continue
                raw: dict[int, tuple[float, float]] = {}
                if metas == [PIVOT_META]:  # the pivot currency itself (Divine)
                    if not pivot_is_hard:
                        # Weight Divine in Divine units (p * hard_vol = div_vol) to match all other legs.
                        raw = {h: (p, p * w) for h, (p, w) in divine_per_hard.items()}
                else:
                    raw_spd = _hourly_soft_per_hard(
                        c, league, metas, [PIVOT_META], since
                    )
                    soft_per_divine = _vwma(_despike(raw_spd), SOFT_SMOOTH_H)
                    for h, (sp, w) in soft_per_divine.items():
                        if pivot_is_hard:
                            raw[h] = (sp, w)  # soft→divine already IS soft→hard
                        elif h in divine_per_hard:
                            raw[h] = (
                                sp * divine_per_hard[h][0],
                                w,
                            )  # chain: soft→divine × divine→hard
                idx, base = _rebase(raw)
                if not idx or not base:
                    continue
                all_percur[tid] = idx
                if is_core:
                    core_percur[tid] = idx
                arr = sorted(idx.items())
                currencies.append(
                    {
                        "id": tid,
                        "name": registry.name(tid),
                        "points": [{"t": h, "v": round(v, 2)} for h, (v, _w) in arr],
                        "current": round(arr[-1][1][0], 2),
                        "since_base_pct": round(arr[-1][1][0] - 100, 2),
                        "coverage": len(arr),
                        "default_on": is_core,
                    }
                )

    # Basket: Divine-volume-weighted geometric mean of the core liquid currencies each hour.
    basket_src = core_percur or all_percur
    all_hours = sorted({h for idx in basket_src.values() for h in idx})
    basket: list[tuple[int, float]] = []
    for h in all_hours:
        num = den = 0.0
        fb_num = 0.0
        fb_cnt = 0
        for idx in basket_src.values():
            pt = idx.get(h)
            if not pt or pt[0] <= 0:
                continue
            v, w = pt
            lv = math.log(v)
            if w > 0:
                num += w * lv
                den += w
            fb_num += lv
            fb_cnt += 1
        if den > 0:
            basket.append((h, math.exp(num / den)))
        elif fb_cnt > 0:
            basket.append((h, math.exp(fb_num / fb_cnt)))

    velocity = _ols_daily_pct(basket, VELOCITY_WINDOW_H * HOUR)
    _, chg_24h = marketseries.change_over(
        basket, 24 * HOUR, t=lambda p: p[0], v=lambda p: p[1]
    )
    change_24h = round(chg_24h, 2) if chg_24h is not None else None

    result = {
        "anchor": anchor_key,
        "anchor_name": name,
        "league": league,
        "base_note": "indexed to the first captured 24h = 100",
        "currencies": sorted(
            currencies, key=lambda x: (not x["default_on"], -x["current"])
        ),
        "basket": {
            "points": [{"t": h, "v": round(v, 2)} for h, v in basket],
            "since_base_pct": round(basket[-1][1] - 100, 2) if basket else None,
            "velocity_pct_per_day": velocity,
            "change_24h_pct": change_24h,
        },
        "anchors": [{"id": k, "name": v[0]} for k, v in ANCHORS.items()],
        "hours_covered": len(all_hours),
    }
    return result
