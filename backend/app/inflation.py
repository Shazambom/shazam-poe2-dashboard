"""League inflation: the value of soft currencies measured in a hard-asset
numeraire, indexed to the start of available data.

A "hard" asset (Mirror of Kalandra, Hinekora's Lock) holds value across a league,
so pricing a soft currency in it exposes the soft currency's inflation: rising
index = it now takes MORE of the soft currency to buy one hard asset.

Method (per the research): per hour, price each soft currency in the numeraire
from executed volume ratios; rebase each to a first-24h volume-weighted base = 100;
combine into a headline basket as a volume-weighted geometric mean of the per-
currency indices (a simplified Törnqvist). Velocity = mean hourly log-return of the
basket over the last 24h, expressed as %/day — accelerating = soft currency dumping.

Pure Python on purpose: the data is hourly per league (hundreds of rows), so pandas
/ numpy would only bloat the desktop binary for no speed that matters here.
"""
from __future__ import annotations

import math
import time

from . import db
from .currencies import registry
from .settings import get_settings

HOUR = 3600

# Hard-asset anchors by GGG metadata id. Divine is dense (appears every hour);
# Mirror and Hinekora are the truest stores of value but trade thinly, so their
# series has gaps — the UI notes coverage per anchor.
ANCHORS: dict[str, tuple[str, str]] = {
    "mirror":   ("Mirror of Kalandra", "Metadata/Items/Currency/CurrencyDuplicate"),
    "hinekora": ("Hinekora's Lock",    "Metadata/Items/Currency/CurrencyHinekorasLock"),
    "divine":   ("Divine Orb",         "Metadata/Items/Currency/CurrencyModValues"),
}

# Divine is the pivot: soft currencies almost never trade DIRECTLY against a Mirror
# or Hinekora, but they trade densely against Divine, and Divine trades densely
# against both hard assets. So we price soft→hard as soft→divine × divine→hard.
PIVOT_META = "Metadata/Items/Currency/CurrencyModValues"


def _metas(tid: str) -> list[str]:
    cur = registry.by_id.get(tid)
    return list(cur.metadata_ids) if cur else []


def _hourly_soft_per_hard(c, league, soft_metas, hard_metas) -> dict[int, tuple[float, float]]:
    """{hour: (soft_units_per_hard_unit, hard_volume)} from executed volume ratios."""
    if not soft_metas or not hard_metas:
        return {}
    sp, hp = ",".join("?" * len(soft_metas)), ",".join("?" * len(hard_metas))
    rows = c.execute(
        f"""SELECT hour, cur_a, cur_b, vol_a, vol_b FROM digest_markets
            WHERE league=? AND ((cur_a IN ({sp}) AND cur_b IN ({hp}))
                              OR (cur_a IN ({hp}) AND cur_b IN ({sp})))""",
        (league, *soft_metas, *hard_metas, *hard_metas, *soft_metas)).fetchall()
    soft_set = set(soft_metas)
    agg: dict[int, list[float]] = {}
    for r in rows:
        vs, vh = (r["vol_a"], r["vol_b"]) if r["cur_a"] in soft_set else (r["vol_b"], r["vol_a"])
        if not vs or not vh:
            continue
        a = agg.setdefault(r["hour"], [0.0, 0.0])
        a[0] += vs
        a[1] += vh
    # soft per hard = volume(soft) / volume(hard)
    return {h: (vs / vh, vh) for h, (vs, vh) in agg.items() if vs > 0 and vh > 0}


def _rebase(series: dict[int, tuple[float, float]]):
    """-> ({hour: (index, weight)}, base_price). Base = vol-weighted mean of first 24h."""
    pts = sorted(series.items())
    if not pts:
        return {}, None
    base_end = pts[0][0] + 24 * HOUR
    num = den = 0.0
    for h, (p, w) in pts:
        if h < base_end:
            num += p * w
            den += w
    base = (num / den) if den else pts[0][1][0]
    return {h: (100.0 * p / base, w) for h, (p, w) in pts}, base


