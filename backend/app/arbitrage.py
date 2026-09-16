"""Route search and ranking.

Graph: nodes are trade ids, directed edges are ways to turn `from` into `to`.
  * live      — top-of-book ladder from the exchange API (best rate first)
  * digest    — GGG hourly VWAP, single synthetic offer sized by highest stock
  * recipe    — off-exchange combine/disenchant; no gold, lot-sized input

A route is a simple cycle starting and ending at a currency the user holds.
We size the route by the user's capital (× max_start_fraction) capped by the
liquidity along the path, simulate the fills step by step with whole-unit
rounding, then score:
  margin        = units gained in the start currency
  margin_ref    = that gain valued in the reference currency
  value_ref     = total value that passes through the loop
  gold          = modelled exchange fees (recipes are free)
  margin/1k gold= gold efficiency
"""
from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass, field

from . import cache, centrality, db, digest, gamedata, leaguehistory, marketseries, orderbook, pairscore, recipes, session
from . import settings as settings_mod
from .currencies import registry
from .settings import get_settings

INF = float("inf")


@dataclass
class Edge:
    src: str
    dst: str
    kind: str                       # live | digest | recipe
    rate: float                     # dst units per src unit (best)
    ladder: list[dict]              # [{rate, stock(dst units), whisper?, account?}]
    age_s: float = 0.0
    lot: float = 1.0                # recipe input lot size
    vol_in_per_h: float | None = None   # executed src units per hour (digest); None for recipes
    meta: dict = field(default_factory=dict)

    def capacity_in(self) -> float:
        """Max src units this edge can absorb."""
        if self.kind == "recipe":
            return INF
        return sum(o["stock"] / o["rate"] for o in self.ladder if o["rate"] > 0)

    def capacity_ref(self, ref_value: dict[str, float]) -> float:
        v = ref_value.get(self.src)
        c = self.capacity_in()
        return c * v if v and c != INF else (INF if c == INF else 0.0)

    def fill(self, amount: float) -> tuple[float, float, list[dict]]:
        """Convert up to `amount` src units. Returns (used_in, out, fills)."""
        if self.kind == "recipe":
            lots = math.floor(amount / self.lot)
            used = lots * self.lot
            return used, math.floor(lots * self.lot * self.rate), [
                {"rate": self.rate, "in": used, "out": math.floor(used * self.rate)}
            ] if used > 0 else []
        remaining = amount
        out = 0.0
        fills = []
        for o in self.ladder:
            if remaining <= 0:
                break
            cap = o["stock"] / o["rate"]
            take = min(remaining, cap)
            got = take * o["rate"]
            fills.append({"rate": o["rate"], "in": take, "out": got,
                          "whisper": o.get("whisper"), "account": o.get("account")})
            out += got
            remaining -= take
        used = amount - remaining
        return used, math.floor(out), fills


