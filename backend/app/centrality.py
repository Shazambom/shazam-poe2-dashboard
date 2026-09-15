"""Exchange-graph centrality — which currencies are the market's connective tissue.

Two stdlib measures over the SAME liquidity-weighted exchange graph the rest of the app
already builds (`arbitrage.Graph`), so "central" means "a lot of executed value actually
flows here," not merely "many thin edges":

  * pagerank()         — HUB score: value flowing into/through a node. Drives the Board
                         "hub" chip.
  * betweenness_lite() — BRIDGE score: how often routes between other currencies pass
                         through a node. Drives the Convert bridge tie-break. "Lite" = it
                         reuses `Graph.iter_paths` (the exact DFS the route search uses),
                         bounded to the top-K currencies rather than all-pairs.
  * hubs()             — the top-N hub ids the Board lights up.
  * scores()           — cached {"hub":…, "bridge":…}, memoized per orderbook version like
                         board(); the read surface Phase 4's propagation priors consume.

Pure over a Graph (no DB) except scores(). NOT networkx: this must stay always-available
and dependency-free so a request can never depend on a heavy import (see CLAUDE.md
"Heavy analytics"). Computed live from the in-memory graph — nothing is persisted, so it
touches no DB and needs no snapshot.
"""
from __future__ import annotations

import time

DAMPING = 0.85           # PageRank teleport/follow split (standard 0.85)
_MAX_ITER = 100          # power-iteration cap (converges in ~tens on these small graphs)
_TOL = 1e-9              # L1 convergence threshold
BRIDGE_TOP_K = 12        # betweenness enumerated among the K most valuable currencies
HUB_N = 5                # how many currencies get the Board hub chip
_CACHE_TTL_S = 30.0      # scores() memo window (matches board())

_cache: tuple[int, float, dict] | None = None   # (orderbook version, ts, result)


def _weights(g, rv: dict[str, float]) -> dict[tuple[str, str], float]:
    """Directed edge weights = executed reference-value per hour (units/h × ref value of the
    source). Recipes and zero-volume/valueless edges carry no flow. This is exactly the
    measure board() already ranks counterpart markets by."""
    w: dict[tuple[str, str], float] = {}
    for (a, b), e in g.edges.items():
        if e.kind == "recipe":
            continue
        val = (e.vol_in_per_h or 0.0) * (rv.get(a) or 0.0)
        if val > 0:
            w[(a, b)] = val
    return w


def pagerank(g, rv: dict[str, float], d: float = DAMPING) -> dict[str, float]:
    """Weighted PageRank via power iteration; higher = more central 'hub'. Dangling nodes
    (no out-edges) redistribute their mass uniformly so no rank leaks. Sums to ~1."""
    w = _weights(g, rv)
    nodes = {a for a, _ in w} | {b for _, b in w}
    n = len(nodes)
    if n == 0:
        return {}
    out: dict[str, float] = {}          # node → total outgoing weight
    inc: dict[str, list[tuple[str, float]]] = {}   # node → [(src, weight)]
    for (a, b), val in w.items():
        out[a] = out.get(a, 0.0) + val
        inc.setdefault(b, []).append((a, val))
    pr = {x: 1.0 / n for x in nodes}
    for _ in range(_MAX_ITER):
        dangling = sum(pr[x] for x in nodes if out.get(x, 0.0) == 0.0)
        base = (1.0 - d) / n + d * dangling / n
        nxt = {x: base for x in nodes}
        for b, srcs in inc.items():
            nxt[b] += d * sum(pr[a] * val / out[a] for a, val in srcs if out.get(a, 0.0) > 0)
        if sum(abs(nxt[x] - pr[x]) for x in nodes) < _TOL:
            pr = nxt
            break
        pr = nxt
    return pr


def betweenness_lite(g, rv: dict[str, float], top_k: int = BRIDGE_TOP_K,
                     max_steps: int | None = None) -> dict[str, float]:
    """BRIDGE score: fraction of enumerated top-K routes that pass through each node as an
    intermediate. Reuses `Graph.iter_paths` (the route-search DFS), bounded to ordered pairs
    among the `top_k` most valuable currencies and the same MAX_CANDIDATES cap the route
    search uses — that boundedness is what makes it 'lite' (not all-pairs betweenness)."""
    from .arbitrage import MAX_CANDIDATES

    if max_steps is None:
        max_steps = int(g.s.get("max_steps", 4))
    nodes = {a for a, _ in g.edges} | {b for _, b in g.edges}
    ranked = sorted(nodes, key=lambda x: rv.get(x, 0.0), reverse=True)[:top_k]
    counts: dict[str, float] = {}
    total = 0
    for src in ranked:
        for dst in ranked:
            if src == dst:
                continue
            seen = 0
            for path in g.iter_paths(src, dst, max_steps):
                seen += 1
                if seen > MAX_CANDIDATES:
                    break
                total += 1
                for e in path[:-1]:          # every edge's dst except the final one = intermediates
                    counts[e.dst] = counts.get(e.dst, 0.0) + 1.0
    if total == 0:
        return {}
    return {k: v / total for k, v in counts.items()}


def hubs(g, rv: dict[str, float], n: int = HUB_N) -> set[str]:
    """The top-`n` most central currencies by PageRank — the set the Board hub chip lights."""
    pr = pagerank(g, rv)
    return set(sorted(pr, key=pr.get, reverse=True)[:n])


def seed_missing(watchlist: list[str], hub_ids: set[str], reference: str) -> list[str]:
    """Hub currencies to add to the board's watchlist so the central markets show by default:
    the detected hubs not already watched, excluding the reference (never a board row).
    Stable-ordered, no duplicates. Empty when hubs aren't known yet (cold graph) so the
    one-time seed WAITS for real hubs rather than seeding nothing and marking itself done."""
    return [h for h in sorted(hub_ids) if h != reference and h not in watchlist]


def scores() -> dict[str, dict[str, float]]:
    """Combined {"hub":…, "bridge":…} off the live cached graph, memoized per orderbook
    version (like board()). The read surface for Phase 4's propagation priors."""
    global _cache
    from . import arbitrage, orderbook

    ver = orderbook.state["version"]
    now = time.time()
    if _cache and _cache[0] == ver and now - _cache[1] < _CACHE_TTL_S:
        return _cache[2]
    g = arbitrage.cached_graph()
    rv = g.ref_values()
    result = {"hub": pagerank(g, rv), "bridge": betweenness_lite(g, rv)}
    _cache = (ver, now, result)
    return result
