"""TDD — the Bellman-Ford "deep scan" feeding the Arbitrage route search.

`Graph.iter_cycles` (DFS) only sees loops of at most `max_steps` hops and stops at
MAX_CANDIDATES. `arbitrage.deepscan.deep_loops` runs `negcycle` over the whole graph's
top-of-book rates — no hop cap — and `routes._iter_candidates` sizes/simulates each loop it
finds through the SAME `_route_from` every DFS loop goes through, tagged `deep: True`. So a
deep loop is never a separate kind of result: same row, same filters, same ranking.

Built on SYNTHETIC graphs (no DB), mirroring test_centrality.py / test_convert.py.

    python -m pytest backend/tests/test_deepscan.py -q
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app.arbitrage import Edge, Graph, deepscan, routes  # noqa: E402

pytest.importorskip("numpy")

SETTINGS = {"reference": "a", "league": "T", "max_steps": 3, "max_start_fraction": 1.0,
            "step_overhead_min": 0.0, "gold_model": {}}


def _edge(a, b, rate, stock=1_000_000):
    return Edge(a, b, "live", rate, [{"rate": rate, "stock": stock}], age_s=0.0, vol_in_per_h=100.0)


def _graph(edges, **over):
    g = Graph({**SETTINGS, **over})
    g.fee_table = {}
    for a, b, rate in edges:
        g.add(_edge(a, b, rate))
    return g


def _ring(nodes, gain):
    """A loop over `nodes` at 1:1 whose LAST hop pays `gain` (1.05 = +5% per lap)."""
    hops = list(zip(nodes, nodes[1:] + nodes[:1]))
    return [(a, b, gain if i == len(hops) - 1 else 1.0) for i, (a, b) in enumerate(hops)]


def _candidates(g, capital, notional=False):
    stats = {}
    starts = list(g.adj) if notional else [c for c, q in capital.items() if q > 0]
    rv = {n: 1.0 for n in g.adj}
    out = list(routes._iter_candidates(g, g.s, rv, capital, starts, notional, stats))
    return out, stats


# ---------------------------------------------------------------- deep_loops
def test_finds_a_loop_longer_than_max_steps():
    g = _graph(_ring(list("abcde"), 1.05))
    loops = deepscan.deep_loops(g, {n: 1.0 for n in "abcde"})
    assert len(loops) == 1
    assert sorted(e.src for e in loops[0]) == list("abcde")
    for e, nxt in zip(loops[0], loops[0][1:] + loops[0][:1]):
        assert e.dst == nxt.src                       # a closed chain of real Edge objects


def test_no_loop_in_a_fair_market():
    assert deepscan.deep_loops(_graph(_ring(list("abcde"), 0.97)), {}) == []
    assert deepscan.deep_loops(_graph([]), {}) == []


def test_returns_several_distinct_loops():
    g = _graph(_ring(list("abcde"), 1.05) + _ring(list("vwxyz"), 1.08))
    loops = deepscan.deep_loops(g, {})
    assert sorted("".join(sorted(e.src for e in l)) for l in loops) == ["abcde", "vwxyz"]


def test_drops_the_mispriced_edge_so_the_next_loop_is_new():
    """Two loops share the hop d->e->a; the mispriced hop is the OTHER one in each. After a
    loop is taken, its most over-paying edge (vs reference value) is removed — so the scan
    terminates and doesn't hand back the same loop."""
    g = _graph(_ring(list("abcde"), 1.05))
    loops = deepscan.deep_loops(g, {n: 1.0 for n in "abcde"})
    assert len(loops) == 1                            # removing e->a (the 1.05 hop) kills it


def test_max_loops_caps_the_scan():
    rings = []
    for i in range(6):
        rings += _ring([f"{c}{i}" for c in "abcd"], 1.05)
    assert len(deepscan.deep_loops(_graph(rings), {}, max_loops=4)) == 4


def test_degrades_to_nothing_without_numpy(monkeypatch):
    monkeypatch.setattr(deepscan, "_load", lambda: None)
    assert deepscan.deep_loops(_graph(_ring(list("abcde"), 1.05)), {}) == []


# ---------------------------------------------------------------- inside the route search
def test_deep_loop_becomes_an_ordinary_route_from_the_held_currency():
    g = _graph(_ring(list("abcde"), 1.05))
    got, stats = _candidates(g, {"c": 1000.0})
    assert len(got) == 1                              # DFS (max 3 hops) found nothing; deep did
    r = got[0]
    assert r["deep"] is True
    assert r["start"] == "c" and r["path"] == list("cdeabc")
    assert r["margin"] > 0 and r["margin_pct"] == pytest.approx(5.0, abs=0.2)
    assert stats == {"loops": 1, "added": 1, "no_holding": 0}


def test_loop_the_dfs_already_found_is_not_duplicated_or_tagged():
    g = _graph(_ring(list("abc"), 1.05))
    got, stats = _candidates(g, {"a": 1000.0})
    assert [r["id"] for r in got] == ["a>b|b>c|c>a"]
    assert "deep" not in got[0]
    assert stats == {"loops": 1, "added": 0, "no_holding": 0}


def test_loop_through_nothing_you_hold_is_counted_not_listed():
    g = _graph(_ring(list("abcde"), 1.05) + [("q", "a", 1.0)])
    got, stats = _candidates(g, {"q": 1000.0})
    assert got == []
    assert stats == {"loops": 1, "added": 0, "no_holding": 1}


def test_notional_search_lists_the_deep_loop_from_every_vertex_once():
    g = _graph(_ring(list("abcde"), 1.05))
    got, stats = _candidates(g, {}, notional=True)
    assert sorted(r["start"] for r in got) == list("abcde")
    assert all(r["deep"] for r in got) and len({r["id"] for r in got}) == 5
    assert stats["added"] == 5


def test_telemetry_is_gated_throttled_and_carries_no_currency_names(monkeypatch):
    sent = []
    monkeypatch.setattr(deepscan.devtelemetry, "tlog", lambda tag, msg: sent.append((tag, msg)))
    monkeypatch.setattr(deepscan.threading, "Thread",
                        lambda target, args, daemon: type("T", (), {"start": lambda self: target(*args)})())
    g = _graph(_ring(["exalted", "divine", "chaos", "regal", "vaal"], 1.05))

    monkeypatch.setattr(deepscan.devtelemetry, "enabled", lambda: False)
    monkeypatch.setattr(deepscan, "_last_report", 0.0)
    deepscan.deep_loops(g, {})
    assert sent == []                                              # stable build: nothing leaves

    monkeypatch.setattr(deepscan.devtelemetry, "enabled", lambda: True)
    deepscan.deep_loops(g, {})
    deepscan.deep_loops(g, {})                                     # inside the throttle window
    assert len(sent) == 1 and sent[0][0] == "deepscan"
    assert "numpy=ok" in sent[0][1] and "loops=1" in sent[0][1] and "hops=[5]" in sent[0][1]
    assert not any(name in sent[0][1] for name in ("exalted", "divine", "chaos", "regal", "vaal"))