class Graph:
    def __init__(self, settings: dict):
        self.s = settings
        self.edges: dict[tuple[str, str], Edge] = {}
        self.adj: dict[str, list[Edge]] = {}
        self.sources = {"live": 0, "digest": 0, "recipe": 0}
        self.fee_table: dict[str, int] = {}

    def add(self, e: Edge) -> None:
        self.edges[(e.src, e.dst)] = e
        self.adj.setdefault(e.src, []).append(e)
        self.sources[e.kind] += 1

    # ------------------------------------------------------------ build
    @classmethod
    def build(cls) -> "Graph":
        s = get_settings()
        g = cls(s)
        g.fee_table = gamedata.fees()["by_trade"]
        league = s["league"]
        live = orderbook.latest_books(league, s["live_max_age_s"])
        for (a, b), book in live.items():
            g.add(Edge(a, b, "live", book["rate"], book["offers"], book["age_s"],
                       meta={"depth": book["depth"]}))
        if s["allow_digest_edges"]:
            for (a, b), d in digest.latest_rates(league, s["digest_max_age_h"]).items():
                if (a, b) in g.edges:
                    continue
                g.add(Edge(a, b, "digest", d["rate"], [{"rate": d["rate"], "stock": d["stock"]}],
                           d["age_s"], meta={"hour": d["hour"], "volume": d["volume_to"]}))
        vols = digest.pair_volume(league, s.get("volume_window_h", 24))
        for (a, b), e in g.edges.items():
            if e.kind != "recipe":
                e.vol_in_per_h = vols.get((a, b), 0.0)
        # Cull illiquid markets before searching: a thin ladder or near-zero traded
        # value can't be executed anyway and only feeds junk loops.
        min_depth = int(s.get("min_edge_depth") or 0)
        min_vol = float(s.get("min_edge_volume_ref_per_h") or 0)
        if min_depth or min_vol:
            rv = g.ref_values()
            # Markets adjacent to an enabled recipe stay: they're how a recipe hop is
            # entered/exited, and the route-level liquidity filter still applies.
            recipe_ends: set[str] = set()
            if s["allow_recipe_edges"]:
                for r in recipes.edges():
                    recipe_ends.add(r["from"])
                    recipe_ends.add(r["to"])
            def _thin(e: Edge) -> bool:
                if e.src in recipe_ends or e.dst in recipe_ends:
                    return False
                if min_depth and e.kind == "live" and len(e.ladder) < min_depth:
                    return True
                if min_vol and (e.vol_in_per_h or 0.0) * rv.get(e.src, 0.0) < min_vol:
                    return True
                return False
            dropped = [k for k, e in g.edges.items() if _thin(e)]
            for k in dropped:
                g.sources[g.edges[k].kind] -= 1
                del g.edges[k]
            if dropped:
                g.adj = {}
                for e in g.edges.values():
                    g.adj.setdefault(e.src, []).append(e)
        if s["allow_recipe_edges"]:
            for r in recipes.edges():
                if (r["from"], r["to"]) in g.edges and g.edges[(r["from"], r["to"])].rate >= r["rate"]:
                    continue  # exchange already beats the recipe
                g.add(Edge(r["from"], r["to"], "recipe", r["rate"], [], 0.0, lot=r["lot"],
                           meta={"recipe_id": r["recipe_id"], "name": r["name"], "kind": r["kind"]}))
        return g

    # ------------------------------------------------------------ values
    def ref_values(self) -> dict[str, float]:
        """Value of 1 unit of each currency in the reference currency.

        Levelled BFS from the reference: direct markets first, then 2..6 hops,
        taking the best rate at the first level a currency becomes reachable.
        Implied inverse rates count, so anything connected to the graph gets a
        value; capping by shortest path keeps arbitrage cycles from inflating it.
        """
        ref = self.s["reference"]
        best: dict[tuple[str, str], float] = {}
        for (a, b), e in self.edges.items():
            if e.rate > 0:
                best[(a, b)] = max(best.get((a, b), 0.0), e.rate)
                best[(b, a)] = max(best.get((b, a), 0.0), 1.0 / e.rate)
        hops: dict[str, list[tuple[str, float]]] = {}
        for (a, b), r in best.items():
            hops.setdefault(a, []).append((b, r))
        vals: dict[str, float] = {ref: 1.0}
        for _ in range(6):
            level: dict[str, float] = {}
            for n, out in hops.items():
                if n in vals:
                    continue
                for dst, r in out:
                    v = vals.get(dst)
                    if v is not None and r * v > level.get(n, 0.0):
                        level[n] = r * v
            if not level:
                break
            vals.update(level)
        # Fallback for currencies the exchange graph can't reach (e.g. Hinekora's Lock,
        # omens): value them from poe2scout (priced in Exalted). This threads a price
        # for EVERY traded currency through capital, routes, market and the board.
        try:
            scout = leaguehistory.scout_prices(self.s["league"])
            ex = vals.get("exalted")                     # reference-per-exalted
            if scout and ex:
                for cid in registry.by_id:
                    if cid in vals:
                        continue
                    px = leaguehistory.scout_lookup(scout, cid)
                    if px:
                        vals[cid] = px * ex
        except Exception:
            pass                                         # never let valuation crash on this
        return vals

    # ------------------------------------------------------------ search
    def iter_cycles(self, start: str, max_steps: int):
        """Lazily yield simple cycles from `start`, so callers can stream results."""
        def dfs(node: str, path: list[Edge], visited: set[str]):
            for e in self.adj.get(node, []):
                if e.dst == start and len(path) >= 1:
                    yield path + [e]
                elif e.dst not in visited and len(path) < max_steps - 1:
                    yield from dfs(e.dst, path + [e], visited | {e.dst})
        yield from dfs(start, [], {start})

    def cycles(self, start: str, max_steps: int) -> list[list[Edge]]:
        return list(self.iter_cycles(start, max_steps))

    def iter_paths(self, start: str, target: str, max_steps: int):
        """Lazily yield simple OPEN paths from `start` to `target` (the conversion sibling of
        `iter_cycles`, which closes back to start). Each path is a list[Edge] ending at
        `target`, visiting no node twice, at most `max_steps` hops long."""
        def dfs(node: str, path: list[Edge], visited: set[str]):
            for e in self.adj.get(node, []):
                if e.dst == target:
                    yield path + [e]
                elif e.dst not in visited and len(path) < max_steps - 1:
                    yield from dfs(e.dst, path + [e], visited | {e.dst})
        yield from dfs(start, [], {start})


