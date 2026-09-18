"""The exchange graph: nodes are trade ids, directed edges are ways to turn `from` into `to`.
  * live      — top-of-book ladder from the exchange API (best rate first)
  * digest    — GGG hourly VWAP, single synthetic offer sized by highest stock
  * recipe    — off-exchange combine/disenchant; no gold, lot-sized input
Plus the fill model every feature shares: simulate() walks a list of edges with whole-unit
rounding and the gold fee model; route_cap/cycle_unit size a path by its liquidity.
"""
from __future__ import annotations

import math
from .. import cache, digest, gamedata, leaguehistory, orderbook, recipes
from ..currencies import registry
from ..settings import get_settings
from dataclasses import dataclass, field

INF = float("inf")
BAIT_FACTOR = 1.5     # a live offer paying > this × the pair's EXECUTED (digest) rate is bait


def credible_offers(offers: list[dict], executed_rate: float | None) -> list[dict]:
    """The part of a live ladder worth believing. Bulk-exchange price-fixers park absurdly cheap
    listings they never honour (2026-09-17: Omen of Light listed at 1, 10 and 55 exalted while it
    TRADED at ~2,261); sorted best-first they are the top of the book and turn into +25,000%
    loops. The hourly digest is executed volume — the truth — so an offer paying more than
    BAIT_FACTOR × that rate is dropped. A real edge is a few percent, never a multiple. With no
    executed rate for the pair there is nothing to judge by: the book is returned as is."""
    if not executed_rate or executed_rate <= 0:
        return offers
    return [o for o in offers if o["rate"] <= executed_rate * BAIT_FACTOR]


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
        # Executed rates judge the live books (credible_offers) even when digest EDGES are off.
        executed = digest.latest_rates(league, s["digest_max_age_h"])
        for (a, b), book in live.items():
            offers = credible_offers(book["offers"], (executed.get((a, b)) or {}).get("rate"))
            if not offers:
                continue              # the whole book was bait — the digest edge (if any) stands in
            g.add(Edge(a, b, "live", offers[0]["rate"], offers, book["age_s"],
                       meta={"depth": len(offers), "bait_dropped": len(book["offers"]) - len(offers)}))
        if s["allow_digest_edges"]:
            for (a, b), d in executed.items():
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
    def direct_rate(self, c: str, n: str) -> float | None:
        """Price of 1 `c` in `n` from the c↔n market itself: the c→n edge's rate, else the
        inverse of n→c, else None. The display layer prefers this over a cross through the
        reference (`rv[c] / rv[n]`), because the two can disagree by 10–70% when the triangle
        c/n/reference doesn't close in the hourly digest — the Divine tile once showed 7.3 chaos
        while the divine↔chaos market traded at 8.4."""
        e = self.edges.get((c, n))
        if e and e.rate > 0:
            return e.rate
        e = self.edges.get((n, c))
        if e and e.rate > 0:
            return 1.0 / e.rate
        return None

    def pair_rates(self, currencies, numeraires) -> dict[str, float]:
        """`{"c>n": direct_rate}` for every (c, n) pair that has its own market. Only pairs
        with a market are present, so a consumer falls back to the reference cross by key miss."""
        out = {}
        for c in currencies:
            for n in numeraires:
                if n == c:
                    continue
                r = self.direct_rate(c, n)
                if r:
                    out[f"{c}>{n}"] = r
        return out

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
        scout = leaguehistory.scout_prices(self.s["league"])   # never raises (logs + {} on failure)
        ex = vals.get("exalted")                     # reference-per-exalted
        if scout and ex:
            for cid in registry.by_id:
                if cid in vals:
                    continue
                px = leaguehistory.scout_lookup(scout, cid)
                if px:
                    vals[cid] = px * ex
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
    slowest_step_hours = 0.0     # the worst step's share of its market: units in ÷ units/h traded
    overhead_h = float(g.s.get("step_overhead_min", 0)) / 60
    max_age = 0.0
    all_live = True
    for e in cycle:
        used, out, fills = e.fill(amt)
        if e.kind != "recipe":
            v = e.vol_in_per_h or 0.0
            volume_ref_per_h = min(volume_ref_per_h, v * ref_value.get(e.src, 0.0))
            fill_hours += ((used / v) if v > 0 else INF) + overhead_h
            slowest_step_hours = max(slowest_step_hours, (used / v) if v > 0 else INF)
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
        "slowest_step_hours": None if slowest_step_hours == INF else slowest_step_hours,
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
_graph_cache: dict = {}
GRAPH_TTL_S = 5.0


def cached_graph() -> Graph:
    """Graph.build() with a short TTL so header polling, capital valuation and route
    search share one build instead of re-reading the digest tables per request."""
    s = get_settings()
    key = (s["league"], s["reference"], s["allow_digest_edges"], s["allow_recipe_edges"],
           s["live_max_age_s"], s["digest_max_age_h"],
           s.get("min_edge_volume_ref_per_h"), s.get("min_edge_depth"))
    return cache.memo(_graph_cache, key, GRAPH_TTL_S, Graph.build, version=orderbook.state["version"])


def anchor_prices() -> dict[str, float]:
    """Reference-per-unit prices of the currencies the UI re-denominates wealth into (the
    display-layer wealth rule: ex under the hood, chaos/divine on screen when the amount is
    large). Reads the cached graph, so it is cheap enough to ride the 30s status poll."""
    s = get_settings()
    rv = cached_graph().ref_values()
    out = {s["reference"]: 1.0}
    for tid in ("exalted", "chaos", "divine", "mirror"):
        if rv.get(tid):
            out[tid] = float(rv[tid])
    return out
