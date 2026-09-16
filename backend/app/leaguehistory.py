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

import asyncio
import logging
import re
import time
import urllib.parse

from . import cache, db, gateway, marketseries

log = logging.getLogger(__name__)

_slug = lambda s: re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")
_scout_cache: dict[str, tuple[float, dict]] = {}


def scout_prices(league: str) -> dict[str, float]:
    """Latest poe2scout close (in Exalted) per currency for `league`, keyed by BOTH
    lowercased name and slug — so the board can price currencies the currency-exchange
    graph doesn't cover (e.g. Hinekora's Lock, omens). 5-min TTL cached."""
    return cache.memo(_scout_cache, league, 300, lambda: _scout_prices(league))


def scout_lookup(table: dict, trade_id: str):
    """Look a registry trade id up in a poe2scout name/slug-keyed table (scout_prices /
    scout_history): by the registry's display name first, then by the id itself."""
    from .currencies import registry
    return table.get(str(registry.name(trade_id)).lower()) or table.get(str(trade_id).lower())


def _scout_prices(league: str) -> dict[str, float]:
    out: dict[str, float] = {}
    try:
        with db.q() as c:
            rows = c.execute(
                """SELECT im.name, ld.close FROM league_daily ld
                   JOIN item_meta im ON im.item_id = ld.item_id
                   JOIN (SELECT item_id, MAX(day) md FROM league_daily WHERE league = ? GROUP BY item_id) mx
                     ON mx.item_id = ld.item_id AND mx.md = ld.day
                   WHERE ld.league = ?""",
                (league, league),
            ).fetchall()
        for name, close in rows:
            if close is None or not name:
                continue
            out[name.lower()] = close
            out[_slug(name)] = close
    except Exception as e:  # never let a price lookup break the board
        log.warning("scout_prices(%s) failed: %s", league, e)
    return out


_shist_cache: dict[str, tuple[float, dict]] = {}


def scout_history(league: str, days: int = 60) -> dict[str, list]:
    """Per-currency daily price trend (Close, in Exalted) for `league` from poe2scout,
    keyed by lowercased name AND slug — so the board can draw a sparkline for currencies
    the GGG exchange digest doesn't cover (Hinekora's Lock, omens, …). Each value is a
    list of {t: epoch_seconds, v: close}, oldest→newest. 5-min TTL cached."""
    return cache.memo(_shist_cache, league, 300, lambda: _scout_history(league, days))


def _scout_history(league: str, days: int) -> dict[str, list]:
    series: dict[str, list] = {}
    try:
        with db.q() as c:
            rows = c.execute(
                """SELECT im.name, ld.day, ld.close FROM league_daily ld
                   JOIN item_meta im ON im.item_id = ld.item_id
                   WHERE ld.league = ? AND ld.close IS NOT NULL
                   ORDER BY ld.day""",
                (league,),
            ).fetchall()
        for name, day, close in rows:
            if not name:
                continue
            try:
                t = marketseries.day_to_epoch(day)
            except (ValueError, TypeError):
                continue
            pt = {"t": t, "v": close}
            series.setdefault(name.lower(), []).append(pt)
            series.setdefault(_slug(name), []).append(pt)
    except Exception as e:
        log.warning("scout_history(%s) failed: %s", league, e)
    for k in series:
        series[k] = series[k][-days:]
    return series

_backfill_lock = asyncio.Lock()   # only one backfill crawl at a time (shared rate limit)

# Live backfill progress, surfaced to the UI so a cold start streams in visibly
# ("building your dashboard…") instead of showing a blank/stale board.
progress: dict = {
    "running": False, "phase": "idle", "league": None,
    "league_done": 0, "league_total": 0, "leagues_done": 0, "leagues_total": 0,
    "started": None, "updated": None, "last": None,
}


BASE = "https://api.poe2scout.com/poe2"
# Item ids are global across leagues (poe2scout), priced in the league base (Exalted).
# Mirror and Hinekora are the hardest inflation anchors; Divine is the densest and
# the default. (Hinekora has no Dawn-of-the-Hunt data — it's a newer currency.)
ITEMS = {a.item_id: a.name for a in marketseries.ANCHORS.values()}
DEFAULT_ITEM = marketseries.ANCHORS["divine"].item_id
MIRROR_ITEM = marketseries.ANCHORS["mirror"].item_id   # numeraire for the economy market cap

# Hold leaderboard tracks EVERY currency category poe2scout exposes (discovered live
# from /Items/Categories). Items below the price floor are dust and skipped so the
# commodity tails (e.g. 140+ cheap runes) don't drown the board. This fallback list
# is only used if the category-discovery call fails.
CATEGORIES = ["currency", "ritual", "essences", "fragments", "delirium", "breach",
              "uncutgems", "abyss", "ultimatum", "expedition", "verisium", "runes",
              "lineagesupportgems", "idol", "vaultkeys", "incursion", "vaal"]
PRICE_FLOOR_EX = 5.0
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