def gold_fee(model: dict, edge: Edge, in_units: float, out_units: float,
             ref_value: dict[str, float], table: dict[str, int]) -> float:
    """Exchange fee for one step.

    Precedence: manual override in settings > GoldPurchaseFee from game data >
    fallback per reference-unit of value. `fee_side` picks whether the per-unit fee
    applies to what you receive (buy) or what you give (sell).
    """
    if edge.kind == "recipe" or out_units <= 0:
        return 0.0
    side_buy = model.get("fee_side", "buy") != "sell"
    cur, units = (edge.dst, out_units) if side_buy else (edge.src, in_units)
    base = model.get("base_per_order", 0)
    per_unit = model.get("per_unit", {}).get(cur)
    if per_unit is None:
        per_unit = table.get(cur)
    if per_unit is not None:
        return base + per_unit * units
    return base + model.get("per_ref_unit", 0) * units * ref_value.get(cur, 0.0)


def simulate(g: Graph, cycle: list[Edge], start_amount: float, ref_value: dict[str, float]) -> dict:
    model = g.s["gold_model"]
    table = g.fee_table
    amt = start_amount
    steps = []
    gold = 0.0
    value_ref = 0.0
    liquidity_ref = INF
    volume_ref_per_h = INF
    fill_hours = 0.0
    overhead_h = float(g.s.get("step_overhead_min", 0)) / 60
    max_age = 0.0
    all_live = True
    for e in cycle:
        used, out, fills = e.fill(amt)
        if e.kind != "recipe":
            v = e.vol_in_per_h or 0.0
            volume_ref_per_h = min(volume_ref_per_h, v * ref_value.get(e.src, 0.0))
            fill_hours += ((used / v) if v > 0 else INF) + overhead_h
        fee = gold_fee(model, e, used, out, ref_value, table)
        gold += fee
        value_ref += used * ref_value.get(e.src, 0.0)
        liquidity_ref = min(liquidity_ref, e.capacity_ref(ref_value))
        max_age = max(max_age, e.age_s)
        if e.kind == "digest":
            all_live = False
        steps.append({
            "from": e.src, "to": e.dst, "from_name": registry.name(e.src), "to_name": registry.name(e.dst),
            "kind": e.kind, "rate": e.rate, "in": used, "out": out, "unconverted": amt - used,
            "gold": fee, "age_s": e.age_s, "fills": fills[:5], "meta": e.meta,
            "vol_in_per_h": e.vol_in_per_h,
        })
        amt = out
    return {
        "steps": steps, "end_amount": amt, "gold": gold, "value_ref": value_ref,
        "liquidity_ref": None if liquidity_ref == INF else liquidity_ref,
        "volume_ref_per_h": None if volume_ref_per_h == INF else volume_ref_per_h,
        "fill_hours": None if fill_hours == INF else fill_hours,
        "max_age_s": max_age, "all_live": all_live,
    }


def route_cap(cycle: list[Edge], capital: float) -> float:
    """Continuous max start amount the path's liquidity supports, capped by capital
    (before rounding to whole tradable cycles)."""
    cap = capital
    scale = 1.0  # start units -> current node units
    for e in cycle:
        c = e.capacity_in()
        if c != INF:
            cap = min(cap, c / scale)
        scale *= e.rate
    return cap


