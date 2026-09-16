"""Route search and ranking — simple cycles starting and ending at a currency the user holds.

We size the route by the user's capital (× max_start_fraction) capped by the liquidity along the
path, simulate the fills step by step with whole-unit rounding, then score:
  margin        = units gained in the start currency
  margin_ref    = that gain valued in the reference currency
  value_ref     = total value that passes through the loop
  gold          = modelled exchange fees (recipes are free)
  margin/1k gold= gold efficiency
Results are served either whole (find_routes) or streamed (stream_routes) through one cache.
"""
from __future__ import annotations

import json
import math
from .. import cache, db, orderbook, pairscore
from .. import settings as settings_mod
from ..currencies import registry
from ..settings import get_settings
from . import graph
from .graph import INF, Edge, Graph, cycle_unit, route_cap, simulate

_route_cache: dict = {}      # search key -> (ts, orderbook version, result); see _cache_get/_cache_put
ROUTE_CACHE_MAX = 32


def _edge_list_id(edges: list[Edge]) -> str:
    """Stable id for an ordered edge list (loop or open path): 'a>b|b>c', recipe hops ':r'."""
    return "|".join(f"{e.src}>{e.dst}" + (":r" if e.kind == "recipe" else "") for e in edges)


def route_pairs(route_id: str) -> list[tuple[str, str]]:
    """Exchange pairs behind a route id like 'chaos>exalted|exalted>divine|divine>chaos'."""
    pairs = []
    for hop in route_id.split("|"):
        if hop.endswith(":r") or ">" not in hop:
            continue  # recipe hops cost no request
        a, b = hop.split(">", 1)
        pairs.append((a, b))
    return pairs


def _cache_key(filters: dict | None, start_currencies: list[str] | None) -> str:
    return json.dumps([filters or {}, start_currencies], sort_keys=True)


def _cache_get(key: str, s: dict) -> dict | None:
    """A fresh cached search result (same order-book version, within routes_cache_s), or None."""
    hit = cache.get(_route_cache, key, s["routes_cache_s"], version=orderbook.state["version"])
    return None if hit is cache.MISS else hit


def _cache_put(key: str, result: dict) -> None:
    cache.put(_route_cache, key, result, version=orderbook.state["version"], max_entries=ROUTE_CACHE_MAX)


def _graph_summary(g: Graph) -> dict:
    return {"nodes": len(g.adj), "edges": g.sources, "fee_table_size": len(g.fee_table)}


def _result(g: Graph, s: dict, f: dict, ref_value: dict, capital: dict, notional: bool,
            routes: list[dict], kept: list[dict], limit: int) -> dict:
    """The one search-result shape (served by /api/routes*, cached, and replayed by the stream)."""
    return {
        "routes": kept[:limit], "total_candidates": len(routes), "total_after_filters": len(kept),
        "graph": _graph_summary(g), "reference": s["reference"], "ref_values": ref_value,
        "capital": capital, "notional": notional, "filters": f,
    }


def find_routes(filters: dict | None = None, start_currencies: list[str] | None = None,
                use_cache: bool = True) -> dict:
    key = _cache_key(filters, start_currencies)
    hit = _cache_get(key, get_settings()) if use_cache else None
    if hit is not None:
        return {**hit, "cached": True}
    result = _find_routes(filters, start_currencies)
    _cache_put(key, result)
    return {**result, "cached": False}


MAX_CANDIDATES = 20000   # hard ceiling on simulated cycles per search


def _velocity(margin_ref: float, fill_hours: float | None, gold: float,
              gold_price_ref: float) -> float | None:
    """Velocity = margin NET of gold's value, per hour, per 1k gold.

    Gold is valued at the user's slider price (`gold_price_ref` = reference value of 1 gold) and
    SUBTRACTED from the margin, then the result is still divided by gold (the per-1k-gold
    efficiency weighting). The subtraction is what makes the gold-value slider actually move the
    arbitrage ranking — a pure divisor was a rank-invariant scalar; the division keeps a
    gold-thrifty loop weighted above a gold-heavy one at equal net margin. Gold-free loops rank
    best (INF); no turnover data -> None; a loop whose gold value exceeds its margin goes negative
    (net loss) and sinks."""
    if fill_hours is None or fill_hours <= 0:
        return None
    net = margin_ref - gold * gold_price_ref
    if gold <= 0:
        return INF if net > 0 else 0.0
    return net / fill_hours / gold * 1000


