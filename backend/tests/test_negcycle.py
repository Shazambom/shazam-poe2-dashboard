"""TDD for `app.negcycle` — Bellman-Ford negative-cycle search, from the Wikipedia pseudocode.

Two implementations of the SAME pseudocode
(https://en.wikipedia.org/wiki/Bellman%E2%80%93Ford_algorithm#Algorithm):
  * `bellman_ford_naive` — the pseudocode line for line: one edge at a time, in order.
  * `bellman_ford`       — the numpy one: every edge relaxed at once per round.
The naive one is the executable specification; the parallel one is what the app runs. They can
legitimately differ in WHICH predecessor / WHICH negative cycle they report (the article: "the
choices among equally short paths depend on the order of edges relaxed, but the final distances
remain the same"), so the contract checked here is:
  1. same verdict (negative cycle reachable or not),
  2. without one: IDENTICAL distances, and each one's predecessors rebuild those distances,
  3. with one: each returns a real cycle — every hop an edge, weights summing below zero.
Both are also checked against an oracle that shares nothing with Bellman-Ford: brute-force
enumeration of every simple cycle / every simple path on small graphs. (A third opinion from
the real networkx lives in `test_negcycle_networkx.py`.)

    python -m pytest backend/tests/test_negcycle.py -q
"""
import itertools
import math
import random
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import negcycle as nc  # noqa: E402

IMPLS = [nc.bellman_ford_naive, nc.bellman_ford]
INF = float("inf")


# ---------------------------------------------------------------- helpers
def arrays(edges):
    """[(u, v, w)] -> (src, dst, w) numpy arrays."""
    if not edges:
        return np.zeros(0, np.int64), np.zeros(0, np.int64), np.zeros(0)
    u, v, w = zip(*edges)
    return np.array(u, np.int64), np.array(v, np.int64), np.array(w, float)


def run(impl, n, edges, source):
    """('ok', dist, pred) or ('cycle', [vertices])."""
    try:
        dist, pred = impl(n, *arrays(edges), source)
        return ("ok", dist, pred)
    except nc.NegativeCycle as e:
        return ("cycle", e.cycle)


def best_weight(edges):
    best = {}
    for u, v, w in edges:
        best[(u, v)] = min(w, best.get((u, v), INF))
    return best


def assert_negative_cycle(edges, cyc):
    """A cycle is a list of DISTINCT vertices in travel order; the last hops back to the first."""
    W = best_weight(edges)
    assert len(cyc) >= 1 and len(set(cyc)) == len(cyc), cyc
    total = 0.0
    for a, b in zip(cyc, cyc[1:] + cyc[:1]):
        assert (a, b) in W, f"cycle {cyc} uses a non-edge {a}->{b}"
        total += W[(a, b)]
    assert total < 0, f"cycle {cyc} sums to {total}, not negative"


def assert_pred_rebuilds_dist(edges, source, dist, pred):
    """Each predecessor edge is tight: dist[v] == dist[pred[v]] + w — and walks end at source."""
    W = {}
    for u, v, w in edges:
        W.setdefault((u, v), []).append(w)
    for v in range(len(dist)):
        if v == source:
            assert pred[v] == -1 and dist[v] == 0
        elif dist[v] == INF:
            assert pred[v] == -1
        else:
            u = int(pred[v])
            assert u >= 0 and any(dist[u] + w == dist[v] for w in W[(u, v)]), (v, u)


def brute_force(n, edges, source):
    """Oracle with no Bellman-Ford in it. Returns (has_reachable_negative_cycle, dist-or-None):
    every simple cycle is enumerated by DFS; shortest distances are the min over every simple
    path (valid exactly when no negative cycle is reachable)."""
    W = best_weight(edges)
    out = {}
    for (u, v) in W:
        out.setdefault(u, []).append(v)
    reach, stack = {source}, [source]
    while stack:
        for v in out.get(stack.pop(), []):
            if v not in reach:
                reach.add(v)
                stack.append(v)

    def cycles_from(start):                       # simple cycles whose smallest vertex is start
        def dfs(node, path, total):
            for v in out.get(node, []):
                if v == start:
                    yield total + W[(node, v)]
                elif v > start and v not in path:
                    yield from dfs(v, path | {v}, total + W[(node, v)])
        yield from dfs(start, {start}, 0.0)

    # a cycle is reachable iff any of its vertices is; DFS only ever leaves `start` along edges,
    # so a cycle through a reachable start is wholly reachable.
    negative = any(t < 0 for s in sorted(reach) for t in cycles_from(s))
    if negative:
        return True, None
    dist = [INF] * n

    def walk(node, path, total):
        dist[node] = min(dist[node], total)
        for v in out.get(node, []):
            if v not in path:
                walk(v, path | {v}, total + W[(node, v)])
    walk(source, {source}, 0.0)
    return False, dist


