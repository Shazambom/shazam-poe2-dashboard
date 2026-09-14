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

import math
import time
from dataclasses import dataclass, field

from . import digest, gamedata, orderbook, recipes
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
            from . import leaguehistory
            scout = leaguehistory.scout_prices(self.s["league"])
            ex = vals.get("exalted")                     # reference-per-exalted
            if scout and ex:
                for cid, cur in registry.by_id.items():
                    if cid in vals:
                        continue
                    px = scout.get(str(cur.name).lower()) or scout.get(str(cid).lower())
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


def size_route(cycle: list[Edge], capital: float) -> float:
    """Largest start amount the path's liquidity supports, capped by capital."""
    cap = capital
    scale = 1.0  # start units -> current node units
    for e in cycle:
        c = e.capacity_in()
        if c != INF:
            cap = min(cap, c / scale)
        scale *= e.rate
    return math.floor(cap)


_route_cache: dict[str, tuple[float, int, dict]] = {}
_graph_cache: tuple[float, int, tuple, "Graph"] | None = None
GRAPH_TTL_S = 5.0


def cached_graph() -> Graph:
    """Graph.build() with a short TTL so header polling, capital valuation and route
    search share one build instead of re-reading the digest tables per request."""
    global _graph_cache
    s = get_settings()
    key = (s["league"], s["reference"], s["allow_digest_edges"], s["allow_recipe_edges"],
           s["live_max_age_s"], s["digest_max_age_h"],
           s.get("min_edge_volume_ref_per_h"), s.get("min_edge_depth"))
    now = time.time()
    if _graph_cache:
        ts, ver, k, g = _graph_cache
        if k == key and ver == orderbook.state["version"] and now - ts < GRAPH_TTL_S:
            return g
    g = Graph.build()
    _graph_cache = (now, orderbook.state["version"], key, g)
    return g


def invalidate_caches() -> None:
    """Drop the graph + route caches (call after settings changes, e.g. league switch)."""
    global _graph_cache
    _graph_cache = None
    _route_cache.clear()


def route_pairs(route_id: str) -> list[tuple[str, str]]:
    """Exchange pairs behind a route id like 'chaos>exalted|exalted>divine|divine>chaos'."""
    pairs = []
    for hop in route_id.split("|"):
        if hop.endswith(":r") or ">" not in hop:
            continue  # recipe hops cost no request
        a, b = hop.split(">", 1)
        pairs.append((a, b))
    return pairs


def find_routes(filters: dict | None = None, start_currencies: list[str] | None = None,
                use_cache: bool = True) -> dict:
    import json as _json

    from . import db, orderbook

    s0 = get_settings()
    key = _json.dumps([filters or {}, start_currencies], sort_keys=True)
    hit = _route_cache.get(key)
    if use_cache and hit and time.time() - hit[0] < s0["routes_cache_s"] and hit[1] == orderbook.state["version"]:
        return {**hit[2], "cached": True}
    result = _find_routes(filters, start_currencies)
    _route_cache[key] = (time.time(), orderbook.state["version"], result)
    if len(_route_cache) > 32:
        oldest = min(_route_cache, key=lambda k: _route_cache[k][0])
        _route_cache.pop(oldest, None)
    return {**result, "cached": False}


MAX_CANDIDATES = 20000   # hard ceiling on simulated cycles per search


def _route_from(g: Graph, cyc: list[Edge], start: str, held: float, budget: float,
                ref_value: dict[str, float]) -> dict | None:
    amount = size_route(cyc, budget)
    if amount < 1:
        return None
    sim = simulate(g, cyc, amount, ref_value)
    margin = sim["end_amount"] - amount
    margin_ref = margin * ref_value.get(start, 0.0)
    gold = sim["gold"]
    mp1k = (margin_ref / gold * 1000) if gold > 0 else (INF if margin_ref > 0 else 0.0)
    fh = sim["fill_hours"]
    if fh is None or fh <= 0:
        velocity = None                      # no turnover data for a step
    elif gold > 0:
        velocity = margin_ref / fh / gold * 1000   # ref per hour per 1k gold
    else:
        velocity = INF if margin_ref > 0 else 0.0
    return {
        "id": "|".join(f"{e.src}>{e.dst}" + (":r" if e.kind == "recipe" else "") for e in cyc),
        "start": start, "start_name": registry.name(start),
        "path": [start] + [e.dst for e in cyc],
        "path_names": [registry.name(start)] + [registry.name(e.dst) for e in cyc],
        "kinds": [e.kind for e in cyc],
        "steps": sim["steps"],
        "start_amount": amount, "end_amount": sim["end_amount"],
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
    from . import db

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
    from . import pairscore
    pairscore.observe(routes)
    kept = [r for r in routes if _keep(r, f)]
    _composite_score(kept, s.get("rank_weights", {}))
    kept.sort(key=_sort_key(f.get("sort", "score")), reverse=True)
    return kept, int(f.get("limit", 100))


def stream_routes(filters: dict | None = None, start_currencies: list[str] | None = None):
    """Generator for the SSE endpoint: ('meta', …) once, ('route', r) for every route
    that passes the filters as it is discovered, then ('done', summary). The finished,
    scored result is also placed in the route cache so follow-up queries are instant."""
    import json as _json

    from . import orderbook

    g, s, f, ref_value, capital, starts, notional = _search_setup(filters, start_currencies)
    # Serve a fresh cached result as one burst instead of re-searching.
    key = _json.dumps([filters or {}, start_currencies], sort_keys=True)
    hit = _route_cache.get(key)
    if hit and time.time() - hit[0] < s["routes_cache_s"] and hit[1] == orderbook.state["version"]:
        cached = hit[2]
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
        "graph": {"nodes": len(g.adj), "edges": g.sources, "fee_table_size": len(g.fee_table)},
        "rank_weights": s.get("rank_weights", {}), "filters": f,
    }
    routes: list[dict] = []
    for r in _iter_candidates(g, s, ref_value, capital, starts, notional):
        routes.append(r)
        if _keep(r, f):
            yield "route", r
    kept, limit = _finish(routes, f, s)
    result = {
        "routes": kept[:limit], "total_candidates": len(routes), "total_after_filters": len(kept),
        "graph": {"nodes": len(g.adj), "edges": g.sources, "fee_table_size": len(g.fee_table)},
        "reference": s["reference"], "ref_values": ref_value, "capital": capital,
        "notional": notional, "filters": f,
    }
    key = _json.dumps([filters or {}, start_currencies], sort_keys=True)
    _route_cache[key] = (time.time(), orderbook.state["version"], result)
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
    return {
        "routes": kept[:limit],
        "total_candidates": len(routes),
        "total_after_filters": len(kept),
        "graph": {"nodes": len(g.adj), "edges": g.sources, "fee_table_size": len(g.fee_table)},
        "reference": s["reference"],
        "ref_values": ref_value,
        "capital": capital,
        "notional": notional,
        "filters": f,
    }


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


