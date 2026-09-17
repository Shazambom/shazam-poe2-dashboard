"""Phase 3 — the forward league-arc for one item: 'you are here at day N' + a projected band and
buy/sell windows, DTW-weighted toward the past league the current run most resembles.

Two layers:
  * `project(...)` — PURE (stdlib): current item series + past leagues → history, forward band, windows.
    Reuses `holdscore._predict` so the projection and Hold's board share one prediction engine (and
    the same DTW weights). Unit-tested without a DB.
  * `arc_for(...)` — thin DB wrapper: resolves the item, builds the per-league context via
    `holdscore.build_context`, reads the sidecar's DTW weights from the analytics cache (falling back
    to recency when the sidecar is down), and projects. Read-only; never fails a request.

No new tables, no snapshot bump — the weights ride the existing `analytics_cache` (kind 'arc').
"""
from __future__ import annotations

from . import analytics, db, holdscore

HORIZON = 7            # project a week forward — leagues are short, so a short arc is the honest one
WINDOW_THRESH = 0.03   # min projected swing (±3%) before we flag a buy/sell window


def _windows(arc: list[dict]) -> list[dict]:
    """Turn the projected path into actionable windows: its peak is a SELL window, its trough a BUY
    window — but only when the swing clears the threshold (else 'hold', no window)."""
    if not arc:
        return []
    out = []
    hi = max(arc, key=lambda p: p["pred_pct"])
    lo = min(arc, key=lambda p: p["pred_pct"])
    if hi["pred_pct"] >= WINDOW_THRESH * 100:
        out.append({"kind": "sell", "age": hi["age"], "ret_pct": hi["pred_pct"]})
    if lo["pred_pct"] <= -WINDOW_THRESH * 100:
        out.append({"kind": "buy", "age": lo["age"], "ret_pct": lo["pred_pct"]})
    return out


def project(item_id, cur_per: dict, past: list, weights=None, horizon: int = HORIZON):
    """{cur_age, history, arc, windows, weighted} for one item, or None without ≥2 days of history.

    history: the item's actual price arc so far (oldest→newest). arc: one point per day past N with a
    mean projected return + dispersion band (and the implied price). A single past league is allowed
    here (min_leagues=1) — an early league with one comparable past is still worth a point estimate."""
    s = cur_per.get(item_id)
    if not s or len(s) < 2:
        return None
    ages = sorted(s)
    N = ages[-1]
    cur_price = s[N][0]
    history = [{"age": a, "price": round(s[a][0], 6)} for a in ages]
    arc, weighted = [], False
    for d in range(1, horizon + 1):
        pr = holdscore._predict(item_id, N, d, past, weights, min_leagues=1)
        if not pr:
            continue
        weighted = weighted or pr["weighted"]
        mean, band = pr["pred"], pr["band"]
        arc.append({
            "age": N + d,
            "pred_pct": round(mean * 100, 1),
            "lo_pct": round((mean - band) * 100, 1),
            "hi_pct": round((mean + band) * 100, 1),
            "price": round(cur_price * (1 + mean), 6),
        })
    return {"cur_age": N, "history": history, "arc": arc, "windows": _windows(arc), "weighted": weighted}


def _phase(day):
    """Coarse league-arc phase from the current league-day — the ambient 'where are we' anchor.
    Thresholds are deliberately simple/tunable; leagues run months but the tradeable action clusters
    early, so 'early' is short."""
    if day is None:
        return None
    if day < 10:
        return "early"
    if day < 45:
        return "mid"
    return "late"


def context(numeraire: str = "divine") -> dict:
    """League-level arc anchor (no item): {league, day, phase, resembles, weighted} for the topbar
    chip. `day` = the current league's latest league-day. Read-only; degrades to nulls with no data."""
    num_id = holdscore.NUMERAIRES.get(numeraire, holdscore.NUMERAIRES["divine"])[0]
    cur_name, cur, _past, _meta = holdscore.build_context(num_id)
    day = max((max(s) for s in cur.values() if s), default=None)
    with db.q() as c:
        blob = analytics.read_cache(c, "arc", "current")
    resembles = blob.get("resembles") if blob and blob.get("league") == cur_name else None
    return {"league": cur_name, "day": day, "phase": _phase(day),
            "resembles": resembles, "weighted": bool(resembles)}


def _resolve_item(meta: dict, item) -> tuple[int | None, str]:
    """Accept an item id (int or numeric str) or a name; return (item_id, name)."""
    if item is None:
        return None, ""
    try:
        iid = int(item)
        if iid in meta:
            return iid, meta[iid][0]
    except (ValueError, TypeError):
        pass
    want = str(item).strip().lower()
    for iid, (name, _cat) in meta.items():
        if name.lower() == want:
            return iid, name
    return None, str(item)


def pick_numeraire(item_id, num_id: int, num_name: str, ranked_names: list[str], meta: dict) -> tuple[int, str]:
    """Nothing is priced in itself (Divine's arc in Divine is a flat 1.0 line). When the item IS the
    numeraire, the VOLUME RULE picks the replacement: the item's highest-traded-value counterpart
    that has daily history to price against. `ranked_names` = counterpart names, biggest market
    first. No usable counterpart → unchanged (the arc then renders nothing)."""
    if item_id is None or item_id != num_id:
        return num_id, num_name
    by_name = {name.lower(): iid for iid, (name, _cat) in meta.items()}
    for name in ranked_names:
        iid = by_name.get(name.lower())
        if iid is not None and iid != item_id:
            return iid, meta[iid][0]
    return num_id, num_name


def _counterpart_names(item_name: str) -> list[str]:
    """The item's exchange counterparts by traded value (board.counterparts_by_volume), as names."""
    from . import arbitrage                    # lazy: arbitrage pulls the whole graph stack
    from .arbitrage.board import counterparts_by_volume
    from .currencies import registry
    want = item_name.strip().lower()
    slug = next((cid for cid in registry.by_id if registry.name(cid).lower() == want), None)
    if slug is None:
        return []
    g = arbitrage.cached_graph()
    return [registry.name(other) for _volr, other in counterparts_by_volume(g, g.ref_values()).get(slug, [])]


def arc_for(item, numeraire: str = "divine") -> dict:
    """Read-only league arc for `item` priced in `numeraire`. Degrades gracefully: no data → empty
    arc; sidecar down → recency-weighted (weighted=False, resembles=None)."""
    if numeraire not in holdscore.NUMERAIRES:
        numeraire = "divine"
    num_id, num_name = holdscore.NUMERAIRES[numeraire]
    cur_name, cur, past, meta = holdscore.build_context(num_id)
    item_id, item_name = _resolve_item(meta, item)
    if item_id is not None and item_id == num_id:
        num_id, num_name = pick_numeraire(item_id, num_id, num_name, _counterpart_names(item_name), meta)
        if num_id != item_id:
            numeraire = num_name
            cur_name, cur, past, meta = holdscore.build_context(num_id)

    weights, resembles = None, None
    with db.q() as c:
        blob = analytics.read_cache(c, "arc", "current")
    if blob and blob.get("league") == cur_name:
        weights = blob.get("weights") or None
        resembles = blob.get("resembles")

    base = {"league": cur_name, "item": item_name, "item_id": item_id, "numeraire": numeraire,
            "numeraire_name": num_name, "resembles": resembles,
            "cur_age": None, "history": [], "arc": [], "windows": [], "weighted": False}
    if item_id is None:
        return base
    proj = project(item_id, cur, past, weights)
    if proj:
        base.update(proj)
        base["resembles"] = resembles if base["weighted"] else None   # only claim a match if used
    return base