def random_graph(rng, n, kind):
    density = rng.choice([0.1, 0.25, 0.5, 0.9])
    edges = []
    if kind == "rates":
        # an exchange: true values + spreads + quote noise → profitable loops rare but present
        val = [math.exp(rng.uniform(-5, 5)) for _ in range(n)]
        noise = rng.choice([0.0, 0.02, 0.06])
    lo = rng.choice([-2.0, -0.5, 0.0])
    for u in range(n):
        for v in range(n):
            if rng.random() >= density or (u == v and rng.random() < 0.7):
                continue
            if kind == "rates":
                if u == v:
                    continue
                rate = val[u] / val[v] * (1 - rng.uniform(0, 0.04)) * (1 + rng.uniform(-noise, noise))
                edges.append((u, v, -math.log(rate)))
            elif kind == "int":                      # exact ties everywhere
                edges.append((u, v, float(rng.randint(int(lo * 2), 6))))
            else:
                edges.append((u, v, rng.uniform(lo, 8.0)))
    if edges and rng.random() < 0.3:                 # parallel edges
        u, v, w = rng.choice(edges)
        edges.append((u, v, w - rng.uniform(0, 1)))
    rng.shuffle(edges)                               # edge order must not matter
    return edges


# ---------------------------------------------------------------- the article's own facts
@pytest.mark.parametrize("impl", IMPLS)
def test_worst_case_chain_needs_all_rounds(impl):
    """The article's figure: a 5-vertex chain with edges listed right-to-left needs the full
    |V|-1 rounds. (The parallel version ALWAYS needs path-length rounds — it must still get it.)"""
    edges = [(3, 4, 1.0), (2, 3, 1.0), (1, 2, 1.0), (0, 1, 1.0)]
    kind, dist, pred = run(impl, 5, edges, 0)
    assert kind == "ok"
    assert dist.tolist() == [0, 1, 2, 3, 4]
    assert pred.tolist() == [-1, 0, 1, 2, 3]


@pytest.mark.parametrize("impl", IMPLS)
def test_negative_edges_without_a_cycle(impl):
    edges = [(0, 3, 0.0), (0, 1, 1.0), (1, 2, -3.0), (2, 3, 1.0)]
    kind, dist, pred = run(impl, 4, edges, 0)
    assert kind == "ok"
    assert dist.tolist() == [0, 1, -2, -1]
    assert pred.tolist() == [-1, 0, 1, 2]


@pytest.mark.parametrize("impl", IMPLS)
def test_unreachable_vertices_stay_infinite(impl):
    kind, dist, pred = run(impl, 4, [(0, 1, 2.0), (2, 3, -5.0), (3, 2, 1.0)], 0)
    assert kind == "ok"                              # the negative cycle 2<->3 is NOT reachable
    assert dist.tolist() == [0, 2, INF, INF]
    assert pred.tolist() == [-1, 0, -1, -1]


@pytest.mark.parametrize("impl", IMPLS)
def test_zero_weight_cycle_is_not_negative(impl):
    edges = [(0, 1, 1.0), (1, 2, 1.0), (2, 3, 1.0), (3, 1, -2.0)]
    assert run(impl, 4, edges, 0)[0] == "ok"
    edges[-1] = (3, 1, -2.0001)
    kind, cyc = run(impl, 4, edges, 0)
    assert kind == "cycle" and sorted(cyc) == [1, 2, 3]
    assert_negative_cycle(edges, cyc)