_board_cache: tuple[float, int, tuple, dict] | None = None
BOARD_TTL_S = 30.0


def board() -> dict:
    """Live price board: each watched currency priced in the reference, with the
    buy/sell rates that make up the spread, depth, freshness, and a trend series.

    Prices are R-per-unit (reference currency per 1 of the currency), so bigger = more
    valuable — the natural way to read a price. buy = what it costs you to acquire one
    (from the R->c ladder), sell = what you get for one (from the c->R ladder).

    Result is TTL-cached: it runs one history query per watched currency, but the
    underlying digest only changes hourly, so repeated polls are served from memory
    (invalidated when a new live book lands, via orderbook.state["version"])."""
    from . import session

    global _board_cache
    s0 = get_settings()
    key = (s0["league"], s0["reference"], tuple(s0["watchlist"]))
    now = time.time()
    if _board_cache and _board_cache[2] == key and _board_cache[1] == orderbook.state["version"] \
            and now - _board_cache[0] < BOARD_TTL_S:
        return _board_cache[3]

    g = cached_graph()
    s = g.s
    R = s["reference"]
    league = s["league"]
    rv = g.ref_values()
    # Per-currency default numeraire = the counterpart of its highest-volume market
    # (value/hour = traded units × their reference value). So Divine defaults to
    # Exalted, omens to Divine, etc. — whatever each actually trades against most.
    best = {}
    for (a, b), e in g.edges.items():
        if e.kind == "recipe" or not e.vol_in_per_h:
            continue
        volr = e.vol_in_per_h * (rv.get(a) or 0.0)
        for node, other in ((a, b), (b, a)):
            cur = best.get(node)
            if cur is None or volr > cur[0]:
                best[node] = (volr, other)
    from . import leaguehistory
    scout = leaguehistory.scout_prices(league)   # poe2scout fallback prices (Exalted), by name/slug
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
        in_scout = bool(scout.get(str(registry.name(c)).lower()) or scout.get(str(c).lower()))
        source = ("live" if "live" in kinds else "digest" if "digest" in kinds
                  else "scout" if (not kinds and in_scout) else ("derived" if mid is not None else None))
        from_scout = source == "scout"
        age = min((e.age_s for e in edges), default=None)
        depth = next((len(e.ladder) for e in (sell_edge, buy_edge) if e and e.kind == "live"), None)
        spread = (buy - sell) if (buy is not None and sell is not None) else None
        spread_pct = (spread / mid * 100) if (spread is not None and mid) else None
        hist = digest.pair_history(league, c, R, 72)   # rate = R per c = price of c in R
        trend = [{"t": h["hour"], "v": h["rate"]} for h in hist][-48:]
        change_pct = None
        if len(trend) >= 2 and trend[0]["v"]:
            change_pct = (trend[-1]["v"] - trend[0]["v"]) / trend[0]["v"] * 100
        pref = best.get(c, (0.0, R))[1]
        if from_scout:
            pref = "divine" if rv.get("divine") else R   # niche/high-value → default to Divine
        elif pref == c or not rv.get(pref):
            pref = R                                    # fall back to the reference
        rows.append({
            "id": c, "name": registry.name(c), "mid": mid, "buy": buy, "sell": sell,
            "spread": spread, "spread_pct": spread_pct, "source": source, "age_s": age,
            "depth": depth, "trend": trend, "change_pct": change_pct, "pref_num": pref,
        })
    rows.sort(key=lambda r: (r["mid"] is None, -(r["mid"] or 0)))   # most valuable first
    # Reference-currency price (R per unit) for every currency usable as a numeraire,
    # so the client can reprice any card into any of them. Reference itself is 1.
    need = {R} | {r["id"] for r in rows} | {r["pref_num"] for r in rows}
    prices = {i: (1.0 if i == R else rv.get(i)) for i in need if i == R or rv.get(i)}
    result = {"reference": R, "league": league, "rows": rows, "prices": prices,
              "session": session.status().get("connected", False)}
    _board_cache = (now, orderbook.state["version"], key, result)
    return result


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
