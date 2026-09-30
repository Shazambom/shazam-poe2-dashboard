"""Off-exchange conversions: disenchant / combine / reforge recipes.

A recipe consumes `inputs` and yields `outputs` (both {trade_id: qty}). They cost no
gold. Only single-input, single-output recipes become graph edges in the route
search (rate = out_qty / in_qty, input must be a whole multiple of in_qty).
Multi-input recipes are stored and shown, but flagged as not routable.

Where they come from (`edges()`; docs/bugs/2026-09-29-crafting-recipes-missing-from-routes.md):
- Disenchant — INTENDED, confirmed in-game by the owner 2026-09-30, not a bug: Greater orb -> 3 of
  its orb, Perfect orb -> 3 Greater. Orbs only. Derived from the currency names (`disenchant_recipes`).
- Reforge — the Reforging Bench's 3-to-1 list, parsed on shazam into kv_ops `bench_recipes` (rides
  the seed), minus essences (their bench output is random).
- The user's own recipes.json (the Recipes editor, `load`/`save`), which wins over a derived recipe
  with the same id. Derived recipes are never written into the user's file.
"""
from __future__ import annotations

import json
import logging
import shutil
import uuid

from .config import RECIPES_PATH, SEED_DIR

log = logging.getLogger(__name__)


def _ensure() -> None:
    if not RECIPES_PATH.exists():
        seed = SEED_DIR / "recipes.json"
        if seed.exists():
            shutil.copy(seed, RECIPES_PATH)
        else:
            RECIPES_PATH.write_text("[]")


def load() -> list[dict]:
    _ensure()
    data = json.loads(RECIPES_PATH.read_text())
    for r in data:
        r.setdefault("id", uuid.uuid4().hex[:8])
        r.setdefault("enabled", True)
        r.setdefault("kind", "combine")
        r["routable"] = len(r.get("inputs", {})) == 1 and len(r.get("outputs", {})) == 1
    return data


def save(data: list[dict]) -> list[dict]:
    clean = []
    for r in data:
        clean.append({
            "id": r.get("id") or uuid.uuid4().hex[:8],
            "name": r.get("name", ""),
            "kind": r.get("kind", "combine"),
            "inputs": {k: float(v) for k, v in (r.get("inputs") or {}).items() if float(v) > 0},
            "outputs": {k: float(v) for k, v in (r.get("outputs") or {}).items() if float(v) > 0},
            "enabled": bool(r.get("enabled", True)),
            "note": r.get("note", ""),
        })
    RECIPES_PATH.write_text(json.dumps(clean, indent=2))
    return load()


def derived() -> list[dict]:
    """The game's conversions, as recipes: the orb disenchants and the bench's reforges."""
    from . import db
    from .currencies import registry
    names = {cur.name: tid for tid, cur in registry.by_id.items()}
    return disenchant_recipes(names) + reforge_recipes(db.kv_get("bench_recipes", []) or [], names)


def edges() -> list[dict]:
    """Routable, enabled recipes as directed edges: the derived ones plus the user's own file, where
    the user's recipe wins over a derived one with the same id."""
    user = load()
    mine = {r["id"] for r in user}
    out = []
    for r in [r for r in derived() if r["id"] not in mine] + user:
        if not (r["enabled"] and r["routable"]):
            continue
        (src, in_q), = r["inputs"].items()
        (dst, out_q), = r["outputs"].items()
        if src == dst:
            continue
        out.append({"from": src, "to": dst, "rate": out_q / in_q, "lot": in_q,
                    "recipe_id": r["id"], "name": r["name"], "kind": r["kind"]})
    return out


def _recipe(kind: str, src: str, in_q: int, dst: str, out_q: int, name: str) -> dict:
    return {"id": f"{kind}:{src}", "name": name, "kind": kind, "inputs": {src: in_q}, "outputs": {dst: out_q},
            "enabled": True, "note": "", "routable": True}


def disenchant_recipes(names: dict[str, str]) -> list[dict]:
    """INTENDED behaviour, not a bug (owner, confirmed in-game 2026-09-30): a Greater orb disenchants
    into 3 of its orb, and a Perfect orb into 3 Greater. Orbs only: Jeweller's Orbs (no normal tier)
    and runes do not disenchant, and essences were never confirmed. A rule over the currency names
    (`names`: trade-site name -> trade id), so a new tiered orb needs no data."""
    out = []
    for name in names:
        base = name.removeprefix("Perfect ")
        if base == name or "Orb" not in base.split():
            continue
        tiers = [names.get(t) for t in (name, "Greater " + base, base)]
        if all(tiers):
            perfect, greater, normal = tiers
            out.append(_recipe("disenchant", perfect, 1, greater, 3, f"Disenchant {name}"))
            out.append(_recipe("disenchant", greater, 1, normal, 3, f"Disenchant Greater {base}"))
    return out


_last_dropped = [0]


def reforge_recipes(rows: list[dict], names: dict[str, str]) -> list[dict]:
    """The Reforging Bench's 3-to-1 list (kv_ops `bench_recipes`, modpool.bench_recipes_from) as
    recipes. Essences are left out: the bench turns 3 essences into a RANDOM essence (maxroll), so
    that row is no fixed conversion. A name the trade site does not list is dropped."""
    out, dropped = [], 0
    for r in rows:
        if "Essence" in r["from"] or "Essence" in r["to"]:
            continue
        src, dst = names.get(r["from"]), names.get(r["to"])
        if not (src and dst):
            dropped += 1
            continue
        out.append(_recipe("reforge", src, r["from_qty"], dst, r["to_qty"], f"Reforge {r['from_qty']}x {r['from']}"))
    if dropped != _last_dropped[0]:      # every graph build reads this; say it when it changes
        _last_dropped[0] = dropped
        log.info("bench recipes: %d with a name the trade site does not list", dropped)
    return out