def _stored_counts() -> dict[tuple[str, int], int]:
    """One grouped read of stored day-counts per (league, item) — avoids a COUNT(*)
    probe per item during backfill."""
    with db.q() as c:
        rows = c.execute("SELECT league, item_id, COUNT(*) n FROM league_daily GROUP BY league, item_id").fetchall()
    return {(r["league"], r["item_id"]): r["n"] for r in rows}


async def _currency_item_ids(league: str) -> list[int]:
    """All item ids in the 'currency' category for a league — the set we sum over
    for the economy market cap."""
    enc = urllib.parse.quote(league)
    data = await _get(f"/Leagues/{enc}/Currencies/ByCategory?category=currency&perPage=250")
    return [x["ItemId"] for x in data.get("Items", []) if x.get("ItemId")]


async def _category_apiids(league: str) -> list[str]:
    """Every currency category poe2scout exposes for a league (live discovery);
    falls back to the static CATEGORIES list if the call fails."""
    try:
        data = await _get(f"/Leagues/{urllib.parse.quote(league)}/Items/Categories")
        cats = [c.get("ApiId") for c in data.get("CurrencyCategories", []) if c.get("ApiId")]
        return cats or CATEGORIES
    except Exception as exc:
        log.warning("poe2scout categories %s failed: %s", league, exc)
        return CATEGORIES


async def _universe(league: str) -> set[int]:
    """Item ids to track for a league: the named anchors plus everything in EVERY
    currency category above the price floor. Also upserts item_meta (name, category)
    — global ids, so any league's crawl fills the map."""
    ids = set(ITEMS)
    meta = []
    bridge_new: dict[str, str] = {}   # GGG BaseItemTypeId -> trade ApiId (authoritative)
    enc = urllib.parse.quote(league)
    for cat in await _category_apiids(league):
        try:
            data = await _get(f"/Leagues/{enc}/Currencies/ByCategory?category={cat}&perPage=250")
        except Exception as exc:
            log.warning("poe2scout category %s/%s failed: %s", league, cat, exc)
            continue
        for x in data.get("Items", []):
            iid = x.get("ItemId")
            if not iid:
                continue
            meta.append((iid, x.get("Text") or str(iid), cat))
            # poe2scout hands us the exact GGG metadata id (BaseItemTypeId) next to the trade
            # ApiId — the authoritative bridge the digest needs to key markets by trade id.
            bt, api = x.get("BaseItemTypeId"), x.get("ApiId")
            if bt and api:
                bridge_new[bt] = api
            if iid in ITEMS or (x.get("CurrentPrice") or 0) >= PRICE_FLOOR_EX:
                ids.add(iid)
    if meta:
        with db.tx() as c:
            c.executemany("INSERT OR REPLACE INTO item_meta(item_id, name, category) VALUES (?,?,?)", meta)
    if bridge_new:
        _merge_meta_bridge(bridge_new)
    return ids


def _merge_meta_bridge(new: dict[str, str]) -> None:
    """Merge freshly-crawled metadata→trade mappings into the authoritative bridge kv (`meta_bridge`,
    operational → ships in the market snapshot per db-maintenance.md), then refresh the registry and
    drop graph caches so newly-mapped currencies enter the exchange graph immediately."""
    changed = 0

    def apply(cur):
        nonlocal changed
        cur = dict(cur or {})
        changed = sum(1 for bt, api in new.items() if cur.get(bt) != api)
        cur.update(new)
        return cur
    cur = db.kv_update("meta_bridge", apply, {})
    if changed:
        from .currencies import registry
        registry.load_bridge()
        from . import arbitrage   # lazy: arbitrage imports this module (the one genuine cycle)
        arbitrage.invalidate_caches()
    log.info("meta_bridge: %d total mappings (%d new/changed this pass)", len(cur), changed)


async def backfill(force: bool = False, full: bool = True) -> dict:
    """Pull daily history for the target leagues × items into league_daily. Past
    leagues are fetched once; current leagues refresh on a 12h cadence.

    full=True fetches every currency item (needed for the economy market cap);
    full=False fetches only the named anchors (fast — used on a cold cross() call).

    Only one crawl runs at a time (they share the poe2scout rate limit); overlapping
    callers return immediately rather than queueing for minutes."""
    if _backfill_lock.locked() and not force:
        return {"skipped": "backfill already running"}
    async with _backfill_lock:
        fetched = {}
        progress.update({"running": True, "phase": "leagues", "started": time.time(),
                         "updated": time.time(), "league": None, "last": None,
                         "league_done": 0, "league_total": 0, "leagues_done": 0, "leagues_total": 0})
        try:
            leagues = await _leagues()
        except Exception as exc:
            progress.update({"running": False, "phase": "error", "updated": time.time()})
            log.warning("poe2scout leagues fetch failed: %s", exc)
            return {"error": str(exc)}
        progress["leagues_total"] = len(leagues)
        db.kv_set("lh_current", [l["Value"] for l in leagues if l.get("IsCurrent") and l.get("Value")])
        stored = _stored_counts()
        for li, lg in enumerate(leagues):
            name, current = lg.get("Value"), bool(lg.get("IsCurrent"))
            if not name:
                continue
            item_ids = set(ITEMS)
            if full:
                try:
                    item_ids = await _universe(name)
                except Exception as exc:
                    log.warning("poe2scout universe %s failed: %s", name, exc)
            progress.update({"league": name, "league_total": len(item_ids), "league_done": 0,
                             "leagues_done": li, "phase": "crawling", "updated": time.time()})
            for item_id in item_ids:
                progress["league_done"] += 1
                progress["updated"] = time.time()
                complete = db.kv_get(f"lh_complete:{name}:{item_id}", False)
                # A past league marked complete (full history captured) is final → skip.
                # Partial stores (never marked complete) and current→past transitions
                # are re-fetched. Current leagues refresh on the 12h cadence.
                if complete and not force:
                    continue
                if current and stored.get((name, item_id)) and not force:
                    if time.time() - db.kv_get(f"lh_fetch:{name}:{item_id}", 0) < REFRESH_S:
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
                    # A past league with no more pages is fully captured — mark it final.
                    if not current and not data.get("HasMore"):
                        db.kv_set(f"lh_complete:{name}:{item_id}", True)
                    fetched[f"{name}/{item_id}"] = len(rows)
        _cache.clear()   # fresh data → drop cross()/marketcap() caches
        progress.update({"running": False, "phase": "done", "updated": time.time(),
                         "leagues_done": len(leagues)})
        return {"fetched": fetched, "leagues": len(leagues)}


