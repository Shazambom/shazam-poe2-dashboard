"""The exchange's items, named the game's way: `meta_catalog` (kv_ops, rides the seed).

The hourly digest keys markets by GGG metadata id; the registry could name an id only through the
poe2scout bridge, the seed map, a user override or an icon-filename guess, so items like Raven's
Reflection traded heavily and were unpickable and unpriced (bug report FY0M4R, 2026-10-02). This
builds, on shazam (`modpool.refresh`), metadata id → trade id from the game's item table (repoe
base_items) and the trade site's item list (`trade_static_cache`):
- the trade id is the trade-site entry with the item's EXACT name; the art path only breaks a tie
  between entries of that name. Art alone never decides (Thaumaturgic Flux levels share one art);
- an item the trade site does not list gets an id made the trade site's way from its name, its game
  name, its exchange category and its icon — poe2db's copy of the game art, fetched here and carried
  as data, so installs contact no new host;
- an id that would collide with a different trade-site item is left out; the bridge's ids are the
  bridge's. Installs only read the result (`currencies.Registry`)."""
from __future__ import annotations

import base64
import binascii
import json
import logging
import re

from . import db, gamedata

log = logging.getLogger("poe2arb.catalog")

KEY = "meta_catalog"
ICON_CDN = "https://cdn.poe2db.tw/image/"
_GEN = re.compile(r"^/gen/image/([A-Za-z0-9_-]+)/")


def art_of(image: str | None) -> str | None:
    """The game art path inside a trade-site icon path (/gen/image/<base64 JSON>/<hash>/<file>)."""
    m = _GEN.match(image or "")
    if not m:
        return None
    b = m.group(1)
    try:
        return json.loads(base64.urlsafe_b64decode(b + "=" * (-len(b) % 4)))[2]["f"]
    except (binascii.Error, ValueError, IndexError, KeyError, TypeError):
        return None


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower().replace("'", "")).strip("-")


def _art(base: dict) -> str:
    return (base.get("visual_identity") or {}).get("dds_file", "").removesuffix(".dds")


def icon_source(art: str) -> str:
    return f"{ICON_CDN}{art}.webp"


def build(bases: dict, static: dict, metas, bridged: set, categories: dict) -> dict:
    entries = [e for g in (static or {}).get("result", []) for e in g.get("entries", []) if e.get("id")]
    by_name: dict[str, list[dict]] = {}
    for e in entries:
        by_name.setdefault(e.get("text"), []).append(e)
    ids = {e["id"] for e in entries}
    out: dict[str, dict] = {}
    for meta in sorted(set(metas)):
        b = bases.get(meta)
        if meta in bridged or not b or not b.get("name"):
            continue
        named = by_name.get(b["name"], [])
        if len(named) > 1:
            art = _art(b).removeprefix("Art/")
            named = [e for e in named if art_of(e.get("image")) == art]
        if len(named) == 1:
            out[meta] = {"id": named[0]["id"]}
        elif not named:
            tid = _slug(b["name"])
            if tid and tid not in ids:
                out[meta] = {"id": tid, "name": b["name"],
                             "category": (categories.get(meta) or {}).get("category") or b.get("item_class"),
                             "art": _art(b)}
    return out


def _digest_metas() -> list[str]:
    with db.q() as c:
        return [r[0] for r in c.execute("SELECT cur_a FROM digest_markets UNION SELECT cur_b FROM digest_markets")]


async def refresh(bases: dict, metas=None, categories=None, max_age: int = 86400) -> str | None:
    """Rebuild `meta_catalog`. Returns an error to report, or None. Without the trade list nothing
    changes; an icon that cannot be fetched keeps the item's last icon."""
    static = db.kv_get("trade_static_cache") or {}
    if not static.get("result"):
        return "catalog: no trade list stored; kept the last catalog"
    cat = build(bases, static, metas if metas is not None else _digest_metas(), set(db.kv_get("meta_bridge", {}) or {}),
                categories if categories is not None else (db.kv_get("gold_fees_meta", {}) or {}))
    last = db.kv_get(KEY, {}) or {}
    missing = 0
    for meta, e in cat.items():
        art = e.pop("art", None)
        if not art:
            continue
        try:
            data = await gamedata._get(icon_source(art), "icon-" + re.sub(r"[^A-Za-z0-9]+", "_", art) + ".webp", max_age)
            e["icon"] = "data:image/webp;base64," + base64.b64encode(data).decode()
        except Exception as exc:
            missing += 1
            if (last.get(meta) or {}).get("icon"):
                e["icon"] = last[meta]["icon"]
            log.warning("catalog: icon for %s unavailable (%s)", meta, exc)
    db.kv_set(KEY, cat)
    log.info("catalog: %d exchange items named (%d not on the trade site), %d icons missing",
             len(cat), sum(1 for e in cat.values() if "name" in e), missing)
    return None
