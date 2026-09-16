"""Exchange-graph arbitrage: the graph + fill model, route search, conversion, and the board.

A package with one facade: import `arbitrage` and use the names below (main.py, liquidity,
centrality and the tests do). Submodules: graph (Edge/Graph/simulate + the graph cache),
routes (search, ranking, the route cache), convert (open-path conversion), board (price board).
"""
from __future__ import annotations

from . import board as _board_mod, graph as _graph_mod, routes as _routes_mod
from .board import BOARD_TTL_S, board, board_pairs, edge_table
from .convert import GOLD_VALUE_DIVINE_PER_1K, _best_conversions, _convert_path, convert
from .graph import (GRAPH_TTL_S, INF, Edge, Graph, anchor_prices, cached_graph, cycle_unit, gold_fee,
                    route_cap, simulate)
from .routes import (MAX_CANDIDATES, RECOMMENDED_MIN_LIQUIDITY_REF, RECOMMENDED_MIN_VOLUME_REF_PER_H,
                     ROUTE_CACHE_MAX, _composite_score, _find_routes, _keep, _route_cache,
                     _sort_key, _velocity, find_routes, route_pairs, stream_routes)
from . import graph  # noqa: F401  — tests monkeypatch arbitrage.graph.cached_graph


def invalidate_caches() -> None:
    """Drop the graph + route + board caches (call after settings changes, e.g. league switch,
    reference, watchlist, or hub_count — so a settings edit reflects immediately)."""
    from .. import cache
    cache.clear(_graph_mod._graph_cache)
    cache.clear(_routes_mod._route_cache)
    cache.clear(_board_mod._board_cache)