def _route_from(g: Graph, cyc: list[Edge], start: str, held: float, budget: float,
                ref_value: dict[str, float]) -> dict | None:
    # Size in whole tradable cycles: commit = (cycles) × (one-cycle unit), so the amount
    # always respects the trade ratios and never commits a partial lot.
    unit = cycle_unit(cyc)
    cycles = math.floor(route_cap(cyc, budget) / unit) if unit > 0 else 0
    amount = cycles * unit
    if amount < 1:
        return None
    sim = simulate(g, cyc, amount, ref_value)
    margin = sim["end_amount"] - amount
    margin_ref = margin * ref_value.get(start, 0.0)
    gold = sim["gold"]
    mp1k = (margin_ref / gold * 1000) if gold > 0 else (INF if margin_ref > 0 else 0.0)
    fh = sim["fill_hours"]
    # Gold priced by the user's slider (Divine per 1k gold -> reference per 1 gold).
    gold_price_ref = settings_mod.gold_value_per_1k(g.s) * (ref_value.get("divine") or 1.0) / 1000.0
    velocity = _velocity(margin_ref, fh, gold, gold_price_ref)
    return {
        "id": _edge_list_id(cyc),
        "start": start, "start_name": registry.name(start),
        "path": [start] + [e.dst for e in cyc],
        "path_names": [registry.name(start)] + [registry.name(e.dst) for e in cyc],
        "kinds": [e.kind for e in cyc],
        "steps": sim["steps"],
        "start_amount": amount, "cycle_unit": unit, "cycles": cycles, "end_amount": sim["end_amount"],
        "margin": margin, "margin_pct": (margin / amount * 100) if amount else 0.0,
        "margin_ref": margin_ref,
        "value_ref": sim["value_ref"],
        "gold": gold,
        "margin_per_1k_gold": None if mp1k == INF else mp1k,
        "velocity": None if velocity == INF else velocity,   # margin_ref / (fill_hours × gold) × 1000
        "velocity_inf": velocity == INF,
        "profit_per_hour": (margin_ref / fh) if fh else None,
        "gold_free": gold == 0,
        "liquidity_ref": sim["liquidity_ref"],
        "volume_ref_per_h": sim["volume_ref_per_h"],   # slowest step's executed value/hour
        "fill_hours": sim["fill_hours"],               # sum of commit/turnover per step
        "max_age_s": sim["max_age_s"],
        "all_live": sim["all_live"],
        "uses_recipe": any(e.kind == "recipe" for e in cyc),
        "capital_held": held,
        "pairs": [[e.src, e.dst] for e in cyc if e.kind != "recipe"],
    }


# Recommended per-step minimums, baked into the default filters (settings.py). These are
# the MIN across a route's steps, so filtering the route enforces the bar at every step.
# Users can lower them, but the UI warns them (routes below this are usually unfillable).
RECOMMENDED_MIN_LIQUIDITY_REF = 50.0
RECOMMENDED_MIN_VOLUME_REF_PER_H = 100.0


def _keep(r: dict, f: dict) -> bool:
    if r["margin_pct"] < f.get("min_margin_pct", -INF):
        return False
    if r["margin_ref"] < f.get("min_margin_ref", -INF):
        return False
    if f.get("max_gold") and r["gold"] > f["max_gold"]:
        return False
    if f.get("min_margin_per_1k_gold") and not r["gold_free"] and \
            (r["margin_per_1k_gold"] or 0) < f["min_margin_per_1k_gold"]:
        return False
    if f.get("min_liquidity_ref") and r["liquidity_ref"] is not None and \
            r["liquidity_ref"] < f["min_liquidity_ref"]:
        return False
    if f.get("live_only") and not r["all_live"]:
        return False
    if f.get("min_volume_ref_per_h") and (r["volume_ref_per_h"] or 0) < f["min_volume_ref_per_h"]:
        return False
    if f.get("max_fill_hours") and (r["fill_hours"] is None or r["fill_hours"] > f["max_fill_hours"]):
        return False
    if f.get("min_velocity") and not r["velocity_inf"] and (r["velocity"] or 0) < f["min_velocity"]:
        return False
    if f.get("exclude_recipes") and r["uses_recipe"]:
        return False
    return True


def _sort_key(sort: str):
    def key(r: dict):
        if sort == "margin_per_1k_gold":
            return INF if r["gold_free"] and r["margin_ref"] > 0 else (r["margin_per_1k_gold"] or -INF)
        if sort == "fill_hours":
            return -(r["fill_hours"] if r["fill_hours"] is not None else INF)
        if sort == "velocity":
            return INF if r["velocity_inf"] else (r["velocity"] if r["velocity"] is not None else -INF)
        return r.get(sort, 0) or 0
    return key


def _search_setup(filters: dict | None, start_currencies: list[str] | None):
    g = graph.cached_graph()
    s = g.s
    f = {**s["filters"], **(filters or {})}
    ref_value = g.ref_values()
    capital = db.get_capital()
    starts = start_currencies or [c for c, q in capital.items() if q > 0]
    notional = not starts
    if notional:
        starts = list(g.adj.keys())
    return g, s, f, ref_value, capital, starts, notional