# cross()/marketcap() only change on the 12h backfill; cache their aggregation
# (cleared by backfill on new data).
_cache: dict[str, dict] = {}
_CACHE_TTL_S = 600


def _cached(key: str, build):
    return cache.memo(_cache, key, _CACHE_TTL_S, build)


def _finalize(leagues: list[dict]) -> list[dict]:
    leagues.sort(key=lambda x: (not x["current"], -x["days"]))
    return leagues


def cross(item_id: int = DEFAULT_ITEM) -> dict:
    """Age-aligned, rebased indices per league for one item (default Divine). age =
    real days since each league's first captured day; index = 100 × close / day0_close."""
    if item_id not in ITEMS:
        item_id = DEFAULT_ITEM

    def build():
        with db.q() as c:
            rows = marketseries.item_rows(c, item_id)
        by_league: dict[str, list] = {}
        for r in rows:
            by_league.setdefault(r[0], []).append((r[1], r[2]))
        current = set(db.kv_get(marketseries.CURRENT_LEAGUES_KEY, []))
        leagues = []
        for name, series in by_league.items():
            series.sort()
            day0, base = series[0][0], series[0][1]
            if not base:
                continue
            pts = [{"age": marketseries.league_age(d, day0), "day": d, "index": round(100.0 * cl / base, 2)} for d, cl in series]
            leagues.append({
                "league": name, "days": pts[-1]["age"] + 1, "points": pts,
                "final_index": pts[-1]["index"], "current": name in current,
            })
        return {"item_id": item_id, "item_name": ITEMS[item_id],
                "leagues": _finalize(leagues), "items": [{"id": k, "name": v} for k, v in ITEMS.items()]}

    return _cached(f"cross:{item_id}", build)


def marketcap() -> dict:
    """Economy size per league, in Mirrors: the total value TRADED per day across all
    currencies (Σ volume × price, in Exalted) converted to Mirrors via that day's
    Mirror price. This is traded throughput (GDP-like), not a supply-based cap — total
    minted supply isn't observable. Age-aligned per league, plus a cumulative total."""
    def build():
        with db.q() as c:
            rows = marketseries.read_rows(c)          # close>0, ORDER BY league, day
        # per league: {day: total_exalted_traded}, and {day: mirror_price}
        traded: dict[str, dict[str, float]] = {}
        mirror: dict[str, dict[str, float]] = {}
        for lg, item_id, day, close, volume in rows:
            if not volume or volume <= 0:
                continue
            traded.setdefault(lg, {}).setdefault(day, 0.0)
            traded[lg][day] += close * volume
            if item_id == MIRROR_ITEM:
                mirror.setdefault(lg, {})[day] = close
        current = set(db.kv_get(marketseries.CURRENT_LEAGUES_KEY, []))
        leagues = []
        for name, by_day in traded.items():
            days = sorted(by_day)
            day0, mp, last_price = days[0], mirror.get(name, {}), None
            pts, cum = [], 0.0
            for d in days:
                price = mp.get(d) or last_price          # carry the last Mirror price over gaps
                last_price = price or last_price
                if not price:
                    continue                              # no Mirror price yet → skip early days
                val = by_day[d] / price                   # traded value that day, in Mirrors
                cum += val
                pts.append({"age": marketseries.league_age(d, day0), "day": d, "mirrors": round(val, 2), "cum": round(cum, 2)})
            if not pts:
                continue
            leagues.append({
                "league": name, "days": pts[-1]["age"] + 1, "points": pts,
                "total_mirrors": round(cum, 2), "latest_mirrors": pts[-1]["mirrors"],
                "current": name in current,
            })
        return {"unit": "Mirror of Kalandra", "leagues": _finalize(leagues)}

    return _cached("marketcap", build)