def cycle_unit(cycle: list[Edge], limit: int = 512) -> int:
    """Smallest whole start amount that flows through the loop with NO granularity
    waste — every hop consumes its full input, so the trade ratios line up (recipe
    hops are lot-sized, e.g. 3 augs -> 1 greater). The committed amount is always a
    multiple of this, so we never commit a partial lot.

    Pure currency-exchange loops trade in single units (rates are continuous), so their
    unit is 1. For recipe loops we search for the smallest start whose amount arrives at
    each recipe hop as a whole number of lots. Falls back to 1 if nothing aligns within
    `limit` (keeps sizing well-defined for odd ratios)."""
    if not any(e.kind == "recipe" for e in cycle):
        return 1
    for a in range(1, limit + 1):
        amt = a
        ok = True
        for e in cycle:
            used, out, _ = e.fill(amt)
            if out <= 0 or used + 1e-9 < amt:   # a whole lot didn't fit → waste at this hop
                ok = False
                break
            amt = out
        if ok:
            return a
    return 1


_route_cache: dict = {}      # search key -> (ts, orderbook version, result); see _cache_get/_cache_put
_graph_cache: dict = {}
_board_cache: dict = {}
GRAPH_TTL_S = 5.0
BOARD_TTL_S = 30.0
ROUTE_CACHE_MAX = 32


def cached_graph() -> Graph:
    """Graph.build() with a short TTL so header polling, capital valuation and route
    search share one build instead of re-reading the digest tables per request."""
    s = get_settings()
    key = (s["league"], s["reference"], s["allow_digest_edges"], s["allow_recipe_edges"],
           s["live_max_age_s"], s["digest_max_age_h"],
           s.get("min_edge_volume_ref_per_h"), s.get("min_edge_depth"))
    return cache.memo(_graph_cache, key, GRAPH_TTL_S, Graph.build, version=orderbook.state["version"])


def invalidate_caches() -> None:
    """Drop the graph + route + board caches (call after settings changes, e.g. league switch,
    reference, watchlist, or hub_count — so a settings edit reflects immediately)."""
    cache.clear(_graph_cache)
    cache.clear(_route_cache)
    cache.clear(_board_cache)


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

