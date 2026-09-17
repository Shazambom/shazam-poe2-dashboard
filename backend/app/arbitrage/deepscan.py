"""Deep scan — profitable loops the DFS route search cannot see.

`Graph.iter_cycles` enumerates simple cycles of at most `max_steps` hops from a held currency
and stops at MAX_CANDIDATES. `negcycle` (Bellman-Ford on -log(rate)) has no hop cap and looks
at the whole market at once, but returns ONE loop per run, from top-of-book rates only. So:
find a loop, drop its most over-paying edge (the likeliest mispricing — without it that loop,
and every loop leaning on the same quote, is gone), search again; at most `max_loops` times.

What comes back is a list of CANDIDATES as real `Edge` chains. `routes._iter_candidates` sizes
and simulates each through the same `_route_from` a DFS loop goes through (ladder depth,
whole-unit rounding, gold), so most of them will fail the user's filters — that is the point
of simulating. Nothing here knows about capital, filters or ranking.

numpy is optional at runtime: without it the scan returns nothing and the route search is
exactly what it was.
"""
from __future__ import annotations

import math
import threading
import time

from .. import devtelemetry
from .graph import Edge, Graph

MAX_LOOPS = 12        # Bellman-Ford runs per search (each ~ms-15ms on the live graph)
MIN_GAIN = 1e-6       # log units ≈ fractional gain; below this a "loop" is float dust


REPORT_EVERY_S = 1800
_last_report = 0.0


def _report(msg: str) -> None:
    """Beta/dev-only diagnostic (devtelemetry's gate): is numpy alive in the FROZEN backend —
    Windows is the platform a Mac can't check — and what does the scan find and cost on a real
    market. Counts and milliseconds only. Off the request thread (the sender blocks up to 4 s),
    at most once per REPORT_EVERY_S."""
    global _last_report
    now = time.time()
    if not devtelemetry.enabled() or now - _last_report < REPORT_EVERY_S:
        return
    _last_report = now
    threading.Thread(target=devtelemetry.tlog, args=("deepscan", msg), daemon=True).start()


def _load():
    """(negcycle, numpy) or None — the scan degrades to nothing rather than break routes."""
    try:
        import numpy as np
        from .. import negcycle
    except ImportError:
        return None
    return negcycle, np


def deep_loops(g: Graph, ref_value: dict[str, float], max_loops: int = MAX_LOOPS) -> list[list[Edge]]:
    """Up to `max_loops` distinct profitable loops (by top-of-book rate), each a closed chain of
    the graph's own Edges: loop[i].dst == loop[i+1].src, and the last hops back to the first."""
    loaded = _load()
    edges = [e for e in g.edges.values() if e.rate > 0]
    if loaded is None:
        _report("numpy=missing (scan skipped)")
        return []
    if not edges:
        return []
    t0 = time.perf_counter()
    negcycle, np = loaded
    ids: dict[str, int] = {}
    src = np.array([ids.setdefault(e.src, len(ids)) for e in edges])
    dst = np.array([ids.setdefault(e.dst, len(ids)) for e in edges])
    w = np.array([-math.log(e.rate) for e in edges])
    names = list(ids)
    alive = np.ones(len(edges), dtype=bool)
    index = {(e.src, e.dst): i for i, e in enumerate(edges)}

    def overpay(e: Edge) -> float:
        """How far above reference value this quote pays (1.0 = fair); unknown values → fair."""
        a, b = ref_value.get(e.src), ref_value.get(e.dst)
        return e.rate * b / a if a and b else 1.0

    loops: list[list[Edge]] = []
    while len(loops) < max_loops:
        cyc = negcycle.find_negative_cycle(len(ids), src[alive], dst[alive], w[alive], None, MIN_GAIN)
        if cyc is None:
            break
        loop = [g.edges[(names[a], names[b])] for a, b in zip(cyc, cyc[1:] + cyc[:1])]
        loops.append(loop)
        worst = max(loop, key=overpay)
        alive[index[(worst.src, worst.dst)]] = False
    _report(f"numpy=ok nodes={len(ids)} edges={len(edges)} loops={len(loops)} "
            f"hops={[len(l) for l in loops]} ms={(time.perf_counter() - t0) * 1000:.0f}")
    return loops
