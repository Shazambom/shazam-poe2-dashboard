"""CROSS-CHECK — `app.negcycle` against William Fiset's Bellman-Ford
(github.com/williamfiset/Algorithms, MIT — `graphtheory/BellmanFordEdgeList.java` and
`BellmanFordAdjacencyListTest.java`).

Fiset's steps 1-2 are the same algorithm as ours (relax every edge up to V-1 times, stop early
when a round relaxes nothing). His step 3 answers a DIFFERENT question than the Wikipedia
pseudocode: instead of extracting one negative cycle, it runs V-1 more rounds and marks every
vertex whose distance a negative cycle can drag down as -inf (the vertices ON a reachable
negative cycle plus everything downstream). That makes it a useful independent oracle:
  * his test cases, ported below, run against BOTH of our implementations;
  * `_fiset` is a line-for-line Python transliteration of his `bellmanFord` — reference code for
    tests only, never imported by the app — and the fuzz holds ours to it:
      - no -inf anywhere  ⇔ ours raises no NegativeCycle, and distances are BIT-IDENTICAL;
      - some -inf         ⇔ ours raises, and EVERY vertex of the cycle we return is one he
                            marked -inf (a cycle vertex he left finite would be a wrong cycle).

    python -m pytest backend/tests/test_negcycle_fiset.py -q
"""
import random
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
sys.path.insert(0, str(Path(__file__).resolve().parent))      # tests/ (shared fuzz helpers)
from test_negcycle import IMPLS, assert_negative_cycle, random_graph, run  # noqa: E402

INF, NINF = float("inf"), float("-inf")


def _fiset(edges, V, start):
    """BellmanFordEdgeList.bellmanFord, transliterated."""
    dist = [INF] * V
    dist[start] = 0

    relaxed_an_edge = True
    v = 0
    while v < V - 1 and relaxed_an_edge:
        relaxed_an_edge = False
        for frm, to, cost in edges:
            if dist[frm] + cost < dist[to]:
                dist[to] = dist[frm] + cost
                relaxed_an_edge = True
        v += 1

    relaxed_an_edge = True
    v = 0
    while v < V - 1 and relaxed_an_edge:
        relaxed_an_edge = False
        for frm, to, cost in edges:
            if dist[frm] + cost < dist[to]:
                dist[to] = NINF
                relaxed_an_edge = True
        v += 1
    return dist


# his test cases: (name, V, edges, expected dist from 0)
CASES = [
    ("unreachableNodeDoesNotPolluteCostOfReachableNeighbor", 4,
     [(0, 2, 5), (1, 2, -100)], [0, INF, 5, INF]),
    ("nodeReachableOnlyThroughUnreachableIntermediaryStaysUnreachable", 3,
     [(1, 2, 5)], [0, INF, INF]),
    ("unreachableNegativeCycleDoesNotTaintReachableNode", 4,
     [(0, 3, 10), (1, 2, -1), (2, 1, -1), (2, 3, 5)], [0, INF, INF, 10]),
    ("singleNode", 1, [], [0]),
    ("twoNodesDirectEdge", 2, [(0, 1, 7)], [0, 7]),
    ("shortestPathChosenOverLonger", 3, [(0, 2, 10), (0, 1, 3), (1, 2, 4)], [0, 3, 7]),
    ("negativeEdgeWeightWithoutCycle", 3, [(0, 1, 1), (1, 2, -2)], [0, 1, -1]),
    ("reachableNegativeCycleMarkedNegativeInfinity", 3,
     [(0, 1, 1), (1, 2, 1), (2, 1, -3)], [0, NINF, NINF]),
    ("nodeDownstreamOfNegativeCycleMarkedNegativeInfinity", 4,
     [(0, 1, 1), (1, 2, 1), (2, 1, -3), (2, 3, 5)], [0, NINF, NINF, NINF]),
    ("disconnectedGraph", 4, [(0, 1, 3), (2, 3, 1)], [0, 3, INF, INF]),
    ("exampleFromMain", 9,
     [(0, 1, 1), (1, 2, 1), (2, 4, 1), (4, 3, -3), (3, 2, 1), (1, 5, 4), (1, 6, 4), (5, 6, 5),
      (6, 7, 4), (5, 7, 3)], [0, 1, NINF, NINF, NINF, 5, 5, 8, INF]),
]


@pytest.mark.parametrize("name,V,edges,want", CASES, ids=[c[0] for c in CASES])
def test_transliteration_reproduces_his_expected_output(name, V, edges, want):
    """The reference is only worth comparing to if it IS his algorithm: it must give the exact
    arrays his own JUnit tests assert."""
    assert _fiset(edges, V, 0) == want


@pytest.mark.parametrize("impl", IMPLS)
@pytest.mark.parametrize("name,V,edges,want", CASES, ids=[c[0] for c in CASES])
def test_his_cases_against_ours(impl, name, V, edges, want):
    edges = [(u, v, float(w)) for u, v, w in edges]
    got = run(impl, V, edges, 0)
    if NINF in want:
        assert got[0] == "cycle", name
        assert_negative_cycle(edges, got[1])
        assert all(want[v] == NINF for v in got[1]), (name, got[1])
    else:
        assert got[0] == "ok" and got[1].tolist() == want, name


@pytest.mark.parametrize("impl", IMPLS)
def test_single_vertex_self_loop_is_where_we_differ(impl):
    """The one disagreement the fuzz found, pinned: his detection pass is bounded by V-1 like
    the relaxation pass, so with V == 1 it runs ZERO times and a negative self-loop on the only
    vertex goes unreported. Wikipedia's step 3 is one unconditional scan of the edges, which
    catches it. (Irrelevant to a market — a currency has no edge to itself — but it is why the
    fuzz below starts at V = 2.)"""
    edges = [(0, 0, -0.5)]
    assert _fiset(edges, 1, 0) == [0]
    got = run(impl, 1, edges, 0)
    assert got == ("cycle", [0])


@pytest.mark.parametrize("impl", IMPLS)
@pytest.mark.parametrize("kind", ["float", "int", "rates"])
def test_fuzz_against_fiset(impl, kind):
    seen = {"cycle": 0, "ok": 0}
    for seed in range(300):
        rng = random.Random(f"fiset-{kind}-{seed}")
        n = rng.choice([2, 3, 4, 9, 20, 45])          # V == 1: see test_single_vertex_self_loop
        edges = random_graph(rng, n, kind)
        source = rng.randrange(n)
        theirs = _fiset(edges, n, source)
        got = run(impl, n, edges, source)
        if NINF in theirs:
            assert got[0] == "cycle", (kind, seed)
            assert_negative_cycle(edges, got[1])
            assert all(theirs[v] == NINF for v in got[1]), (kind, seed, got[1])
        else:
            assert got[0] == "ok", (kind, seed)
            assert got[1].tolist() == theirs, (kind, seed)          # bit-identical
        seen[got[0]] += 1
    assert seen["cycle"] > 30 and seen["ok"] > 30, seen
