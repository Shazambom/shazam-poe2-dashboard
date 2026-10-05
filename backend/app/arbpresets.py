"""The Arbitrage page's presets: constants only, no app imports, because db.py runs the user migrations (m8 reads
Balanced) while it is still loading, and settings imports db (docs/learnability-plan.md part 4)."""
from __future__ import annotations


def _preset(pid: str, label: str, *, min_margin_pct, max_gold, min_margin_per_1k_gold, min_liquidity_ref,
            min_volume_ref_per_h, max_step_minutes, weights, volume_window_h, wide_spread, gold_value_per_1k) -> dict:
    velocity, gold_eff, margin, volume = weights
    return {"id": pid, "label": label, "values": {
        "filters": {"min_margin_pct": min_margin_pct, "min_margin_ref": 0, "max_gold": max_gold,
                    "min_margin_per_1k_gold": min_margin_per_1k_gold, "min_liquidity_ref": min_liquidity_ref,
                    "min_volume_ref_per_h": min_volume_ref_per_h, "max_fill_hours": 0,
                    "max_step_minutes": max_step_minutes, "min_velocity": 0, "exclude_recipes": False},
        "max_steps": 3,
        "rank_weights": {"velocity": velocity, "margin_per_1k_gold": gold_eff, "margin_ref": margin, "volume": volume},
        "step_overhead_min": 2, "volume_window_h": volume_window_h, "wide_spread": wide_spread,
        "gold_value_per_1k": gold_value_per_1k,
    }}


# The Arbitrage page's presets, tuned by the owner in the packaged app (2026-10-05; docs/learnability-plan.md).
# A preset is every Filters / More filters / Arbitrage algorithm value plus the gold price; never Start from,
# Show at most or the share of capital to commit, which stay the user's. Currency amounts are in exalted
# (ARBITRAGE_UNIT) whatever the reference. Balanced is the default (DEFAULTS below, and migration m8).
ARBITRAGE_PRESETS: list[dict] = [
    _preset("balanced", "Balanced", min_margin_pct=20, max_gold=0, min_margin_per_1k_gold=0, min_liquidity_ref=1000,
            min_volume_ref_per_h=100, max_step_minutes=60, weights=(0.6, 0.2, 0.35, 0.3), volume_window_h=72,
            wide_spread=2, gold_value_per_1k=0.009527348253160697),
    _preset("quick", "Quick flips", min_margin_pct=5, max_gold=1000000, min_margin_per_1k_gold=0.41,
            min_liquidity_ref=200, min_volume_ref_per_h=10000, max_step_minutes=15, weights=(0.8, 0.2, 0.4, 0.4),
            volume_window_h=24, wide_spread=2, gold_value_per_1k=0.009098518761145686),
    _preset("big", "Big margins", min_margin_pct=66, max_gold=2000000, min_margin_per_1k_gold=0, min_liquidity_ref=2000,
            min_volume_ref_per_h=2000, max_step_minutes=45, weights=(0.2, 0.2, 1.0, 0.35), volume_window_h=24,
            wide_spread=3.5, gold_value_per_1k=0.019452225334578275),
    _preset("gold", "Gold efficient", min_margin_pct=0, max_gold=1000000, min_margin_per_1k_gold=0,
            min_liquidity_ref=2000, min_volume_ref_per_h=2000, max_step_minutes=45, weights=(0.9, 1.0, 0.2, 0.4),
            volume_window_h=24, wide_spread=3.5, gold_value_per_1k=0.05),
    _preset("safe", "Safe", min_margin_pct=8, max_gold=1200000, min_margin_per_1k_gold=0, min_liquidity_ref=10000,
            min_volume_ref_per_h=5000, max_step_minutes=120, weights=(0.3, 0.2, 0.5, 1.0), volume_window_h=72,
            wide_spread=2, gold_value_per_1k=0.019905251005215174),
]
ARBITRAGE_UNIT = "exalted"   # the currency the presets' (and the page's) currency thresholds are written in
