"""THIRD OPINION — `app.negcycle` against the real networkx (a test-only reference library).

`test_negcycle.py` already holds the numpy Bellman-Ford to the line-for-line Wikipedia version
and to a brute-force enumerator. This adds an implementation none of us wrote: networkx's
queue-based Bellman-Ford. Only the parts of networkx that are sound are used as an oracle —
  * `single_source_bellman_ford_path_length`  → distances,
  * `NetworkXUnbounded` / `negative_edge_cycle` → the yes/no verdict,
NOT `nx.find_negative_cycle`: fuzzing it (networkx 3.6.1) showed it raising "Negative cycle is
detected but not found" on ~0.25% of sources (the vertex it flags can hang downstream of the
cycle, and it only searches for a cycle THROUGH that vertex) and returning cycles that do not
sum below zero (a zero-weight self-loop) on ~0.1%. `test_networkx_recovery_gap_is_covered`
pins that ours answers exactly there. That is why this module is not a networkx port.

networkx is never bundled; it lives in the sidecar venv with the other reference libraries:

    desktop/.venv-sidecar/bin/python -m pytest backend/tests/test_negcycle_networkx.py -q
"""
import random
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
sys.path.insert(0, str(Path(__file__).resolve().parent))      # tests/ (shared fuzz helpers)
from app import negcycle as nc  # noqa: E402
from test_negcycle import IMPLS, INF, assert_negative_cycle, best_weight, random_graph, run  # noqa: E402

# Missing → not the sidecar venv: skip loudly rather than silently pass (a green run must mean
# the comparison actually happened).
nx = pytest.importorskip("networkx", reason="run in desktop/.venv-sidecar (needs real networkx)")


def _nx_graph(n, edges):
    G = nx.DiGraph()
    G.add_nodes_from(range(n))
    G.add_weighted_edges_from((u, v, w) for (u, v), w in best_weight(edges).items())
    return G


@pytest.mark.parametrize("impl", IMPLS)
@pytest.mark.parametrize("kind", ["float", "int", "rates"])
def test_fuzz_distances_and_verdict_match_networkx(impl, kind):
    seen = {"cycle": 0, "ok": 0}
    for seed in range(250):
        rng = random.Random(f"nx-{kind}-{seed}")
        n = rng.choice([1, 3, 8, 20, 45])
        edges = random_graph(rng, n, kind)
        G = _nx_graph(n, edges)
        source = rng.randrange(n)
        got = run(impl, n, edges, source)
        try:
            want = nx.single_source_bellman_ford_path_length(G, source)
        except nx.NetworkXUnbounded:
            want = None
        assert (got[0] == "cycle") == (want is None), (kind, seed)
        if want is None:
            assert_negative_cycle(edges, got[1])
        else:
            assert got[1].tolist() == [want.get(v, INF) for v in range(n)], (kind, seed)

        # source=None == "a negative cycle anywhere" == networkx's whole-graph verdict
        anywhere = run(impl, n, edges, None)
        assert (anywhere[0] == "cycle") == nx.negative_edge_cycle(G), (kind, seed)
        seen[got[0]] += 1
    assert seen["cycle"] > 30 and seen["ok"] > 30, seen


def test_networkx_recovery_gap_is_covered():
    """Wherever nx.find_negative_cycle gives up or returns a non-negative 'cycle', a negative
    cycle IS reachable (its own detector said so) and ours must hand back a real one."""
    gaps = 0
    for seed in range(300):
        rng = random.Random(f"gap-{seed}")
        n = rng.choice([5, 13, 25, 40])
        edges = random_graph(rng, n, "int")
        G, W = _nx_graph(n, edges), best_weight(edges)
        for source in range(n):
            try:
                theirs = nx.find_negative_cycle(G, source)          # closed list: first == last
                if sum(W[(a, b)] for a, b in zip(theirs, theirs[1:])) < 0:
                    continue                                        # networkx got it right
            except nx.NetworkXError as e:
                if "No negative cycles" in str(e):
                    assert nc.find_negative_cycle(n, *_arr(edges), source) is None
                    continue
            gaps += 1
            ours = nc.find_negative_cycle(n, *_arr(edges), source)
            assert ours is not None, (seed, source)
            assert_negative_cycle(edges, ours)
    assert gaps > 0, "fuzz no longer reaches networkx's gap — widen it or drop this test"


def _arr(edges):
    u, v, w = zip(*edges) if edges else ((), (), ())
    return list(u), list(v), list(w)
