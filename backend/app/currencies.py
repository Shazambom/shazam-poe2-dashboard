"""Currency registry.

Two id spaces exist:
  * trade ids  — short strings used by the trade site / exchange API ("chaos", "divine").
  * metadata ids — GGG item paths used by the hourly digest
    ("Metadata/Items/Currency/CurrencyRerollRare").

Metadata ids are linked to trade ids in this precedence (low → high):
  1. seed override file (`data/currency_map.json`) — a small offline fallback.
  2. **poe2scout bridge** (`meta_bridge` in kv_ops) — AUTHORITATIVE. poe2scout returns
     each currency's GGG `BaseItemTypeId` alongside its trade `ApiId`, giving an exact
     metadata→trade map; the crawl persists it. This is the real source of truth.
  3. user overrides (`meta_overrides` kv) — an explicit human mapping wins over everything.
  4. fallback heuristic (icon-filename-stem / tiered suffix) — only for ids none of the
     above cover (e.g. league-mechanic items poe2scout doesn't list). Anything still
     unmatched is kept in `unmapped_meta` and logged so gaps are visible, never silent.
"""
from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, field

from . import db, gateway
from .config import SEED_DIR, TRADE_STATIC_URL

log = logging.getLogger(__name__)


@dataclass
class Currency:
    id: str  # trade id
    name: str
    icon: str | None = None
    category: str | None = None
    metadata_ids: list[str] = field(default_factory=list)


