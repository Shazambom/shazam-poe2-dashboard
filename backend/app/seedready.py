"""Is the seed's newest day final for every tracked item? (docs/bugs/2026-09-28-partial-sync-data.md)

poe2scout's category listing (`/Currencies/ByCategory`) carries each item's last few daily prices:
`PriceLogs[].Price` is our `league_daily.average` and `.Quantity` our `.volume`. So one listing per
category tells us, item by item, whether the rows we store are what poe2scout now reports.

A day is final upstream once poe2scout has moved past it (most items already report a later day). An
item's row for a final day is final when it matches the listing, or when we fetched the item after the
day was final and the listing has not changed since (the two views need not agree for every item, and
without this such an item would be fetched every hour). The seed ends each current league on the latest
day that is final for every tracked item; the items holding it back are the only ones worth fetching.
"""
from __future__ import annotations

import calendar
import hashlib
import json
import logging
import time
import urllib.parse
from dataclasses import dataclass, field
from datetime import date, timedelta

import httpx

from . import db, leaguehistory as lh

log = logging.getLogger("poe2arb.seedready")

REL_TOL = 1e-5          # the listing's Price is a float32 of our stored double


def _prev(day: str) -> str:
    return (date.fromisoformat(day) - timedelta(days=1)).isoformat()


def final_through(listing: dict) -> str | None:
    """The newest day poe2scout has finished in this league: the latest day on which most of the items
    that traded that day already report a later one. poe2scout finishes a day for every item at once
    (its 09-28 stall stopped every item at the same hour, and items fetched after a day closed still
    matched it hours later), so a league-wide judgement is the right evidence. An item without a
    next-day row has usually just not traded yet (measured 2026-09-29: such items traded ~10 a day
    against ~1,000 for the rest, and their finished days were complete). The assumption is watched,
    not trusted: a finished day that poe2scout later changes is counted by the poll."""
    days = sorted({d for rows in listing.values() for d in rows}, reverse=True)
    for d in days:
        traded = [rows for rows in listing.values() if d in rows]
        if sum(1 for rows in traded if max(rows) > d) * 2 > len(traded):
            return d
    return None


def fingerprint(days: dict, through: str) -> dict:
    """What poe2scout reported for an item, day by day, up to `through`. Days after it are unfinished
    and change all the time, so they are left out."""
    return {d: [v[0], v[1]] for d, v in sorted(days.items()) if d <= through}


def _unchanged(days: dict, rec: dict, through: str) -> bool:
    """poe2scout still reports what it did when the item was fetched, for every final day it lists.
    The listing is a rolling week, so a day that slid out of it is not a change."""
    fp = rec.get("fp") or {}
    return all(d in fp and [v[0], v[1]] == fp[d] for d, v in days.items() if d <= through)


def _match(listed, stored) -> bool:
    if listed is None or stored is None:
        return listed is None and stored is None
    (pa, qa), (pb, qb) = listed, stored
    if pa is None or pb is None or qa is None or qb is None:
        return pa == pb and qa == qb
    return int(qa) == int(qb) and abs(pa - pb) <= REL_TOL * max(abs(pa), abs(pb), 1e-12)


def _days(first: str, last: str) -> list[str]:
    a, b = date.fromisoformat(first), date.fromisoformat(last)
    return [(a + timedelta(days=i)).isoformat() for i in range((b - a).days + 1)]


@dataclass
class Assessment:
    through: str | None                 # newest day poe2scout has finished
    cut: str | None                     # newest day the seed may carry (None: none verified)
    stale: set = field(default_factory=set)   # tracked items whose rows are not final


def assess(listing: dict, stored: dict, fingerprints: dict) -> Assessment:
    """listing: {item: {day: (price, quantity)}} from poe2scout; stored: {item: {day: (average,
    volume)}} for every TRACKED item (an item with no recent rows maps to {}); fingerprints: {item:
    {"fp", "through"}} recorded when the item was last fetched by the seed poll."""
    through = final_through(listing)
    if through is None:
        return Assessment(None, None, set())
    listed = [d for days in listing.values() for d in days]
    window = _days(min(listed), through) if listed and min(listed) <= through else []
    bad_days: set = set()
    stale: set = set()
    for item, rows in stored.items():
        up = listing.get(item, {})
        rec = fingerprints.get(item)
        vouched = rec["through"] if rec and rec.get("vouch", True) and _unchanged(up, rec, rec["through"]) else None
        for d in window:
            if vouched is not None and d <= vouched:
                continue
            if not _match(up.get(d), rows.get(d)):
                stale.add(item)
                bad_days.add(d)
    if not window:
        return Assessment(through, None, stale)
    if not bad_days:
        return Assessment(through, through, stale)
    first_bad = min(bad_days)
    return Assessment(through, _prev(first_bad), stale)


def changed_after_final(listing: dict, stored: dict, fetched_at: dict) -> set:
    """Items poe2scout changed after finishing a day: fetched more than a full day after that day ended
    (poe2scout was surely past it), yet the row no longer matches. Expected to stay empty; if not,
    the league-wide `final_through` judgement is too early and must be revisited."""
    through = final_through(listing)
    if through is None:
        return set()
    out = set()
    for item, rows in stored.items():
        up, at = listing.get(item, {}), fetched_at.get(item, 0)
        for d in {*up, *rows}:
            if d <= through and at >= calendar.timegm(time.strptime(d, "%Y-%m-%d")) + 2 * 86400 \
                    and not _match(up.get(d), rows.get(d)):
                out.add(item)
                break
    return out


