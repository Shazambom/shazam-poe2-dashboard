from __future__ import annotations

import copy

from . import db
from .config import LEAGUE

DEFAULTS: dict = {
    "league": LEAGUE,
    # Reference currency every value is quoted in.
    "reference": "exalted",
    # Currencies whose every ordered pair is fetched live. Keep this small: the
    # exchange API is rate limited and the sweep is n*(n-1) requests.
    "watchlist": ["chaos", "exalted", "divine", "regal", "vaal", "annul"],
    "extra_pairs": [],
    # How many of the most-central currencies (by volume-weighted PageRank) are flagged as
    # "hubs" — the ⬢ chip on the board + the pulse-strip Hubs group. User-tunable in Settings.
    "hub_count": 5,
    # Gold fee model. Per-unit fees come from the game's CurrencyExchange table
    # (GoldPurchaseFee), fetched automatically. `per_unit` is only for manual
    # overrides; `per_ref_unit` is the fallback for items missing from the table.
    # `fee_side`: "buy" charges per unit received, "sell" per unit given.
    "gold_model": {
        "base_per_order": 0,
        "per_unit": {},
        "per_ref_unit": 10,
        "fee_side": "buy",
    },
    # Route search
    "max_steps": 3,
    "max_start_fraction": 1.0,      # fraction of held capital to commit per route
    "live_max_age_s": 1800,         # order book older than this is ignored
    # Live refresh policy (all fetches go through the rate-limited queue)
    "live_top_n": 5,                # after display, refresh pairs behind the top N loops only
    "live_min_age_s": 300,          # ...and only pairs older than this
    "min_refetch_s": 300,           # never refetch the same pair sooner (unless forced)
    "routes_cache_s": 300,          # serve identical route queries from memory this long
    "background_sweep": False,      # opt-in low-priority sweep of the whole watchlist
    # Batch padding: a request for want=W carries the requested haves first, then fills
    # the remaining slots with the haves that trade into W most (by digest volume),
    # skipping anything cached within min_refetch_s. Free data on a request we're
    # making anyway; requested pairs still get starvation follow-ups, padded ones don't.
    "batch_pad": True,
    "batch_max_have": 12,
    "digest_max_age_h": 6,          # digest rate older than this is ignored
    "allow_digest_edges": True,     # fill missing live pairs with digest VWAP
    "allow_recipe_edges": True,
    # Edge culling: markets thinner than this never enter the graph, so junk
    # loops aren't even searched. Volume is the edge's executed value per hour
    # in the reference currency; depth is listings on a live ladder.
    "min_edge_volume_ref_per_h": 1.0,
    "min_edge_depth": 2,
    # Composite ranking weights (rank-normalised, so scales don't matter). Gold
    # efficiency leads, value second, volume (fill speed) a real but smaller vote.
    # Lead term: velocity = margin_ref / (fill_hours × gold) — profit per hour per gold.
    "rank_weights": {"velocity": 0.5, "margin_per_1k_gold": 0.2, "margin_ref": 0.2, "volume": 0.1},
    "volume_window_h": 24,
    "step_overhead_min": 2.0,       # minutes per exchange step to place and collect an order
    # Price of gold for ranking, in Divine per 1000 gold. Gold's real worth shifts across a
    # league, so a slider (Arbitrage page, range 100k–10M gold/Divine) tunes this; it feeds
    # Convert's net-value ranking and Arbitrage velocity. Default 0.01 == 1 Divine ≈ 100k gold.
    "gold_value_per_1k": 0.01,
    # Notifications, per family (live trade pings, market signals) and per channel. In-app banner
    # and sound on by default; OS notifications opt-in. `volume` is the shared ping volume.
    "notifications": {
        "volume": 0.15,
        "live": {"banner": True, "sound": True, "os": False, "tone": "soft1"},
        "signals": {"banner": True, "sound": True, "os": False, "tone": "alert"},
    },
    # Default filters (UI can override per request)
    "filters": {
        "min_margin_pct": 3.0,            # skip sub-3% flips — noise once you count effort/fees
        "min_margin_ref": 0.0,
        "max_gold": 0,
        "min_margin_per_1k_gold": 0.0,
        "min_liquidity_ref": 50.0,        # per-step min executable capacity (ref value)
        "min_volume_ref_per_h": 100.0,    # per-step min executed value/hour
        "max_fill_hours": 24,             # route should fill within a day of trading
        "min_velocity": 0.0,
        "live_only": False,
        "sort": "score",
        "limit": 100,
    },
}


def _merged(stored: dict | None) -> dict:
    merged = copy.deepcopy(DEFAULTS)
    _deep_update(merged, stored or {})
    return merged


def get_settings() -> dict:
    """Stored settings over DEFAULTS. Read-only (one-time transforms are user migrations)."""
    return _merged(db.kv_get("settings", {}))


def save_settings(patch: dict) -> dict:
    """Deep-merge `patch` into the stored settings atomically (read → merge → write under the
    write lock, so two concurrent saves never drop each other's keys)."""
    def apply(stored):
        current = _merged(stored)
        _deep_update(current, patch)
        return current
    return db.kv_update("settings", apply, {})


# Read-site clamps for tunables the UI can save as 0/blank — one home, not per caller.
GOLD_VALUE_DIVINE_PER_1K = 0.01   # fallback: 1 Divine ≈ 100k gold (the slider's default)
HUB_N = 5                         # fallback hub count (centrality.HUB_N mirrors this)


def gold_value_per_1k(s: dict) -> float:
    return float(s.get("gold_value_per_1k") or GOLD_VALUE_DIVINE_PER_1K)


def hub_count(s: dict) -> int:
    return max(1, int(s.get("hub_count") or HUB_N))


def _deep_update(base: dict, patch: dict) -> None:
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _deep_update(base[k], v)
        else:
            base[k] = v
