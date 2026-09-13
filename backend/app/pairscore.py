"""Which exchange pairs matter most, learned from the routes we rank.

Every route computation feeds its candidates in here. Each profitable loop
contributes to every exchange pair it uses, weighted by the loop's rank on margin
(value) and on margin per 1k gold, so pairs that keep showing up in the best loops
accumulate the highest score. An exponential decay keeps it current; the table is
persisted so restarts keep what was learned.

Used for: queue ordering within a priority tier, and choosing which haves get the
free padding slots of a batched request (ahead of raw digest volume).
"""
from __future__ import annotations

import time

from . import db

DECAY = 0.8          # applied once per observation batch
PERSIST_EVERY_S = 120

_scores: dict[tuple[str, str], float] = {}
_loaded = False
_last_persist = 0.0


def _load() -> None:
    global _loaded, _scores
    if _loaded:
        return
    raw = db.kv_get("pair_scores", {})
    _scores = {tuple(k.split(">", 1)): float(v) for k, v in raw.items() if ">" in k}
    _loaded = True


def observe(routes: list[dict]) -> None:
    """routes: candidate routes with margin_ref, margin_per_1k_gold, gold_free, pairs."""
    global _last_persist
    _load()
    winners = [r for r in routes if r.get("margin_ref", 0) > 0 and r.get("pairs")]
    if not winners:
        return
    by_value = sorted(winners, key=lambda r: r["margin_ref"], reverse=True)
    by_eff = sorted(winners, key=lambda r: (r["gold_free"], r["margin_per_1k_gold"] or 0), reverse=True)
    by_vel = sorted(winners, key=lambda r: (r.get("velocity_inf", False), r.get("velocity") or 0), reverse=True)
    contrib: dict[tuple[str, str], float] = {}
    for board, weight in ((by_vel, 2.0), (by_eff, 1.0), (by_value, 1.0)):   # velocity leads here too
        for rank, r in enumerate(board):
            for p in r["pairs"]:
                contrib[tuple(p)] = contrib.get(tuple(p), 0) + weight / (1 + rank)
    for k in list(_scores):
        _scores[k] *= DECAY
        if _scores[k] < 1e-4:
            del _scores[k]
    for k, v in contrib.items():
        _scores[k] = _scores.get(k, 0) + v
    if time.time() - _last_persist > PERSIST_EVERY_S:
        db.kv_set("pair_scores", {f"{a}>{b}": round(v, 5) for (a, b), v in _scores.items()})
        _last_persist = time.time()


def score(have: str, want: str) -> float:
    _load()
    return _scores.get((have, want), 0.0)


def ranked_haves(want: str) -> list[str]:
    """Haves for `want`, best-scoring first."""
    _load()
    return [h for (h, w), _ in sorted(_scores.items(), key=lambda kv: kv[1], reverse=True) if w == want]


def top(n: int = 30) -> list[dict]:
    _load()
    return [{"have": a, "want": b, "score": round(v, 4)}
            for (a, b), v in sorted(_scores.items(), key=lambda kv: kv[1], reverse=True)[:n]]
