"""Cross-league inflation: how the current league's inflation tracks against past
leagues at the same league-age.

The currency-exchange digest is a forward cursor with limited retention, so it can't
give us past leagues' launch weeks. poe2scout (api.poe2scout.com) keeps full daily
history per league, priced in the league base (Exalted). We back that up into
`league_daily` and serve age-aligned, rebased indices.

The inflation proxy is Divine-in-Exalted: as a league ages, Exalted floods and Divine
costs more Exalted — the canonical "how inflated is this league" curve. Each league is
rebased to its own day-0 = 100 and plotted by day-of-league, so you can read
"Forbidden Rites at day 10 vs Dawn of the Hunt at day 10".
"""
from __future__ import annotations

import logging
import time
import urllib.parse

from . import db, gateway

log = logging.getLogger(__name__)

BASE = "https://api.poe2scout.com/poe2"
# Item ids are global across leagues (poe2scout), priced in the league base (Exalted).
# Mirror and Hinekora are the hardest inflation anchors; Divine is the densest and
# the default. (Hinekora has no Dawn-of-the-Hunt data — it's a newer currency.)
ITEMS = {291: "Divine Orb", 295: "Mirror of Kalandra", 4287: "Hinekora's Lock", 287: "Chaos Orb"}
DEFAULT_ITEM = 291
# Softcore challenge/event leagues worth comparing (skip HC variants, Standard, Hardcore).
SKIP = ("HC ", "Hardcore", "Standard")
REFRESH_S = 12 * 3600   # re-pull current leagues at most twice a day; past leagues are final


async def _get(path: str):
    r = await gateway.request("GET", f"{BASE}{path}", policy="poe2scout",
                              headers={"Accept": "application/json"})
    r.raise_for_status()
    return r.json()


async def _leagues() -> list[dict]:
    data = await _get("/Leagues")
    rows = data if isinstance(data, list) else data.get("items", data.get("Leagues", []))
    return [l for l in rows if not any(l.get("Value", "").startswith(s) or l.get("Value") == s for s in SKIP)]


def _stored_days(league: str, item_id: int) -> tuple[int, int | None]:
    with db.q() as c:
        r = c.execute("SELECT COUNT(*) n, MAX(day) mx FROM league_daily WHERE league=? AND item_id=?",
                      (league, item_id)).fetchone()
    return r["n"], r["mx"]


async def backfill(force: bool = False) -> dict:
    """Pull daily history for the target leagues × items into league_daily. Past
    leagues are fetched once; current leagues refresh on a 12h cadence."""
    fetched = {}
    try:
        leagues = await _leagues()
    except Exception as exc:
        log.warning("poe2scout leagues fetch failed: %s", exc)
        return {"error": str(exc)}
    db.kv_set("lh_current", [l["Value"] for l in leagues if l.get("IsCurrent") and l.get("Value")])
    for lg in leagues:
        name, current = lg.get("Value"), bool(lg.get("IsCurrent"))
        if not name:
            continue
        for item_id in ITEMS:
            n, _mx = _stored_days(name, item_id)
            # past league already stored, or current league fetched recently → skip
            if n and not force and not current:
                continue
            if n and not force and current:
                last = db.kv_get(f"lh_fetch:{name}:{item_id}", 0)
                if time.time() - last < REFRESH_S:
                    continue
            try:
                enc = urllib.parse.quote(name)
                data = await _get(f"/Leagues/{enc}/Items/{item_id}/DailyStatsHistory?dayCount=500")
            except Exception as exc:
                log.warning("poe2scout history %s/%s failed: %s", name, item_id, exc)
                continue
            rows = [(name, item_id, s["Time"], s.get("Close"), s.get("Average"), s.get("Volume"))
                    for s in data.get("DailyStats", []) if s.get("Time")]
            if rows:
                with db.tx() as c:
                    c.executemany("INSERT OR REPLACE INTO league_daily VALUES (?,?,?,?,?,?)", rows)
                db.kv_set(f"lh_fetch:{name}:{item_id}", time.time())
                fetched[f"{name}/{item_id}"] = len(rows)
    return {"fetched": fetched, "leagues": len(leagues)}


def cross(item_id: int = DEFAULT_ITEM) -> dict:
    """Age-aligned, rebased indices per league for one item (default Divine).
    day 0 = each league's first captured day; index = 100 × close / day0_close."""
    if item_id not in ITEMS:
        item_id = DEFAULT_ITEM
    with db.q() as c:
        rows = c.execute("SELECT league, day, close FROM league_daily WHERE item_id=? AND close>0 ORDER BY league, day",
                         (item_id,)).fetchall()
    by_league: dict[str, list] = {}
    for r in rows:
        by_league.setdefault(r["league"], []).append((r["day"], r["close"]))
    current = set(db.kv_get("lh_current", []))
    leagues = []
    for name, series in by_league.items():
        series.sort()
        base = series[0][1]
        if not base:
            continue
        pts = [{"age": i, "day": d, "index": round(100.0 * cl / base, 2)} for i, (d, cl) in enumerate(series)]
        leagues.append({
            "league": name, "days": len(pts), "points": pts,
            "final_index": pts[-1]["index"], "current": name in current,
        })
    leagues.sort(key=lambda x: (not x["current"], -x["days"]))
    return {"item_id": item_id, "item_name": ITEMS[item_id],
            "leagues": leagues, "items": [{"id": k, "name": v} for k, v in ITEMS.items()]}