@pytest.mark.parametrize("impl", IMPLS)
def test_cycle_is_reported_in_travel_order(impl):
    edges = [(0, 1, 1.0), (1, 2, 1.0), (2, 0, -5.0)]
    kind, cyc = run(impl, 3, edges, 0)
    assert kind == "cycle"
    i = cyc.index(0)
    assert cyc[i:] + cyc[:i] == [0, 1, 2]


@pytest.mark.parametrize("impl", IMPLS)
def test_flagged_vertex_downstream_of_the_cycle(impl):
    """The article: the edge found in step 3 "must be reachable from a negative cycle, but it
    isn't necessarily part of the cycle itself" — the tail 3->4->5 must not end up in the answer.
    (This is the case networkx's find_negative_cycle gives up on.)"""
    edges = [(0, 1, 1.0), (1, 2, 1.0), (2, 1, -3.0), (2, 3, 1.0), (3, 4, 1.0), (4, 5, 1.0)]
    for order in (edges, edges[::-1]):
        kind, cyc = run(impl, 6, order, 0)
        assert kind == "cycle" and sorted(cyc) == [1, 2]


@pytest.mark.parametrize("impl", IMPLS)
def test_negative_self_loop(impl):
    kind, cyc = run(impl, 2, [(0, 1, 1.0), (1, 1, -1.0)], 0)
    assert kind == "cycle" and cyc == [1]
    assert run(impl, 2, [(0, 1, 1.0), (1, 1, 0.0)], 0)[0] == "ok"      # zero self-loop: fine


@pytest.mark.parametrize("impl", IMPLS)
def test_parallel_edges_use_the_cheapest(impl):
    kind, dist, _ = run(impl, 2, [(0, 1, 5.0), (0, 1, 2.0), (0, 1, 9.0)], 0)
    assert kind == "ok" and dist.tolist() == [0, 2]


@pytest.mark.parametrize("impl", IMPLS)
def test_degenerate_inputs(impl):
    kind, dist, pred = run(impl, 1, [], 0)
    assert kind == "ok" and dist.tolist() == [0] and pred.tolist() == [-1]
    with pytest.raises(ValueError):
        impl(3, *arrays([(0, 1, 1.0)]), 3)                              # source out of range
    with pytest.raises(ValueError):
        impl(2, *arrays([(0, 2, 1.0)]), 0)                              # edge endpoint out of range
    with pytest.raises(ValueError):
        impl(2, np.array([0]), np.array([1, 0]), np.array([1.0]), 0)    # ragged edge arrays
    with pytest.raises(ValueError):
        impl(2, *arrays([(0, 1, float("nan"))]), 0)


@pytest.mark.parametrize("impl", IMPLS)
def test_source_none_searches_the_whole_graph(impl):
    """source=None starts every vertex at 0 (a virtual super-source): finds a negative cycle
    ANYWHERE, including one no single vertex of interest can reach."""
    edges = [(0, 1, 2.0), (2, 3, -5.0), (3, 2, 1.0)]
    kind, cyc = run(impl, 4, edges, None)
    assert kind == "cycle" and sorted(cyc) == [2, 3]
    assert run(impl, 4, [(0, 1, 2.0), (2, 3, -5.0), (3, 2, 5.0)], None)[0] == "ok"


# ---------------------------------------------------------------- fuzz: parallel vs naive vs brute force
@pytest.mark.parametrize("kind", ["float", "int", "rates"])
def test_fuzz_small_graphs_against_brute_force(kind):
    seen = {"cycle": 0, "ok": 0}
    for seed in range(400):
        rng = random.Random(f"small-{kind}-{seed}")
        n = rng.randint(1, 7)
        edges = random_graph(rng, n, kind)
        source = rng.randrange(n)
        negative, want = brute_force(n, edges, source)
        for impl in IMPLS:
            got = run(impl, n, edges, source)
            assert (got[0] == "cycle") == negative, (impl.__name__, kind, seed)
            if negative:
                assert_negative_cycle(edges, got[1])
            else:
                # brute force sums each path left to right exactly as Bellman-Ford accumulates
                # it, so the minima agree to the last bit for ints and to ~1 ulp for floats.
                assert got[1].tolist() == pytest.approx(want, rel=1e-12, abs=1e-12), (impl.__name__, kind, seed)
                assert_pred_rebuilds_dist(edges, source, got[1], got[2])
        seen["cycle" if negative else "ok"] += 1
    assert seen["cycle"] > 40 and seen["ok"] > 40, seen     # both branches really exercised


