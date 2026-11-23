"""Exchange-graph arbitrage: the graph + fill model, route search, conversion, and the board.

A package with one facade: import `arbitrage` and use the names below (main.py, liquidity,
centrality and the tests do). Submodules: graph (Edge/Graph/simulate + the graph cache),
routes (search, ranking, the route cache), convert (open-path conversion), board (price board).
"""

from __future__ import annotations

from . import board as _board_mod, graph as _graph_mod, routes as _routes_mod
from .board import (
    BOARD_TTL_S as BOARD_TTL_S,
    asset as asset,
    board as board,
    cards as cards,
    board_pairs as board_pairs,
    default_numeraire as default_numeraire,
    edge_table as edge_table,
    native_price as native_price,
)
from .convert import (
    GOLD_VALUE_DIVINE_PER_1K as GOLD_VALUE_DIVINE_PER_1K,
    _best_conversions as _best_conversions,
    _convert_path as _convert_path,
    convert as convert,
)
from .graph import (
    GRAPH_TTL_S as GRAPH_TTL_S,
    INF as INF,
    Edge as Edge,
    Graph as Graph,
    anchor_prices as anchor_prices,
    cached_graph as cached_graph,
    counterparts_by_volume as counterparts_by_volume,
    cycle_unit as cycle_unit,
    gold_fee as gold_fee,
    route_cap as route_cap,
    simulate as simulate,
)
from .routes import (
    ARBITRAGE_HUBS as ARBITRAGE_HUBS,
    CASH as CASH,
    MAX_CANDIDATES as MAX_CANDIDATES,
    RECOMMENDED_MIN_LIQUIDITY_REF as RECOMMENDED_MIN_LIQUIDITY_REF,
    RECOMMENDED_MIN_VOLUME_REF_PER_H as RECOMMENDED_MIN_VOLUME_REF_PER_H,
    ROUTE_CACHE_MAX as ROUTE_CACHE_MAX,
    _composite_score as _composite_score,
    _find_routes as _find_routes,
    _keep as _keep,
    _route_cache as _route_cache,
    _sort_key as _sort_key,
    _velocity as _velocity,
    arbitrage_currencies as arbitrage_currencies,
    find_routes as find_routes,
    loop_currencies as loop_currencies,
    route_pairs as route_pairs,
    stream_routes as stream_routes,
)
from . import graph as graph  # tests monkeypatch arbitrage.graph.cached_graph


def invalidate_caches() -> None:
    """Drop the graph + route + board caches (call after settings changes, e.g. league switch,
    reference, watchlist, or hub_count — so a settings edit reflects immediately)."""
    from .. import cache

    cache.clear(_graph_mod._graph_cache)
    cache.clear(_routes_mod._route_cache)
    cache.clear(_board_mod._board_cache)