class Registry:
    def __init__(self) -> None:
        self.by_id: dict[str, Currency] = {}
        self.meta_to_trade: dict[str, str] = {}
        self.unmapped_meta: set[str] = set()
        self.loaded_at: float | None = None
        self._seed_overrides: dict[str, str] = {}   # currency_map.json (offline fallback)
        self._bridge: dict[str, str] = {}           # kv meta_bridge (poe2scout, authoritative)
        self._user_overrides: dict[str, str] = {}   # kv meta_overrides (human, highest)
        self._load_seed()
        self.load_bridge()                          # db is booted at import; safe to read kv

    # ---------------------------------------------------------------- seed
    def _load_seed(self) -> None:
        path = SEED_DIR / "currency_map.json"
        if path.exists():
            data = json.loads(path.read_text())
            self._seed_overrides = data.get("meta_to_trade", {})
            for tid, entry in data.get("currencies", {}).items():
                self.by_id[tid] = Currency(
                    id=tid,
                    name=entry.get("name", tid),
                    icon=entry.get("icon"),
                    category=entry.get("category"),
                )
        self._user_overrides = db.kv_get("meta_overrides", {}) or {}

    def load_bridge(self) -> None:
        """(Re)load the authoritative poe2scout metadata→trade bridge from kv_ops (written by
        the crawl, shipped in the market snapshot) and rebuild all links. Call after a crawl."""
        self._bridge = db.kv_get("meta_bridge", {}) or {}
        self._rebuild_links()

    # -------------------------------------------------------------- static
    async def load_static(self) -> None:
        """Fetch /api/trade2/data/static and merge into the registry."""
        try:
            r = await gateway.request("GET", TRADE_STATIC_URL, policy="trade")
            r.raise_for_status()
            data = r.json()
        except Exception as exc:  # network is optional; seed still works
            log.warning("could not load trade static data: %s", exc)
            return

        for group in data.get("result", []):
            cat = group.get("label") or group.get("id")
            for entry in group.get("entries", []):
                tid = entry.get("id")
                if not tid:
                    continue
                cur = self.by_id.get(tid) or Currency(id=tid, name=entry.get("text", tid))
                cur.name = entry.get("text", cur.name)
                cur.icon = entry.get("image") or cur.icon
                cur.category = cur.category or cat
                self.by_id[tid] = cur
        self.loaded_at = time.time()
        self._rebuild_links()
        log.info("registry loaded %d trade currencies", len(self.by_id))

    def _rebuild_links(self) -> None:
        """Rebuild meta→trade links from all sources in precedence order (later wins):
        seed file < poe2scout bridge < user overrides. Clears learned/heuristic links and the
        negative cache so a freshly-loaded bridge re-evaluates previously-unmapped ids."""
        self.meta_to_trade.clear()
        self.unmapped_meta.clear()
        for source in (self._seed_overrides, self._bridge, self._user_overrides):
            for meta, tid in source.items():
                self._link(meta, tid)
        log.info("registry links rebuilt: seed=%d bridge=%d user=%d → %d metadata ids mapped",
                 len(self._seed_overrides), len(self._bridge), len(self._user_overrides),
                 len(self.meta_to_trade))

    def _link(self, meta: str, tid: str) -> None:
        self.meta_to_trade[meta] = tid
        cur = self.by_id.get(tid)
        if cur is None:
            cur = Currency(id=tid, name=tid)
            self.by_id[tid] = cur
        if meta not in cur.metadata_ids:
            cur.metadata_ids.append(meta)
        self.unmapped_meta.discard(meta)

    # ------------------------------------------------------------ mapping
    _icon_stem = re.compile(r"/([A-Za-z0-9_]+)\.png")

    def _stem_index(self) -> dict[str, str]:
        """icon filename stem -> trade id, rebuilt when the registry grows.
        Keeps resolve_meta O(1); the old per-call scan burned whole seconds per
        graph build once the registry held hundreds of currencies."""
        if getattr(self, "_stems_n", -1) != len(self.by_id):
            stems: dict[str, str] = {}
            for tid, cur in self.by_id.items():
                if cur.icon:
                    m = self._icon_stem.search(cur.icon)
                    if m:
                        stems.setdefault(m.group(1).lower(), tid)
            self._stems = stems
            self._stems_n = len(self.by_id)
        return self._stems

    def resolve_meta(self, meta: str) -> str | None:
        """Return the trade id for a metadata id, learning heuristically if needed."""
        if meta in self.meta_to_trade:
            return self.meta_to_trade[meta]
        if meta in self.unmapped_meta:      # negative cache: don't re-scan every call
            return None
        tid = self._stem_index().get(meta.rsplit("/", 1)[-1].lower())
        if tid:
            self._link(meta, tid)
            return tid
        # Tiered currencies: GGG appends 2/3 to the base metadata id for the
        # Greater/Perfect tiers (CurrencyAddModToMagic2 -> Greater Orb of
        # Augmentation). The trade site names them greater-/perfect- + base name.
        if meta[-1:] in ("2", "3") and not meta[-2:-1].isdigit():
            base_tid = self.resolve_meta(meta[:-1])
            if base_tid:
                slug = re.sub(r"[^a-z0-9]+", "-", self.by_id[base_tid].name.lower()).strip("-")
                cand = ("greater-" if meta.endswith("2") else "perfect-") + slug
                if cand in self.by_id:
                    self._link(meta, cand)
                    return cand
        self.unmapped_meta.add(meta)
        log.info("currency: no trade mapping for metadata id %s "
                 "(not in poe2scout bridge/seed/heuristic — its markets are excluded)", meta)
        return None

    def set_override(self, meta: str, tid: str) -> None:
        overrides = db.kv_get("meta_overrides", {}) or {}
        overrides[meta] = tid
        db.kv_set("meta_overrides", overrides)
        self._user_overrides[meta] = tid   # highest precedence
        self._link(meta, tid)

    def name(self, tid: str) -> str:
        cur = self.by_id.get(tid)
        return cur.name if cur else tid

    def to_json(self) -> dict:
        return {
            "loaded_at": self.loaded_at,
            "currencies": [
                {
                    "id": c.id,
                    "name": c.name,
                    "icon": c.icon,
                    "category": c.category,
                    "metadata_ids": c.metadata_ids,
                }
                for c in sorted(self.by_id.values(), key=lambda c: c.name)
            ],
            "unmapped_metadata_ids": sorted(self.unmapped_meta),
        }


registry = Registry()
