"""Off-exchange conversions: disenchant / combine / reforge recipes.

A recipe consumes `inputs` and yields `outputs` (both {trade_id: qty}). They cost no
gold. Only single-input, single-output recipes become graph edges in the route
search (rate = out_qty / in_qty, input must be a whole multiple of in_qty).
Multi-input recipes are stored and shown, but flagged as not routable.
"""
from __future__ import annotations

import json
import shutil
import uuid

from .config import RECIPES_PATH, SEED_DIR


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


def edges() -> list[dict]:
    """Routable, enabled recipes as directed edges."""
    out = []
    for r in load():
        if not (r["enabled"] and r["routable"]):
            continue
        (src, in_q), = r["inputs"].items()
        (dst, out_q), = r["outputs"].items()
        if src == dst:
            continue
        out.append({"from": src, "to": dst, "rate": out_q / in_q, "lot": in_q,
                    "recipe_id": r["id"], "name": r["name"], "kind": r["kind"]})
    return out