def to_fetch(a: Assessment, listing: dict, fingerprints: dict) -> set:
    """The stale items worth a request: all of them, except one already fetched against exactly what
    poe2scout reports now (fetching it again would return the same thing)."""
    return {i for i in a.stale
            if not (a.through and (rec := fingerprints.get(i)) and _unchanged(listing.get(i, {}), rec, a.through))}


# ------------------------------------------------------------------------------------------ poll
# Runs on the server that publishes the seed (the hourly loop in main.py, gated there), never on a
# desktop client. Everything it knows lives in the DB and kv, so a restart repeats no work.

async def _listing(name: str) -> dict:
    """{item: {day: (price, quantity)}} for every item poe2scout lists in the league. Raises if any
    category or page fails: a partial listing would make missing items look untraded."""
    cats = await lh._get(f"/Leagues/{urllib.parse.quote(name)}/Items/Categories")
    out: dict = {}
    for cat in [c.get("ApiId") for c in cats.get("CurrencyCategories", []) if c.get("ApiId")]:
        for x in await lh.category_items(name, cat):
            if not x.get("ItemId"):
                continue
            days = out.setdefault(x["ItemId"], {})
            for p in x.get("PriceLogs") or []:
                if p and p.get("Time"):
                    days[p["Time"][:10]] = (p.get("Price"), p.get("Quantity"))
    return out


def _stored(name: str, since: str | None) -> dict:
    """{item: {day: (average, volume)}} from `since` on, for every item the league holds history for
    (the items the seed would ship), {} for one with nothing that recent."""
    with db.q() as c:
        tracked = {r[0]: {} for r in c.execute("SELECT DISTINCT item_id FROM league_daily WHERE league=?", (name,))}
        if since:
            for iid, day, avg, vol in c.execute(
                    "SELECT item_id, day, average, volume FROM league_daily WHERE league=? AND day>=?", (name, since)):
                tracked[iid][day] = (avg, vol)
    return tracked


def _fingerprints(name: str) -> dict:
    prefix = f"seed_fp:{name}:"
    with db.q() as c:
        rows = c.execute("SELECT key, value FROM kv_ops WHERE key LIKE ?", (prefix + "%",)).fetchall()
    out = {}
    for key, value in rows:
        try:
            out[int(key[len(prefix):])] = json.loads(value)
        except (ValueError, TypeError):
            continue
    return out


async def poll_league(name: str) -> dict:
    """Read the league's listing, fetch only the items holding its seed back, record the cut."""
    prev = db.kv_get(f"seed_cut:{name}")
    try:
        listing = await _listing(name)
        if prev and prev.get("day") and final_through(listing) is None:
            raise ValueError("listing has no finished day (poe2scout answered with nothing)")
    except Exception as exc:
        log.warning("seed poll %s: listing unusable, keeping the last cut: %s", name, exc)
        return {"error": str(exc), "fetched": 0}
    since = min((d for days in listing.values() for d in days), default=None)
    fps = _fingerprints(name)
    stored = _stored(name, since)
    a = assess(listing, stored, fps)
    revised = changed_after_final(listing, stored, lh._marks(name)[1])
    if revised:
        log.warning("seed poll %s: poe2scout changed a finished day for %d item(s): %s",
                    name, len(revised), sorted(revised)[:20])
    fetched, failed = 0, 0
    for item in sorted(to_fetch(a, listing, fps)):
        gone = False
        try:
            n = await lh.fetch_item(name, item, current=True)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 404:
                failed += 1
                log.warning("seed poll %s/%s: fetch failed, retrying next poll: %s", name, item, exc)
                continue
            gone, n = True, 0                    # poe2scout has no history for it: confirmed, not retried
        except Exception as exc:
            failed += 1
            log.warning("seed poll %s/%s: fetch failed, retrying next poll: %s", name, item, exc)
            continue
        fetched += 1
        if a.through:
            # An empty answer for an item poe2scout lists is not proof of anything: remember what was
            # asked (so it is not asked again unchanged) without vouching for the stored rows.
            db.kv_set(f"seed_fp:{name}:{item}", {"fp": fingerprint(listing.get(item, {}), a.through),
                                                 "through": a.through, "vouch": gone or n > 0})
    if fetched:
        a = assess(listing, _stored(name, since), _fingerprints(name))
    cut = a.cut
    if failed and prev and prev.get("day") and (cut is None or cut < prev["day"]):
        cut = prev["day"]                        # a failed request never costs every item its days
    db.kv_set(f"seed_cut:{name}", {"day": cut, "through": a.through, "stale": sorted(a.stale),
                                   "revised": sorted(revised), "at": time.time()})
    log.info("seed poll %s: through=%s cut=%s fetched=%d failed=%d still_stale=%d revised=%d",
             name, a.through, cut, fetched, failed, len(a.stale), len(revised))
    return {"cut": cut, "through": a.through, "fetched": fetched, "failed": failed, "stale": sorted(a.stale),
            "revised": sorted(revised)}


async def poll() -> dict:
    """One poll of every current league. Waits for a running crawl rather than racing it (they share
    poe2scout's rate budget and the same rows)."""
    leagues = [l["Value"] for l in await lh._leagues() if l.get("IsCurrent") and l.get("Value")]
    async with lh._backfill_lock:
        res = {name: await poll_league(name) for name in leagues}
    # What the exporter trusts: which leagues are current per this poll, and when it ran.
    db.kv_set("seed_poll", {"at": time.time(), "leagues": leagues})
    return res