# Default price of gold for net-value ranking (Convert): Divine per 1000 gold. Gold's real
# worth shifts across a league, so this is user-tunable via a slider (settings.gold_value_per_1k);
# this constant is only the fallback. 0.01 divine/1k gold == a Divine is "worth" ~100k gold.
GOLD_VALUE_DIVINE_PER_1K = settings_mod.GOLD_VALUE_DIVINE_PER_1K


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
    g = cached_graph()
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
                       "rank_weights": s.get("rank_weights", {}), "filters": cached["filters"]}
        for r in cached["routes"]:
            yield "route", r
        yield "done", {"total_candidates": cached["total_candidates"],
                       "total_after_filters": cached["total_after_filters"], "truncated": False,
                       "scores": {r["id"]: r.get("score") for r in cached["routes"]},
                       "order": [r["id"] for r in cached["routes"]], "cached": True}
        return
    yield "meta", {
        "reference": s["reference"], "capital": capital, "notional": notional,
        "graph": _graph_summary(g), "rank_weights": s.get("rank_weights", {}), "filters": f,
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


def _convert_path(g: Graph, path: list[Edge], amount: float, ref_value: dict[str, float],
                  have: str, want: str) -> dict | None:
    """Size one open path by `amount` capped by its liquidity (reusing route_cap/cycle_unit),
    simulate the real fills, and shape it like a route dict so the UI renderer is reused.
    `out` = whole units of `want` produced; loss is vs the committed value in the reference."""
    unit = cycle_unit(path)
    committed = (math.floor(route_cap(path, amount) / unit) * unit) if unit > 0 else 0
    if committed < 1:
        return None
    sim = simulate(g, path, committed, ref_value)
    value_in = committed * ref_value.get(have, 0.0)
    value_out = sim["end_amount"] * ref_value.get(want, 0.0)
    loss_ref = value_in - value_out
    out = int(sim["end_amount"])
    gold = sim["gold"]
    return {
        "id": _edge_list_id(path),
        "path": [have] + [e.dst for e in path],
        "path_names": [registry.name(have)] + [registry.name(e.dst) for e in path],
        "kinds": [e.kind for e in path],
        "steps": sim["steps"],
        "in": committed, "out": out, "end_amount": sim["end_amount"],
        "hops": len(path), "full_fill": committed >= amount - 1e-9,
        "loss_ref": loss_ref, "loss_pct": (loss_ref / value_in * 100) if value_in else 0.0,
        "gold": gold, "gold_free": gold <= 0,
        # velocity analog: output delivered per 1k gold (gold is a real, precious cost). None
        # when gold-free (ranked in its own tier above paid routes). Also gold-per-output for UI.
        "out_per_1k_gold": (out / gold * 1000) if gold > 0 else None,
        "gold_per_out": (gold / out) if out > 0 and gold > 0 else None,
        "value_ref": sim["value_ref"], "all_live": sim["all_live"], "max_age_s": sim["max_age_s"],
        "liquidity_ref": sim["liquidity_ref"], "volume_ref_per_h": sim["volume_ref_per_h"],
        "fill_hours": sim["fill_hours"],
        "uses_recipe": any(e.kind == "recipe" for e in path),
    }


def _best_conversions(g: Graph, ref_value: dict[str, float], have: str, want: str,
                      amount: float, max_steps: int | None = None, k: int = 3,
                      max_gain_pct: float = 2.0,
                      gold_value_per_1k: float = GOLD_VALUE_DIVINE_PER_1K,
                      bridge: dict[str, float] | None = None) -> dict:
    """Rank open conversion paths have->want by NET value delivered: the value of the `want` you
    receive minus the gold spent, where gold is charged at `gold_value_per_1k` (Divine per 1k
    gold — a user-tunable price, since gold's worth shifts across a league). This makes gold a
    first-class, precious cost: a route delivering slightly more `want` for far more gold loses
    (the chaos->omen->divine '114 divine / 585k gold' path). Fully-converting routes rank above
    partial fills. Pure over (g, ref_value).

    A conversion CANNOT legitimately create value: any path implying a value GAIN beyond
    `max_gain_pct` is a cross-rate inconsistency / disguised arbitrage (belongs in the Arbitrage
    tab), so it is rejected here. Set a huge tolerance to disable (tests)."""
    if max_steps is None:
        max_steps = g.s.get("max_steps", 4)
    gold_ref_per_1k = gold_value_per_1k * (ref_value.get("divine") or 1.0)   # Divine/1k -> ref/1k
    seen: dict[str, dict] = {}
    count = 0
    for path in g.iter_paths(have, want, max_steps):
        count += 1
        if count > MAX_CANDIDATES:
            break
        r = _convert_path(g, path, amount, ref_value, have, want)
        if r is not None and r["loss_pct"] >= -max_gain_pct:   # drop phantom-gain arbitrage mirages
            # net value delivered = value of `want` received - gold charged at the user's price.
            r["net_ref"] = r["out"] * ref_value.get(want, 0.0) - r["gold"] / 1000.0 * gold_ref_per_1k
            seen[r["id"]] = r
    # Final tie-break: among routes that tie on fill, net value AND hop count, prefer the one
    # threading more central BRIDGE currencies (centrality.betweenness_lite) — it's likelier to
    # actually fill. Only ever decides genuine ties; net_ref/hops dominate. 0.0 when no signal.
    def _bridge_score(r: dict) -> float:
        mids = r["path"][1:-1]   # intermediate nodes (exclude have + want)
        return sum((bridge or {}).get(n, 0.0) for n in mids) / len(mids) if mids else 0.0
    ranked = sorted(seen.values(),
                    key=lambda r: (r["full_fill"], r["net_ref"], -r["hops"], _bridge_score(r)),
                    reverse=True)
    best = ranked[0] if ranked else None
    direct_edge = g.edges.get((have, want))
    direct = _convert_path(g, [direct_edge], amount, ref_value, have, want) if direct_edge else None
    alternatives = [r for r in ranked if best is None or r["id"] != best["id"]]
    return {"have": have, "want": want, "amount": amount, "reference": g.s["reference"],
            "best": best, "direct": direct, "alternatives": alternatives}


def convert(have: str, want: str, amount: float | None = None, max_steps: int | None = None) -> dict:
    """Cheapest way to turn `have` into `want` across the live exchange graph (open path, not a
    loop). `amount` defaults to the user's held `have`. Rides the cached graph — read-only."""
    g = cached_graph()
    ref_value = g.ref_values()
    if amount is None:
        amount = db.get_capital().get(have, 0.0) or 1.0
    gv = settings_mod.gold_value_per_1k(g.s)
    bridge = centrality.betweenness_lite(g, ref_value)
    return _best_conversions(g, ref_value, have, want, float(amount), max_steps,
                             gold_value_per_1k=gv, bridge=bridge)


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


def board(window_h: int = 24) -> dict:
    """Live price board: each watched currency priced in the reference, with the
    buy/sell rates that make up the spread, depth, freshness, and a trend series.

    `window_h` is the trend/%-change horizon (24h, 3d, 7d, 14d from the UI): the sparkline
    spans it and change_pct is measured over it.

    Prices are R-per-unit (reference currency per 1 of the currency), so bigger = more
    valuable — the natural way to read a price. buy = what it costs you to acquire one
    (from the R->c ladder), sell = what you get for one (from the c->R ladder).

    Result is TTL-cached: it runs one history query per watched currency, but the
    underlying digest only changes hourly, so repeated polls are served from memory
    (invalidated when a new live book lands, via orderbook.state["version"])."""
    s0 = get_settings()
    window_h = max(1, int(window_h or 24))
    key = (s0["league"], s0["reference"], tuple(s0["watchlist"]), window_h, s0.get("hub_count"))
    return cache.memo(_board_cache, key, BOARD_TTL_S, lambda: _board(window_h),
                      version=orderbook.state["version"])


def _board(window_h: int) -> dict:
    g = cached_graph()
    s = g.s
    R = s["reference"]
    league = s["league"]
    rv = g.ref_values()
    # Per-currency counterpart markets, ranked by traded value/hour (units × ref value)
    # — a fair, direction-symmetric measure of each market's size. Used to pick the
    # default numeraire: the highest-volume counterpart that still prints a readable
    # price (see the readability walk below).
    ranked: dict[str, list[tuple[float, str]]] = {}
    for (a, b), e in g.edges.items():
        if e.kind == "recipe" or not e.vol_in_per_h:
            continue
        volr = e.vol_in_per_h * (rv.get(a) or 0.0)
        for node, other in ((a, b), (b, a)):
            ranked.setdefault(node, []).append((volr, other))
    for lst in ranked.values():
        lst.sort(reverse=True)
    hub_ids = centrality.hubs(g, rv, settings_mod.hub_count(s))   # top PageRank → Board "hub" chip (count user-tunable)
    # One-time: seed the board with the market's hub currencies so a fresh board always shows the
    # central markets. Runs once, only once real hubs are known (skips the cold graph), then the
    # user owns the board — later removals stick (mirrors the _liq_floor_v1 seed in settings.py).
    if hub_ids and not s.get("_hub_seed_v1"):
        missing = centrality.seed_missing(s["watchlist"], hub_ids, R)
        settings_mod.save_settings({"watchlist": s["watchlist"] + missing, "_hub_seed_v1": True})
        s["watchlist"] = s["watchlist"] + missing
    scout = leaguehistory.scout_prices(league)   # poe2scout fallback prices (Exalted), by name/slug
    scout_hist = leaguehistory.scout_history(league)   # poe2scout daily trend, by name/slug
    rows = []
    for c in [x for x in s["watchlist"] if x != R]:
        buy_edge = g.edges.get((R, c))     # c per R  -> price to BUY c = 1/rate
        sell_edge = g.edges.get((c, R))    # R per c  -> price to SELL c = rate
        buy = (1.0 / buy_edge.rate) if buy_edge and buy_edge.rate > 0 else None
        sell = sell_edge.rate if sell_edge else None
        mid = rv.get(c)     # includes the poe2scout fallback threaded through ref_values
        edges = [e for e in (buy_edge, sell_edge) if e]
        kinds = {e.kind for e in edges}
        # Source label: prefer live/digest exchange data; a currency the exchange graph
        # doesn't cover is priced from poe2scout ("scout"); anything else valued only
        # via multi-hop is "derived".
        in_scout = bool(leaguehistory.scout_lookup(scout, c))
        source = ("live" if "live" in kinds else "digest" if "digest" in kinds
                  else "scout" if (not kinds and in_scout) else ("derived" if mid is not None else None))
        from_scout = source == "scout"
        age = min((e.age_s for e in edges), default=None)
        depth = next((len(e.ladder) for e in (sell_edge, buy_edge) if e and e.kind == "live"), None)
        spread = (buy - sell) if (buy is not None and sell is not None) else None
        spread_pct = (spread / mid * 100) if (spread is not None and mid) else None
        # Trend + %-change over the selected window (24h/3d/7d/14d). Digest is hourly;
        # poe2scout fallback is daily.
        hist = digest.pair_history(league, c, R, window_h)   # rate = R per c = price of c in R
        trend = [{"t": h["hour"], "v": h["rate"]} for h in hist]
        if len(trend) < 2:   # not on the exchange digest → draw from poe2scout dailies
            sh = leaguehistory.scout_lookup(scout_hist, c)
            if sh:
                cutoff = sh[-1]["t"] - window_h * 3600
                trend = [p for p in sh if p["t"] >= cutoff] or sh[-2:]
        # change over the window = latest vs the point at (or nearest before) the window start.
        change_pct = marketseries.change_over(trend, window_h * 3600)[1]
        # Default numeraire: the highest-VOLUME counterpart whose price stays readable.
        # Cheap currencies' biggest market is often Divine (huge value moves even on
        # modest flow), which would print a useless micro-price (Regal = 0.0034 div) — so
        # walk down the volume ranking and take the first counterpart whose price is at
        # least MIN_READABLE of it. Divine keeps its Chaos market, Annul keeps Divine
        # (0.5 div is legible), but Regal/Chaos/Vaal drop to Exalted. Currencies with no
        # liquid, readable market (poe2scout-only, or thin digest) tier by value instead.
        MIN_READABLE = 0.5   # numeraire units per 1 of the currency; below this, step down
        pref, seen = None, set()
        for _volr, other in ranked.get(c, ()):
            if other == c or other in seen:
                continue
            seen.add(other)
            nv = rv.get(other)
            if nv and mid and mid / nv >= MIN_READABLE:
                pref = other
                break
        if pref is None:
            mv, dv = rv.get("mirror"), rv.get("divine")
            if mid and mv and mid >= mv:
                pref = "mirror"
            elif mid and dv and mid >= dv:
                pref = "divine"
            else:
                pref = R
        # Universal rule: NOTHING is ever priced against itself (a 1:1 is useless).
        if pref == c:
            pref = "divine" if (c != "divine" and rv.get("divine")) else R
        rows.append({
            "id": c, "name": registry.name(c), "mid": mid, "buy": buy, "sell": sell,
            "spread": spread, "spread_pct": spread_pct, "source": source, "age_s": age,
            "depth": depth, "trend": trend, "change_pct": change_pct, "pref_num": pref,
            "hub": c in hub_ids,
        })
    rows.sort(key=lambda r: (r["mid"] is None, -(r["mid"] or 0)))   # most valuable first
    # Reference-currency price (R per unit) for every currency usable as a numeraire,
    # so the client can reprice any card into any of them. Reference itself is 1.
    need = {R} | {r["id"] for r in rows} | {r["pref_num"] for r in rows}
    prices = {i: (1.0 if i == R else rv.get(i)) for i in need if i == R or rv.get(i)}
    return {"reference": R, "league": league, "rows": rows, "prices": prices,
            "session": session.status().get("connected", False)}


def board_pairs() -> list[tuple[str, str]]:
    s = get_settings()
    R = s["reference"]
    pairs = []
    for c in s["watchlist"]:
        if c != R:
            pairs.append((R, c))
            pairs.append((c, R))
    return pairs


def edge_table() -> list[dict]:
    g = cached_graph()
    ref = g.ref_values()
    rows = []
    for (a, b), e in g.edges.items():
        rows.append({
            "from": a, "to": b, "from_name": registry.name(a), "to_name": registry.name(b),
            "kind": e.kind, "rate": e.rate, "age_s": e.age_s,
            "capacity_in": None if e.capacity_in() == INF else e.capacity_in(),
            "capacity_ref": None if e.capacity_ref(ref) == INF else e.capacity_ref(ref),
            "depth": len(e.ladder), "meta": e.meta,
        })
    rows.sort(key=lambda r: (r["from_name"], r["to_name"]))
    return rows
