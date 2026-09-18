"""Bellman-Ford negative-cycle search — "is there a profitable loop anywhere, and which one?"

On an exchange graph weighted `-log(rate)`, a loop whose rates multiply above 1 is a cycle
whose weights sum below 0 (`profitable_loop`). Bellman-Ford finds one in O(|V|·|E|) with no hop
cap, where `Graph.iter_cycles` enumerates every simple cycle up to `max_steps`. It sees
top-of-book rates only: a loop it returns is a CANDIDATE that still has to go through
`arbitrage.simulate` (depth, whole-unit rounding, gold fees) before it is a route.

Both implementations are the pseudocode of
https://en.wikipedia.org/wiki/Bellman%E2%80%93Ford_algorithm#Algorithm — vertices are the
integers [0..n-1], edges are three parallel arrays (src, dst, w), `distance`/`predecessor` are
arrays of size n (null predecessor = -1), and a negative cycle is reported by raising with the
cycle attached:

  * `bellman_ford_naive` — the pseudocode line for line: one edge at a time, in list order,
    each relaxation seeing the ones before it. The executable SPECIFICATION; never the fast path.
  * `bellman_ford` — the numpy one: a round relaxes EVERY edge at once from the previous
    round's distances. Same steps 1-3, same proof (the article's lemma — after i rounds,
    distance[v] is at most the shortest path of at most i edges — holds for both), but no
    Python-level loop over edges.
They may pick different predecessors / a different negative cycle ("the choices among equally
short paths depend on the order of edges relaxed, but the final distances remain the same"), so
`tests/test_negcycle.py` holds the parallel one to: same verdict, bit-identical distances, and a
returned cycle that really is one and really sums below zero — against the naive one, against a
brute-force enumerator, and (`test_negcycle_networkx.py`) against networkx's distances.

Two additions to the pseudocode, both from the article's own text:
  * early exit when a round relaxes nothing ("Improvements") — parallel version only;
  * `source=None` starts every vertex at 0, i.e. a virtual super-source with a free edge to
    every vertex: finds a negative cycle ANYWHERE, not just downstream of one vertex.
And one for floats: `tol` — an edge relaxes only if it improves by MORE than `tol` (0 = the
pseudocode exactly). A reported cycle then sums below `-tol`, so float dust around a
break-even loop is never reported as profit.

NEEDS NUMPY (in `backend/requirements.txt`; `arbitrage/deepscan.py` calls this from the route
search and degrades to no deep loops if the import fails).
"""
from __future__ import annotations

import math

import numpy as np

NULL = -1                 # the pseudocode's null predecessor


class NegativeCycle(Exception):
    """The pseudocode's `error "Graph contains a negative-weight cycle", ncycle`. `.cycle` is
    the list of distinct vertices in travel order; the last one hops back to the first."""

    def __init__(self, cycle: list[int]):
        super().__init__(f"Graph contains a negative-weight cycle: {cycle}")
        self.cycle = cycle


def _check(n, src, dst, w, source):
    src = np.asarray(src, dtype=np.int64)
    dst = np.asarray(dst, dtype=np.int64)
    w = np.asarray(w, dtype=np.float64)
    if not (src.ndim == dst.ndim == w.ndim == 1 and len(src) == len(dst) == len(w)):
        raise ValueError("src, dst and w must be 1-D arrays of one length")
    if len(src) and (src.min() < 0 or dst.min() < 0 or src.max() >= n or dst.max() >= n):
        raise ValueError(f"edge endpoint outside [0..{n - 1}]")
    if np.isnan(w).any():
        raise ValueError("NaN edge weight")
    if source is not None and not 0 <= source < n:
        raise ValueError(f"source {source} outside [0..{n - 1}]")
    return src, dst, w


def _initialize(n, source):
    # Step 1: initialize graph
    distance = np.full(n, np.inf)
    predecessor = np.full(n, NULL, dtype=np.int64)
    if source is None:
        distance[:] = 0.0            # virtual super-source, one free edge to every vertex
    else:
        distance[source] = 0.0       # The distance from the source to itself is zero
    return distance, predecessor