@pytest.mark.parametrize("kind", ["float", "int", "rates"])
def test_fuzz_parallel_matches_naive(kind):
    seen = {"cycle": 0, "ok": 0}
    for seed in range(300):
        rng = random.Random(f"big-{kind}-{seed}")
        n = rng.choice([2, 5, 13, 30, 60])
        edges = random_graph(rng, n, kind)
        for source in (rng.randrange(n), None):
            naive = run(nc.bellman_ford_naive, n, edges, source)
            fast = run(nc.bellman_ford, n, edges, source)
            assert naive[0] == fast[0], (kind, seed, source)
            if naive[0] == "cycle":
                assert_negative_cycle(edges, naive[1])
                assert_negative_cycle(edges, fast[1])
            else:
                assert fast[1].tolist() == naive[1].tolist(), (kind, seed, source)   # bit-identical
                if source is not None:
                    assert_pred_rebuilds_dist(edges, source, fast[1], fast[2])
                    assert_pred_rebuilds_dist(edges, source, naive[1], naive[2])
            seen[naive[0]] += 1
    assert seen["cycle"] > 40 and seen["ok"] > 40, seen


def test_edge_order_never_changes_the_parallel_answer():
    """Every edge is relaxed from the SAME previous-round distances, so shuffling the edge list
    cannot change distances (the naive one's intermediate states do depend on order)."""
    for seed in range(60):
        rng = random.Random(f"order-{seed}")
        n = rng.choice([5, 13, 30])
        edges = random_graph(rng, n, "float")
        a = run(nc.bellman_ford, n, edges, 0)
        b = run(nc.bellman_ford, n, sorted(edges), 0)
        assert a[0] == b[0]
        if a[0] == "ok":
            assert a[1].tolist() == b[1].tolist()


# ---------------------------------------------------------------- the exchange reading
def test_find_negative_cycle_returns_none_or_a_cycle():
    assert nc.find_negative_cycle(3, *arrays([(0, 1, 1.0), (1, 2, 1.0), (2, 0, 1.0)])) is None
    cyc = nc.find_negative_cycle(3, *arrays([(0, 1, 1.0), (1, 2, 1.0), (2, 0, -2.5)]))
    assert sorted(cyc) == [0, 1, 2]


def test_profitable_loop_is_a_negative_cycle():
    """weight = -log(rate): rates multiplying above 1 sum below 0 — and only then."""
    fair = {("a", "b"): 2.0, ("b", "c"): 3.0, ("c", "a"): 1 / 6.0 * 0.99}       # loses 1%
    assert nc.profitable_loop(fair) is None
    rich = {**fair, ("c", "a"): 1 / 6.0 * 1.02}                                  # gains 2%
    loop = nc.profitable_loop(rich)
    i = loop.index("a")
    assert loop[i:] + loop[:i] == ["a", "b", "c"]
    gain = math.prod(rich[(a, b)] for a, b in zip(loop, loop[1:] + loop[:1]))
    assert gain == pytest.approx(1.02)


def test_profitable_loop_ignores_float_dust_and_bad_rates():
    """Perfectly consistent rates multiply to 1.0 ± a few ulps around any loop; that is not an
    arbitrage. `min_gain` (log units ≈ fractional gain) is the floor: a reported loop always
    gains more than it."""
    val = {c: math.exp((ord(c) * 37 % 11) - 5.3) for c in "abcdefgh"}
    dust = {(a, b): val[a] / val[b] for a, b in itertools.permutations(val, 2)}   # every loop == 1 ± ulps
    assert nc.profitable_loop(dust) is None
    assert nc.profitable_loop({("a", "b"): 0.0, ("b", "a"): -3.0}) is None
    assert nc.profitable_loop({}) is None
    real = {("a", "b"): 2.0, ("b", "a"): 0.5 * 1.004}
    assert nc.profitable_loop(real, min_gain=0.001) is not None
    assert nc.profitable_loop(real, min_gain=0.01) is None