_cache: dict[str, tuple[float, dict]] = {}
TTL_S = 300


def compute(anchor_key: str, hours: int = 336) -> dict:
    if anchor_key not in ANCHORS:
        anchor_key = "hinekora"
    s = get_settings()
    league = s["league"]
    ck = f"{league}|{anchor_key}|{hours}"
    hit = _cache.get(ck)
    if hit and time.time() - hit[0] < TTL_S:
        return hit[1]

    name, hard_meta = ANCHORS[anchor_key]
    pivot_is_hard = hard_meta == PIVOT_META
    anchor_tid = registry.resolve_meta(hard_meta)
    softs = [t for t in s["watchlist"] if t != anchor_tid]
    since = int(time.time()) - hours * HOUR

    percur: dict[str, dict[int, tuple[float, float]]] = {}
    currencies = []
    with db.q() as c:
        # divine→hard per hour (the pivot leg), skipped when the anchor IS divine.
        divine_per_hard = {} if pivot_is_hard else _hourly_soft_per_hard(c, league, [PIVOT_META], [hard_meta])
        for tid in softs:
            metas = _metas(tid)
            raw: dict[int, tuple[float, float]] = {}
            if metas == [PIVOT_META]:                      # the pivot currency itself (Divine)
                src = {} if pivot_is_hard else divine_per_hard
                raw = {h: v for h, v in src.items() if h >= since}
            else:
                soft_per_divine = _hourly_soft_per_hard(c, league, metas, [PIVOT_META])
                for h, (sp, w) in soft_per_divine.items():
                    if h < since:
                        continue
                    if pivot_is_hard:
                        raw[h] = (sp, w)                   # soft→divine already IS soft→hard
                    elif h in divine_per_hard:
                        raw[h] = (sp * divine_per_hard[h][0], w)   # chain: soft→divine × divine→hard
            idx, base = _rebase(raw)
            if not idx or not base:
                continue
            percur[tid] = idx
            arr = sorted(idx.items())
            currencies.append({
                "id": tid, "name": registry.name(tid),
                "points": [{"t": h, "v": round(v, 2)} for h, (v, _w) in arr],
                "current": round(arr[-1][1][0], 2),
                "since_base_pct": round(arr[-1][1][0] - 100, 2),
                "coverage": len(arr),
            })

    # Basket: volume-weighted geometric mean of the per-currency indices each hour.
    all_hours = sorted({h for idx in percur.values() for h in idx})
    basket: list[tuple[int, float]] = []
    for h in all_hours:
        num = den = 0.0
        for idx in percur.values():
            if h in idx:
                v, w = idx[h]
                num += w * math.log(v)
                den += w
        if den > 0:
            basket.append((h, math.exp(num / den)))

    velocity = change_24h = None
    if len(basket) >= 2:
        lr = [(basket[i][0], math.log(basket[i][1] / basket[i - 1][1])) for i in range(1, len(basket))]
        recent = [r for t, r in lr if t >= basket[-1][0] - 24 * HOUR]
        if recent:
            velocity = round(sum(recent) / len(recent) * 24 * 100, 2)   # %/day
        target = basket[-1][0] - 24 * HOUR
        prev = min(basket, key=lambda x: abs(x[0] - target))
        if prev[1]:
            change_24h = round((basket[-1][1] / prev[1] - 1) * 100, 2)

    result = {
        "anchor": anchor_key, "anchor_name": name, "league": league,
        "base_note": "indexed to the first captured 24h = 100",
        "currencies": sorted(currencies, key=lambda x: -x["current"]),
        "basket": {
            "points": [{"t": h, "v": round(v, 2)} for h, v in basket],
            "since_base_pct": round(basket[-1][1] - 100, 2) if basket else None,
            "velocity_pct_per_day": velocity,
            "change_24h_pct": change_24h,
        },
        "anchors": [{"id": k, "name": v[0]} for k, v in ANCHORS.items()],
        "hours_covered": len(all_hours),
    }
    _cache[ck] = (time.time(), result)
    return result
