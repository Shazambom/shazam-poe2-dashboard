"""Exchange-graph arbitrage: the graph + fill model, route search, conversion, and the board.

A package with one facade: import `arbitrage` and use the names below (main.py, liquidity,
centrality and the tests do). Submodules: graph (Edge/Graph/simulate + the graph cache),
routes (search, ranking, the route cache), convert (open-path conversion), board (price board).
"""

from __future__ import annotations

from . import board as _board_mod
from . import graph as _graph_mod
from . import graph as graph  # tests monkeypatch arbitrage.graph.cached_graph
from . import routes as _routes_mod
from .board import BOARD_TTL_S as BOARD_TTL_S
from .board import asset as asset
from .board import board as board
from .board import board_pairs as board_pairs
from .board import cards as cards
from .board import default_numeraire as default_numeraire
from .board import edge_table as edge_table
from .board import native_price as native_price
from .convert import GOLD_VALUE_DIVINE_PER_1K as GOLD_VALUE_DIVINE_PER_1K
from .convert import _best_conversions as _best_conversions
from .convert import _convert_path as _convert_path
from .convert import convert as convert
from .graph import GRAPH_TTL_S as GRAPH_TTL_S
from .graph import INF as INF
from .graph import Edge as Edge
from .graph import Graph as Graph
from .graph import anchor_prices as anchor_prices
from .graph import cached_graph as cached_graph
from .graph import counterparts_by_volume as counterparts_by_volume
from .graph import cycle_unit as cycle_unit
from .graph import gold_fee as gold_fee
from .graph import route_cap as route_cap
from .graph import simulate as simulate
from .routes import ARBITRAGE_HUBS as ARBITRAGE_HUBS
from .routes import CASH as CASH
from .routes import MAX_CANDIDATES as MAX_CANDIDATES
from .routes import RECOMMENDED_MIN_LIQUIDITY_REF as RECOMMENDED_MIN_LIQUIDITY_REF
from .routes import RECOMMENDED_MIN_VOLUME_REF_PER_H as RECOMMENDED_MIN_VOLUME_REF_PER_H
from .routes import ROUTE_CACHE_MAX as ROUTE_CACHE_MAX
from .routes import _composite_score as _composite_score
from .routes import _find_routes as _find_routes
from .routes import _keep as _keep
from .routes import _route_cache as _route_cache
from .routes import _sort_key as _sort_key
from .routes import _velocity as _velocity
from .routes import arbitrage_currencies as arbitrage_currencies
from .routes import find_routes as find_routes
from .routes import loop_currencies as loop_currencies
from .routes import route_pairs as route_pairs
from .routes import stream_routes as stream_routes


def invalidate_caches() -> None:
    """Drop the graph + route + board caches (call after settings changes, e.g. league switch,
    reference, watchlist, or hub_count — so a settings edit reflects immediately)."""
    from .. import cache, digest

    cache.clear(_graph_mod._graph_cache)
    cache.clear(_routes_mod._route_cache)
    cache.clear(_board_mod._board_cache)
    cache.clear(digest._activity_cache)
