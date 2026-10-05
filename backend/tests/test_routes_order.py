"""The loop search fills its candidate cap shortest-first and fairly across held currencies (learnability QA pass 2,
2026-10-05): depth-first from the first held currency let Chaos's 4–5-step loops fill all 20,000 slots, so raising
Maximum steps per loop shrank the list (Quick flips: 34 loops at 3 steps, 2 at 5) and Divine/Exalted got none."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app.arbitrage import Edge, Graph, routes  # noqa: E402

NODES = ["chaos", "divine", "exalted", "a", "b", "c", "d", "e"]


def _complete():
    g = Graph({"gold_model": {}, "reference": "exalted", "league": "T", "step_overhead_min": 0, "max_steps": 5})
    for x in NODES:
        for y in NODES:
            if x != y:
                g.add(Edge(x, y, "live", 1.0, [{"rate": 1.0, "stock": 1e9}], age_s=0.0))
    return g


def _ids(cycles):
    return ["|".join(f"{e.src}>{e.dst}" for e in c) for c in cycles]


def test_every_shorter_loop_comes_before_any_longer_one():
    cyc = list(routes.cycles_shortest_first(_complete(), ["chaos", "divine"], 5, cap=10_000))
    lengths = [len(c) for c in cyc]
    assert lengths == sorted(lengths), "shortest first"
    assert set(lengths) == {2, 3, 4, 5}


def test_raising_the_step_count_only_adds_longer_loops_under_the_cap():
    g = _complete()
    at3 = set(_ids(routes.cycles_shortest_first(g, ["chaos", "divine", "exalted"], 3, cap=600)))
    at5 = set(_ids(routes.cycles_shortest_first(g, ["chaos", "divine", "exalted"], 5, cap=600)))
    assert at3 and at3 <= at5, "nothing found at 3 steps is lost at 5"


def test_held_currencies_share_the_cap_at_the_longest_length():
    cyc = list(routes.cycles_shortest_first(_complete(), ["chaos", "divine", "exalted"], 5, cap=3000))
    assert len(cyc) == 3000
    longest = [c for c in cyc if len(c) == max(len(x) for x in cyc)]
    per_start = {s: sum(1 for c in longest if c[0].src == s) for s in ("chaos", "divine", "exalted")}
    assert min(per_start.values()) > 0 and max(per_start.values()) - min(per_start.values()) <= 1, per_start


def test_the_same_cycles_as_before_when_nothing_is_capped():
    g = _complete()
    old = {i for s in ["chaos", "divine"] for i in _ids(g.iter_cycles(s, 4))}
    new = set(_ids(routes.cycles_shortest_first(g, ["chaos", "divine"], 4, cap=10**9)))
    assert new == old


def test_under_the_cap_the_search_order_is_exactly_the_original():
    """The default (3 steps, every preset) never reaches the cap; there the order must stay the original per-start
    depth-first order, because the composite score ranks ties by it (owner: arbitrage internals are sensitive)."""
    g = _complete()
    starts = ["chaos", "divine", "exalted"]
    original = [c for s in starts for c in g.iter_cycles(s, 3)]
    got = list(routes.search_cycles(g, starts, 3, cap=10**6))
    assert _ids(got) == _ids(original)


def test_at_the_cap_the_search_switches_to_shortest_first():
    g = _complete()
    starts = ["chaos", "divine", "exalted"]
    got = list(routes.search_cycles(g, starts, 5, cap=500))
    assert len(got) == 500
    assert _ids(got) == _ids(routes.cycles_shortest_first(g, starts, 5, cap=500))
