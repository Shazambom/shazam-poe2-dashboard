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
    # Default filters (UI can override per request)
    "filters": {
        "min_margin_pct": 0.5,
        "min_margin_ref": 0.0,
        "max_gold": 0,
        "min_margin_per_1k_gold": 0.0,
        "min_liquidity_ref": 0.0,
        "min_volume_ref_per_h": 0.0,
        "max_fill_hours": 0,
        "min_velocity": 0.0,
        "live_only": False,
        "sort": "score",
        "limit": 100,
    },
}


def get_settings() -> dict:
    stored = db.kv_get("settings", {})
    merged = copy.deepcopy(DEFAULTS)
    _deep_update(merged, stored)
    return merged


def save_settings(patch: dict) -> dict:
    current = get_settings()
    _deep_update(current, patch)
    db.kv_set("settings", current)
    return current


def _deep_update(base: dict, patch: dict) -> None:
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _deep_update(base[k], v)
        else:
            base[k] = v
