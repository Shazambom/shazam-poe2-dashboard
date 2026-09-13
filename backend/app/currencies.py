"""Currency registry.

Two id spaces exist:
  * trade ids  — short strings used by the trade site / exchange API ("chaos", "divine").
  * metadata ids — GGG item paths used by the hourly digest
    ("Metadata/Items/Currency/CurrencyRerollRare").

The registry loads the trade site's static currency list, then links metadata ids to
trade ids using (1) a seed override file and (2) a heuristic match between the
metadata id's last path segment and the icon filename. Unmatched ids are kept so
the UI can surface them for manual mapping.
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
        self._seed_overrides: dict[str, str] = {}
        self._load_seed()
        self._apply_overrides()

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
        user_overrides = db.kv_get("meta_overrides", {})
        self._seed_overrides.update(user_overrides)

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
        self._apply_overrides()
        log.info("registry loaded %d trade currencies", len(self.by_id))

    def _apply_overrides(self) -> None:
        for meta, tid in self._seed_overrides.items():
            self._link(meta, tid)

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

    def resolve_meta(self, meta: str) -> str | None:
        """Return the trade id for a metadata id, learning heuristically if needed."""
        if meta in self.meta_to_trade:
            return self.meta_to_trade[meta]
        tail = meta.rsplit("/", 1)[-1].lower()
        for tid, cur in self.by_id.items():
            if not cur.icon:
                continue
            m = self._icon_stem.search(cur.icon)
            if m and m.group(1).lower() == tail:
                self._link(meta, tid)
                return tid
        self.unmapped_meta.add(meta)
        return None

    def set_override(self, meta: str, tid: str) -> None:
        overrides = db.kv_get("meta_overrides", {})
        overrides[meta] = tid
        db.kv_set("meta_overrides", overrides)
        self._seed_overrides[meta] = tid
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