def _cycle_through(predecessor, u, v) -> list[int]:
    """Step 3's tail, verbatim: (u, v) still relaxes, so a negative cycle exists; v "must be
    reachable from a negative cycle, but it isn't necessarily part of the cycle itself", so
    follow predecessors back from u until a vertex repeats — THAT vertex is on the cycle."""
    predecessor[v] = u
    visited = np.zeros(len(predecessor), dtype=bool)
    visited[v] = True
    while not visited[u]:
        visited[u] = True
        u = int(predecessor[u])
        if u == NULL:
            # Impossible in exact arithmetic (a predecessor chain that reaches the source
            # would make (u, v) a shorter SIMPLE path than the shortest one). Never index -1.
            raise RuntimeError("predecessor chain ended before closing a negative cycle")
    # u is a vertex in a negative cycle, find the cycle itself
    ncycle = [u]
    v = int(predecessor[u])
    while v != u:
        ncycle.insert(0, v)
        v = int(predecessor[v])
    return ncycle


def bellman_ford_naive(n, src, dst, w, source, tol: float = 0.0):
    """The Wikipedia pseudocode, line for line. Returns (distance, predecessor); raises
    `NegativeCycle` if one is reachable from `source` (from anywhere, if `source` is None)."""
    src, dst, w = _check(n, src, dst, w, source)
    distance, predecessor = (a.tolist() for a in _initialize(n, source))   # plain lists: the
    edges = list(zip(src.tolist(), dst.tolist(), w.tolist()))              # loop below is scalar

    # Step 2: relax edges repeatedly
    for _ in range(n - 1):
        for u, v, wt in edges:
            if distance[u] + wt < distance[v] - tol:
                distance[v] = distance[u] + wt
                predecessor[v] = u

    # Step 3: check for negative-weight cycles
    for u, v, wt in edges:
        if distance[u] + wt < distance[v] - tol:
            raise NegativeCycle(_cycle_through(np.array(predecessor, dtype=np.int64), u, v))
    return np.array(distance), np.array(predecessor, dtype=np.int64)


def bellman_ford(n, src, dst, w, source, tol: float = 0.0):
    """The same algorithm with each round done as array operations. Returns
    (distance, predecessor); raises `NegativeCycle` exactly when `bellman_ford_naive` does."""
    src, dst, w = _check(n, src, dst, w, source)
    distance, predecessor = _initialize(n, source)

    # Step 2: relax edges repeatedly — all of them at once, from this round's starting distances
    for _ in range(n - 1):
        candidate = distance[src] + w                   # distance[u] + w, for every edge
        best = np.full(n, np.inf)
        np.minimum.at(best, dst, candidate)             # the cheapest way into each vertex
        improved = best < distance - tol                # "if distance[u] + w < distance[v]"
        if not improved.any():
            break                                       # early exit: nothing relaxed this round
        winner = improved[dst] & (candidate == best[dst])
        predecessor[dst[winner]] = src[winner]          # ties: any of them is a shortest path
        distance = np.where(improved, best, distance)

    # Step 3: check for negative-weight cycles
    still = np.flatnonzero(distance[src] + w < distance[dst] - tol)
    if len(still):
        e = int(still[0])
        raise NegativeCycle(_cycle_through(predecessor, int(src[e]), int(dst[e])))
    return distance, predecessor


def find_negative_cycle(n, src, dst, w, source=None, tol: float = 0.0) -> list[int] | None:
    """A negative cycle (distinct vertices, travel order) or None. `source=None`: anywhere."""
    try:
        bellman_ford(n, src, dst, w, source, tol)
    except NegativeCycle as e:
        return e.cycle
    return None


def profitable_loop(rates: dict[tuple[str, str], float], min_gain: float = 1e-9) -> list[str] | None:
    """`{(have, want): rate}` → a loop of currency ids whose rates multiply above 1, or None.
    `rate` = units of `want` per unit of `have`; weight = -log(rate), so a loop multiplying to
    m weighs -log(m). `min_gain` is `tol` in those log units (≈ the fractional gain when small):
    a reported loop always gains more than it; the default only filters float dust.
    Non-positive rates are not tradable and are skipped."""
    ids: dict[str, int] = {}
    src, dst, w = [], [], []
    for (a, b), rate in rates.items():
        if rate > 0:
            src.append(ids.setdefault(a, len(ids)))
            dst.append(ids.setdefault(b, len(ids)))
            w.append(-math.log(rate))
    if not src:
        return None
    cyc = find_negative_cycle(len(ids), src, dst, w, source=None, tol=min_gain)
    if cyc is None:
        return None
    names = list(ids)
    return [names[i] for i in cyc]
