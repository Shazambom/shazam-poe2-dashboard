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
        if s["allow_recipe_edges"]:
            for r in recipes.edges():
                if (r["from"], r["to"]) in g.edges and g.edges[(r["from"], r["to"])].rate >= r["rate"]:
                    continue  # exchange already beats the recipe
                g.add(Edge(r["from"], r["to"], "recipe", r["rate"], [], 0.0, lot=r["lot"],
                           meta={"recipe_id": r["recipe_id"], "name": r["name"], "kind": r["kind"]}))
        return g

    # ------------------------------------------------------------ values
    def ref_values(self) -> dict[str, float]:
        """Value of 1 unit of each currency in the reference currency."""
        ref = self.s["reference"]
        vals: dict[str, float] = {ref: 1.0}
        nodes = set(self.adj) | {e.dst for e in self.edges.values()}
        for n in nodes:
            if n == ref:
                continue
            e = self.edges.get((n, ref))
            if e:
                vals[n] = e.rate
                continue
            e = self.edges.get((ref, n))
            if e and e.rate > 0:
                vals[n] = 1 / e.rate
        # second pass: 2-hop through anything already valued
        for n in nodes:
            if n in vals:
                continue
            for e in self.adj.get(n, []):
                if e.dst in vals:
                    vals[n] = e.rate * vals[e.dst]
                    break
            else:
                for (a, b), e in self.edges.items():
                    if b == n and a in vals and e.rate > 0:
                        vals[n] = vals[a] / e.rate
                        break
        return vals

    # ------------------------------------------------------------ search
    def cycles(self, start: str, max_steps: int) -> list[list[Edge]]:
        found: list[list[Edge]] = []

        def dfs(node: str, path: list[Edge], visited: set[str]) -> None:
            for e in self.adj.get(node, []):
                if e.dst == start and len(path) >= 1:
                    found.append(path + [e])
                elif e.dst not in visited and len(path) < max_steps - 1:
                    dfs(e.dst, path + [e], visited | {e.dst})

        dfs(start, [], {start})
        return found


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


def _find_routes(filters: dict | None, start_currencies: list[str] | None) -> dict:
    from . import db

    g = Graph.build()
    s = g.s
    f = {**s["filters"], **(filters or {})}
    ref_value = g.ref_values()
    capital = db.get_capital()
    starts = start_currencies or [c for c, q in capital.items() if q > 0]
    notional = False
    if not starts:
        notional = True
        starts = list(g.adj.keys())

    routes = []
    for start in starts:
        held = capital.get(start, 0.0)
        budget = held * s["max_start_fraction"] if not notional else (1.0 / ref_value.get(start, 1.0) or 1.0) * 10
        for cyc in g.cycles(start, s["max_steps"]):
            amount = size_route(cyc, budget)
            if amount < 1:
                continue
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
            r = {
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
            routes.append(r)

    def keep(r: dict) -> bool:
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

    from . import pairscore
    pairscore.observe(routes)
    kept = [r for r in routes if keep(r)]
    _composite_score(kept, s.get("rank_weights", {}))
    sort = f.get("sort", "score")

    def key(r: dict):
        if sort == "margin_per_1k_gold":
            return INF if r["gold_free"] and r["margin_ref"] > 0 else (r["margin_per_1k_gold"] or -INF)
        if sort == "fill_hours":
            return -(r["fill_hours"] if r["fill_hours"] is not None else INF)
        if sort == "velocity":
            return INF if r["velocity_inf"] else (r["velocity"] if r["velocity"] is not None else -INF)
        return r.get(sort, 0) or 0

    kept.sort(key=key, reverse=True)
    limit = int(f.get("limit", 100))
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
    vol = ranks(lambda r: r["volume_ref_per_h"] if r["volume_ref_per_h"] is not None else INF)
    vel = ranks(lambda r: INF if r["velocity_inf"] else (r["velocity"] if r["velocity"] is not None else -INF))
    for r in routes:
        r["score"] = round((w_vel * vel[r["id"]] + w_eff * eff[r["id"]] + w_val * val[r["id"]] + w_vol * vol[r["id"]]) / total, 4)
        r["score_parts"] = {"velocity": round(vel[r["id"]], 3), "efficiency": round(eff[r["id"]], 3),
                            "value": round(val[r["id"]], 3), "volume": round(vol[r["id"]], 3)}


def edge_table() -> list[dict]:
    g = Graph.build()
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
