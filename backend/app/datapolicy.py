"""Data policy — the ONE place that says which data is the user's and how long market data lives.

Dependency-free on purpose (no app imports, no DB boot) so every consumer can share it:
`db.py` (kv routing), `migrations_user.py` (the legacy lift), and the seed exporter in
`ops/export-market-snapshot.py` (which runs inside the backend container with cwd=/app).
See docs/db-architecture.md "Data classification" and docs/db-maintenance.md.
"""
from __future__ import annotations

# kv keys owned by the USER (persist forever + migrate, land in user.sqlite.kv). Everything else
# is operational and lands in market.sqlite.kv_ops (ships in the snapshot, disposable).
# `secret:`-prefixed keys (encrypted session/oauth) are always user.
USER_KV = frozenset({
    "settings",           # league, reference, watchlist, filters, gold model, …
    "watches",            # legacy saved searches (kept as a backup; see migration #2)
    "oauth_pending",      # OAuth PKCE state
    "meta_overrides",     # user currency metadata→trade-id overrides
    "trading_workspace",  # the Trading workspace tree (folders/searches)
    "signals_ack",        # which fired signals the user has dismissed
})


def is_user_kv(key: str) -> bool:
    return key in USER_KV or key.startswith("secret:")


# Market retention. Rows older than this are pruned on the client (and windowed out of the seed).
# The longest reader window is inflation's 336h (14d) of hourly digest; one day of margin keeps
# the "traded today" edge of that window intact across a prune.
MARKET_RETENTION_DAYS = 15
# orderbook_history is read over a 48h window (orderbook.pair_history); keep a day of margin.
ORDERBOOK_HISTORY_RETENTION_H = 72

# Tables that ship in the market seed. orderbook/orderbook_history are session-bound and
# re-accrue live within minutes, and analytics_* are runtime-only (the sidecar recomputes), so
# none of those ship. market_meta is written by the exporter itself.
SEED_TABLES = ("digest_markets", "league_daily", "item_meta", "kv_ops", "mod_pools", "mod_currencies")
