"""TDD for Phase 5 — Exchange-graph centrality (the market's connective tissue).

Two stdlib measures over the SAME liquidity-weighted exchange graph the app already
builds (`arbitrage.Graph`):
  * `centrality.pagerank(g, rv)`        — HUB score (value flowing into/through a node).
  * `centrality.betweenness_lite(g, rv)`— BRIDGE score (how often routes between other
                                          currencies pass through a node), reusing
                                          `Graph.iter_paths` — the route-search DFS.
  * `centrality.hubs(g, rv, n)`         — the top-N hub ids the Board chip lights up.
  * `centrality.scores()`               — cached {"hub":…, "bridge":…} for Phase 4.

And the Convert consumer: `_best_conversions(..., bridge=…)` uses the bridge score as a
FINAL tie-break, so a genuine tie (same fill, net value, hops) prefers the route through
more central bridge currencies.

Built on SYNTHETIC graphs (no DB), mirroring test_convert.py.

    python -m pytest backend/tests/test_centrality.py -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import arbitrage, centrality  # noqa: E402
from app.arbitrage import Edge, Graph  # noqa: E402


def _edge(a, b, rate, vol=100.0, stock=1_000_000):
    return Edge(a, b, "live", rate, [{"rate": rate, "stock": stock}], age_s=0.0, vol_in_per_h=vol)


def _star():
    """A hub `c` wired bidirectionally to three otherwise-unconnected leaves."""
    g = Graph({"reference": "c", "league": "T", "max_steps": 4})
    g.fee_table = {}
    for leaf in ("l1", "l2", "l3"):
        g.add(_edge("c", leaf, 1.0))
        g.add(_edge(leaf, "c", 1.0))
    return g


# ---------------------------------------------------------------- PageRank (hub)
def test_pagerank_hub_outranks_leaves():
    g = _star()
    rv = g.ref_values()
    pr = centrality.pagerank(g, rv)
    assert pr["c"] == max(pr.values())
    assert pr["c"] > pr["l1"]
    assert all(v > 0 for v in pr.values())


def test_pagerank_weight_pulls_rank_to_higher_volume():
    """Edge weight = executed value/hour; a fatter-volume edge concentrates more rank."""
    g = Graph({"reference": "s", "league": "T", "max_steps": 4})
    g.fee_table = {}
    g.add(_edge("s", "t1", 1.0, vol=1000.0)); g.add(_edge("t1", "s", 1.0, vol=1000.0))
    g.add(_edge("s", "t2", 1.0, vol=10.0));   g.add(_edge("t2", "s", 1.0, vol=10.0))
    rv = g.ref_values()
    pr = centrality.pagerank(g, rv)
    assert pr["t1"] > pr["t2"]


def test_pagerank_dangling_node_is_safe():
    """A node with no out-edges must not crash or leak rank mass."""
    g = Graph({"reference": "a", "league": "T", "max_steps": 4})
    g.fee_table = {}
    g.add(_edge("a", "b", 1.0))   # b is dangling (no out-edge)
    rv = g.ref_values()
    pr = centrality.pagerank(g, rv)
    assert set(pr) == {"a", "b"}
    assert all(v > 0 for v in pr.values())
    assert abs(sum(pr.values()) - 1.0) < 1e-6


# ---------------------------------------------------------- betweenness (bridge)
def test_betweenness_flags_the_bridge():
    """a <-> m <-> b, no direct a-b: every a↔b route passes through m, so m is the bridge."""
    g = Graph({"reference": "m", "league": "T", "max_steps": 4})
    g.fee_table = {}
    g.add(_edge("a", "m", 1.0)); g.add(_edge("m", "a", 1.0))
    g.add(_edge("m", "b", 1.0)); g.add(_edge("b", "m", 1.0))
    rv = g.ref_values()
    bl = centrality.betweenness_lite(g, rv)
    assert bl.get("m", 0.0) > bl.get("a", 0.0)
    assert bl.get("m", 0.0) > bl.get("b", 0.0)


# ---------------------------------------------------------------- hubs() + scores()
def test_hubs_returns_top_n_by_pagerank():
    g = _star()
    rv = g.ref_values()
    assert centrality.hubs(g, rv, n=1) == {"c"}
    # n is the user-tunable threshold (settings hub_count): more n → more hubs, center always in.
    top2 = centrality.hubs(g, rv, n=2)
    assert len(top2) == 2 and "c" in top2
    assert len(centrality.hubs(g, rv, n=99)) == 4  # capped at the number of nodes


def test_seed_missing_adds_only_new_hubs_excluding_reference():
    """The Board's one-time hub seed: add hub currencies not already watched, never the
    reference (it's never a board row), stable-ordered, no duplicates."""
    # divine already watched; mirror is a new hub; exalted is the reference → excluded.
    got = centrality.seed_missing(["chaos", "divine"], {"divine", "mirror", "exalted"}, "exalted")
    assert got == ["mirror"]
    # nothing new to add → empty
    assert centrality.seed_missing(["chaos", "divine", "mirror"], {"divine", "mirror"}, "exalted") == []
    # no hubs known yet (cold graph) → empty, so the seed waits rather than seeding nothing
    assert centrality.seed_missing(["chaos"], set(), "exalted") == []


# ---------------------------------------------------------- empty graph is safe
def test_empty_graph_is_safe():
    g = Graph({"reference": "x", "league": "T", "max_steps": 4})
    g.fee_table = {}
    rv = g.ref_values()
    assert centrality.pagerank(g, rv) == {}
    assert centrality.betweenness_lite(g, rv) == {}
    assert centrality.hubs(g, rv) == set()


# --------------------------------------------- Convert consumer: bridge tie-break
def _tie_graph():
    """Two 2-hop routes chaos->divine with IDENTICAL output (10 divine) and zero gold, so
    (full_fill, net_ref, hops) tie exactly — only the bridge score can break it.
      chaos --x2--> alpha --x0.05--> divine   (= 0.10 div/chaos)
      chaos --x5--> beta  --x0.02--> divine   (= 0.10 div/chaos)
    """
    s = {"gold_model": {}, "reference": "divine", "league": "T",
         "step_overhead_min": 0, "max_steps": 4}
    g = Graph(s)
    g.fee_table = {}
    g.add(_edge("chaos", "alpha", 2.0));  g.add(_edge("alpha", "divine", 0.05))
    g.add(_edge("chaos", "beta", 5.0));   g.add(_edge("beta", "divine", 0.02))
    return g


def test_convert_tiebreak_prefers_central_bridge():
    g = _tie_graph()
    rv = g.ref_values()
    # sanity: absent a bridge signal the two routes are a genuine tie at 10 divine out.
    neutral = arbitrage._best_conversions(g, rv, "chaos", "divine", 100, max_steps=4)
    assert neutral["best"]["out"] == 10

    via_alpha = arbitrage._best_conversions(g, rv, "chaos", "divine", 100, max_steps=4,
                                            bridge={"alpha": 0.9, "beta": 0.1})
    assert via_alpha["best"]["path"] == ["chaos", "alpha", "divine"]

    via_beta = arbitrage._best_conversions(g, rv, "chaos", "divine", 100, max_steps=4,
                                           bridge={"alpha": 0.1, "beta": 0.9})
    assert via_beta["best"]["path"] == ["chaos", "beta", "divine"]


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
