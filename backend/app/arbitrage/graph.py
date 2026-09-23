"""The exchange graph: nodes are trade ids, directed edges are ways to turn `from` into `to`.
  * digest    — GGG hourly VWAP, single synthetic offer sized by highest stock (the sole price
                source; the "live" kind is kept as a data type for tests and older callers)
  * recipe    — off-exchange combine/disenchant; no gold, lot-sized input
Plus the fill model every feature shares: simulate() walks a list of edges with whole-unit
rounding and the gold fee model; route_cap/cycle_unit size a path by its liquidity.
"""
from __future__ import annotations

import heapq
import math
from .. import cache, digest, gamedata, leaguehistory, orderbook, recipes
from ..currencies import registry
from ..settings import get_settings
from dataclasses import dataclass, field

INF = float("inf")
# How far a market may sit from poe2scout's independent close and still price a currency.
# Thin-but-honest markets run 2-3x from it; the trades that are not prices run thousands.
OUTSIDE_DISAGREEMENT = 10.0
def counterparts_by_volume(g, rv: dict[str, float] | None = None) -> dict[str, list[tuple[float, str]]]:
    """THE volume rule: per currency, its counterpart markets ranked by how many UNITS OF THAT
    CURRENCY the market moves an hour — what it sold there plus what the other side's sales
    bought (that side's units × the market's rate). Owner, 2026-09-23: the busiest market is the
    one that trades the most of the currency; not the most value (chaos and divine pay 10-20x more
    per Thaumaturgic Flux than the exalted market that moves five times the flux), not the
    counterparty's units (12.5M exalts for an omen are 146k omens against 460k in divine), and
    not gold (charging it needs the currency's own value, which is what is unreliable when it
    matters). `rv` is accepted for the callers that pass it and ignored: the pick never moves
    with the value table. The Board's default numeraire, the league arc's fallback numeraire and
    the value table (`Graph.quote_busiest_markets`, `Graph._widest_values`) all walk this
    ranking; nothing else defines "the market that trades a currency"."""
    units: dict[tuple[str, str], float] = {}          # (currency, counterpart) -> units of currency per hour
    for (a, b), e in g.edges.items():
        if e.kind == "recipe" or not e.vol_in_per_h or e.rate <= 0:
            continue
        units[(a, b)] = units.get((a, b), 0.0) + e.vol_in_per_h                 # a sold for b
        units[(b, a)] = units.get((b, a), 0.0) + e.vol_in_per_h * e.rate        # b bought with that a
    ranked: dict[str, list[tuple[float, str]]] = {}
    for (c, other), u in units.items():
        if u > 0:
            ranked.setdefault(c, []).append((u, other))
    for lst in ranked.values():
        lst.sort(reverse=True)
    return ranked


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
        self._values: dict[str, float] | None = None     # Graph.values(), once per build
        self.priced_by: dict[str, str] = {}              # currency -> the counterpart that prices it
        self.busiest: dict[str, str] = {}                # currency -> its busiest counterpart (the volume rule)

    def add(self, e: Edge) -> None:
        self.edges[(e.src, e.dst)] = e
        self.adj.setdefault(e.src, []).append(e)
        self._values = None
        self.priced_by = {}          # the parent map belongs to the table it was built with
        self.sources[e.kind] += 1

    # ------------------------------------------------------------ build
    @classmethod
    def build(cls) -> "Graph":
        s = get_settings()
        g = cls(s)
        g.fee_table = gamedata.fees()["by_trade"]
        league = s["league"]
        # The hourly digest is the sole price source: the Bulk Item Exchange (whisper listings,
        # not the in-game order book) is retired (owner, 2026-09-17; for good, 2026-09-23), and
        # GGG exposes no live book for the in-game exchange.
        executed = digest.latest_rates(league, s["digest_max_age_h"])
        if s["allow_digest_edges"]:
            for (a, b), d in executed.items():
                if (a, b) in g.edges:
                    continue
                g.add(Edge(a, b, "digest", d["rate"], [{"rate": d["rate"], "stock": d["stock"]}],
                           d["age_s"], meta={"hour": d["hour"], "volume": d["volume_to"],
                                             "inactive": d.get("inactive", False),
                                             "quoted_rate": d.get("quoted_rate")}))
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
                g._values, g.priced_by = None, {}
                g.adj = {}
                for e in g.edges.values():
                    g.adj.setdefault(e.src, []).append(e)
        g.quote_busiest_markets()
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
        inverse of n→c, else None. Whether that market PRICES c is values()'s answer (priced_by)."""
        e = self.edges.get((c, n))
        if e and e.rate > 0:
            return e.rate
        e = self.edges.get((n, c))
        if e and e.rate > 0:
            return 1.0 / e.rate
        return None

    def quote_busiest_markets(self) -> None:
        """A currency's BUSIEST market is always quoted and always prices it (owner, 2026-09-23):
        the market that actually trades a currency sets its price whatever the spread rule or
        poe2scout say about it. Busiest is THE volume rule (`counterparts_by_volume`, the same
        ranking the Board's default numeraire and the league arc walk) — units of the currency,
        so it needs no value table and cannot be moved by one. A dead edge on such a market takes
        its `quoted_rate` (the window rate) and stops being dead; the extreme pricing of
        2026-09-19 stays for a currency's secondary markets. Ulaman's Gaze read 44.66 ex off a
        dead exalted market while its chaos market moved twice the gazes."""
        ranked = counterparts_by_volume(self)
        self.busiest = {c: lst[0][1] for c, lst in ranked.items() if lst}
        changed = False
        for c, other in self.busiest.items():
            for key in ((c, other), (other, c)):
                e = self.edges.get(key)
                if e and e.kind != "recipe" and e.meta.get("inactive") and e.meta.get("quoted_rate"):
                    e.rate = e.meta["quoted_rate"]
                    if e.ladder:
                        e.ladder[0]["rate"] = e.rate
                    e.meta["inactive"] = False
                    e.meta["quoted_by_volume_rule"] = True
                    changed = True
        if changed or self._values is not None:
            self._values, self.priced_by = None, {}

    def values(self) -> dict[str, float]:
        """THE value of 1 unit of each currency in the reference — the one table every screen
        prices from (Board, zoomed card, Capital and its cash-out, wealth, Hold, Movers).

        The volume rule, applied once for the whole market: each currency is valued through its
        DEEPEST chain of markets from the reference — a widest path, where a market's width is the
        value it trades per hour and a chain is as wide as its thinnest market. A Preserved Cranium
        is priced through Divine (~11M ex/h), not its direct Exalted market (~30k ex/h, half the
        price). Markets nobody quotes are skipped while a quoted one exists (`dead`, from the
        digest's inactive flag), so a couple of scattered trades cannot set what a thing is worth —
        judging them against "the cheapest price anywhere" instead let the junk set its own
        yardstick and a cranium worth ~6,900 ex was priced off a market trading 46 ex an hour.
        Each hop uses the market's own rate, so a card shown in the market that prices it shows
        exactly that market's rate.

        Currencies with no market at all fall back to `ref_values` (the poe2scout fallback).
        EVERYTHING prices from here — the Board, cards, Capital, cash-out, wealth, Hold, Movers,
        Convert and the Arbitrage routes — so no two screens can disagree about what a thing is
        worth."""
        if self._values is None:
            self._values = self._widest_values()
        return self._values

    def _widest_values(self) -> dict[str, float]:
        ref = self.s["reference"]
        nbrs: dict[str, set[str]] = {}
        for (a, b), e in self.edges.items():
            if e.kind != "recipe" and e.rate > 0:
                nbrs.setdefault(a, set()).add(b)
                nbrs.setdefault(b, set()).add(a)

        def market(a: str, b: str):
            """The a->b EXCHANGE edge (never a vendor recipe: a recipe is a fixed rate nobody
            trades at, and pricing a shard off one read it at half its market price)."""
            e = self.edges.get((a, b))
            return e if (e and e.kind != "recipe" and e.rate > 0) else None

        def market_rate(a: str, b: str) -> float:
            """b per a from the a<->b market itself, either direction, recipes ignored."""
            e = market(a, b)
            if e:
                return e.rate
            e = market(b, a)
            return (1.0 / e.rate) if e else 0.0

        def dead(u: str, v: str) -> bool:
            """Whether the u<->v market is one nobody quotes (digest.directed_rates flagged its
            traded hours as disagreeing). Such a market is priced at its ask/bid, which is honest
            for TRADING it, but it must not set what anything is WORTH while a real market exists:
            Tecrod's Gaze read 88 exalted off a market that trades a couple a day, against the
            12 divine its own steady market pays."""
            e = market(u, v) or market(v, u)
            return bool(e and e.meta.get("inactive"))

        def has_live_market(c: str) -> bool:
            return any(not dead(c, n) for n in nbrs.get(c, ()))

        def units(u: str, v: str) -> tuple[float, float]:
            """(units of u, units of v) traded per hour in the u<->v market, each direction
            converted at the market's own rate."""
            uv, vu = market(u, v), market(v, u)
            vol_uv = (uv.vol_in_per_h or 0.0) if uv else 0.0      # u sold per hour
            vol_vu = (vu.vol_in_per_h or 0.0) if vu else 0.0      # v sold per hour
            v_per_u = market_rate(u, v)
            u_per_v = (1.0 / v_per_u) if v_per_u else 0.0
            return vol_uv + vol_vu * u_per_v, vol_vu + vol_uv * v_per_u

        scout_px = self._scout_values()

        def believable(c: str, px: float) -> bool:
            """Whether a market's claim about `c` survives evidence from OUTSIDE the exchange.
            poe2scout's close is the only yardstick used here on purpose: every yardstick drawn
            from the exchange itself was one the junk market could set (a fat-finger that moved
            2,900 Divine for 53 essences was its own proof, and a cranium worth ~6,900 ex was
            judged against 441). With no outside price, the deepest market wins."""
            outside = scout_px.get(c)
            return not outside or max(outside, px) <= OUTSIDE_DISAGREEMENT * min(outside, px)

        vals: dict[str, float] = {ref: 1.0}
        priced_by: dict[str, str] = {}
        width: dict[str, float] = {ref: INF}

        def relax(through_dead: bool) -> None:
            """The widest-path walk from everything priced so far. The first pass refuses a dead
            market for any currency that has a live one; the second prices only what the first
            could not, through its dead market, at the bid the walk always gives a dead market —
            the same price it would get with no other market at all. Without it such a currency
            fell through `ref_values`, which reads the same dead market at its ASK, so an
            unrelated market hanging off it moved a gaze from 87.5 ex to 3,114."""
            heap = [(-width[c], c) for c in vals]
            heapq.heapify(heap)
            done: set[str] = set()
            while heap:
                w, u = heapq.heappop(heap)
                if u in done:
                    continue
                done.add(u)
                for v in nbrs.get(u, ()):
                    if v in done or (through_dead and v in vals):
                        continue
                    px = market_rate(v, u)                             # u per v
                    if not px or (not through_dead and dead(u, v) and has_live_market(v)) \
                            or not believable(v, px * vals[u]):
                        continue
                    cand = min(-w, units(u, v)[0] * vals[u])           # as deep as its thinnest market
                    if cand > width.get(v, 0.0):
                        width[v] = cand
                        vals[v] = vals[u] * px
                        priced_by[v] = u                               # the market this price came from
                        heapq.heappush(heap, (-cand, v))

        relax(through_dead=False)
        if any(c not in vals for c in nbrs):
            relax(through_dead=True)
        # The volume rule, last word: a currency is worth what its BUSIEST market says, priced
        # off that counterpart's value — not the widest chain (by value the flux's divine market
        # at ~500 ex out-widens its exalted market at ~25, which moves five times the flux), and
        # not poe2scout's close (`believable` guards secondary markets; the market that trades a
        # currency cannot be vetoed by an outside close that broke 23 cards on 2026-09-23).
        # Only through a counterpart that sits closer to the reference than the currency itself,
        # so a hub is never re-priced through one of the small things that trade against it.
        for c, b in self.busiest.items():
            if c == ref or b not in vals or width.get(b, 0.0) <= width.get(c, 0.0):
                continue
            if self.busiest.get(b) == c and c in vals:
                continue                                   # each other's busiest market: the walk stands
            px = market_rate(c, b)                         # b per c, from the busiest market itself
            if px > 0:
                vals[c] = vals[b] * px
                priced_by[c] = b
                width[c] = min(width[b], units(b, c)[0] * vals[b])
        self.priced_by = priced_by
        # Whatever no market priced: poe2scout's close first (an independent source), then
        # ref_values. A currency whose every market failed the side test must NOT come back at the
        # price those same markets implied.
        for c, x in scout_px.items():
            vals.setdefault(c, x)
        for c, x in self.ref_values().items():
            vals.setdefault(c, x)
        return vals

    def _scout_values(self) -> dict[str, float]:
        """poe2scout's latest close per currency, in the reference — evidence from outside the
        exchange, used to size the far side of a market and to price what no market priced."""
        scout = leaguehistory.scout_prices(self.s["league"])       # never raises (logs + {} on failure)
        if not scout:
            return {}
        ex = self.direct_rate("exalted", self.s["reference"]) if self.s["reference"] != "exalted" else 1.0
        out: dict[str, float] = {}
        for cid in registry.by_id:
            px = leaguehistory.scout_lookup(scout, cid)
            if px and ex:
                out[cid] = px * ex
        return out

    def ref_values(self) -> dict[str, float]:
        """Naive value of 1 unit of each currency in the reference — INTERNAL to `values()`, which
        is the app's value table. It prices the far side of each market while the widest path is
        being built, and prices whatever has no market at all.

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
    g = cached_graph()
    V = g.values()
    out = {s["reference"]: 1.0}
    # The one value table every priced amount uses (Graph.values) — a holding valued by one rule
    # and re-denominated by another once read "1000 divine ≈ 988 divine".
    for tid in ("exalted", "chaos", "divine", "mirror"):
        px = V.get(tid)
        if px:
            out[tid] = float(px)
    return out