def _iter_candidates(g: Graph, s: dict, ref_value: dict, capital: dict, starts: list[str], notional: bool):
    """Yield route dicts as the DFS discovers them, capped at MAX_CANDIDATES."""
    count = 0
    for start in starts:
        held = capital.get(start, 0.0)
        budget = held * s["max_start_fraction"] if not notional else (1.0 / ref_value.get(start, 1.0) or 1.0) * 10
        for cyc in g.iter_cycles(start, s["max_steps"]):
            count += 1
            if count > MAX_CANDIDATES:
                return
            r = _route_from(g, cyc, start, held, budget, ref_value)
            if r is not None:
                yield r


def _finish(routes: list[dict], f: dict, s: dict) -> tuple[list[dict], int]:
    pairscore.observe(routes)
    kept = [r for r in routes if _keep(r, f)]
    _composite_score(kept, s.get("rank_weights", {}))
    kept.sort(key=_sort_key(f.get("sort", "score")), reverse=True)
    return kept, int(f.get("limit", 100))


def stream_routes(filters: dict | None = None, start_currencies: list[str] | None = None):
    """Generator for the SSE endpoint: ('meta', …) once, ('route', r) for every route
    that passes the filters as it is discovered, then ('done', summary). The finished,
    scored result is also placed in the route cache so follow-up queries are instant."""
    g, s, f, ref_value, capital, starts, notional = _search_setup(filters, start_currencies)
    # Serve a fresh cached result as one burst instead of re-searching.
    key = _cache_key(filters, start_currencies)
    cached = _cache_get(key, s)
    if cached is not None:
        yield "meta", {"reference": cached["reference"], "capital": cached["capital"],
                       "notional": cached["notional"], "graph": cached["graph"],
                       "filters": cached["filters"]}
        for r in cached["routes"]:
            yield "route", r
        yield "done", {"total_candidates": cached["total_candidates"],
                       "total_after_filters": cached["total_after_filters"], "truncated": False,
                       "scores": {r["id"]: r.get("score") for r in cached["routes"]},
                       "order": [r["id"] for r in cached["routes"]], "cached": True}
        return
    yield "meta", {
        "reference": s["reference"], "capital": capital, "notional": notional,
        "graph": _graph_summary(g), "filters": f,
    }
    routes: list[dict] = []
    for r in _iter_candidates(g, s, ref_value, capital, starts, notional):
        routes.append(r)
        if _keep(r, f):
            yield "route", r
    kept, limit = _finish(routes, f, s)
    result = _result(g, s, f, ref_value, capital, notional, routes, kept, limit)
    _cache_put(key, result)
    yield "done", {
        "total_candidates": len(routes), "total_after_filters": len(kept),
        "truncated": len(routes) >= MAX_CANDIDATES,
        "scores": {r["id"]: r["score"] for r in kept[:limit]},
        "order": [r["id"] for r in kept[:limit]],
    }


def _find_routes(filters: dict | None, start_currencies: list[str] | None) -> dict:
    g, s, f, ref_value, capital, starts, notional = _search_setup(filters, start_currencies)
    routes = list(_iter_candidates(g, s, ref_value, capital, starts, notional))
    kept, limit = _finish(routes, f, s)
    return _result(g, s, f, ref_value, capital, notional, routes, kept, limit)


def _composite_score(routes: list[dict], weights: dict) -> None:
    """Rank-normalised weighted score in [0, 1]. Each metric contributes
    weight × (1 - rank/n), so the best on a metric gets the full weight."""
    if not routes:
        return
    n = len(routes)
    w_vel = weights.get("velocity", 0.5)
    w_eff = weights.get("margin_per_1k_gold", 0.2)
    w_val = weights.get("margin_ref", 0.2)
    w_vol = weights.get("volume", 0.1)
    total = (w_vel + w_eff + w_val + w_vol) or 1.0

    def ranks(key) -> dict[str, float]:
        order = sorted(routes, key=key, reverse=True)
        return {r["id"]: 1 - i / n for i, r in enumerate(order)}

    eff = ranks(lambda r: INF if r["gold_free"] and r["margin_ref"] > 0 else (r["margin_per_1k_gold"] or -INF))
    val = ranks(lambda r: r["margin_ref"])
    # Unknown volume ranks worst (−INF), consistent with the min_volume filter which
    # treats None as 0 — previously None ranked best (INF), contradicting the filter.
    vol = ranks(lambda r: r["volume_ref_per_h"] if r["volume_ref_per_h"] is not None else -INF)
    vel = ranks(lambda r: INF if r["velocity_inf"] else (r["velocity"] if r["velocity"] is not None else -INF))
    for r in routes:
        r["score"] = round((w_vel * vel[r["id"]] + w_eff * eff[r["id"]] + w_val * val[r["id"]] + w_vol * vol[r["id"]]) / total, 4)
        r["score_parts"] = {"velocity": round(vel[r["id"]], 3), "efficiency": round(eff[r["id"]], 3),
                            "value": round(val[r["id"]], 3), "volume": round(vol[r["id"]], 3)}
