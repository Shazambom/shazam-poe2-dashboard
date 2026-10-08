from __future__ import annotations

import copy
import logging

from . import cache, db, marketseries
from .config import LEAGUE

log = logging.getLogger(__name__)


from .arbpresets import ARBITRAGE_PRESETS, ARBITRAGE_UNIT, HIDDEN_KNOB_DEFAULTS as _HIDDEN  # noqa: F401 (re-exported)

_BALANCED = ARBITRAGE_PRESETS[0]["values"]

DEFAULTS: dict = {
    # Not a stored default: an unset league reads as the youngest current league (`youngest_league`),
    # and only the league dropdown stores one. LEAGUE is the fallback when no league is known.
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
    # UI colour preset (frontend/src/styles.css `:root[data-theme]` blocks). Colour only.
    "theme": "vault",
    # Custom themes built in Settings → Appearance: [{id: "custom-<8 hex>", name, base, colors: {"--bg": "#…", …}}].
    # The same token table a preset in styles.css defines (colour only). `theme` may hold a custom id.
    # A list, so a PUT replaces it wholesale (no per-row merge).
    "custom_themes": [],
    # Stash: which holdings are liquid, {trade id: bool} — they count toward liquid net worth and are
    # capital arbitrage may trade from. Only a user's choices are stored (null = cleared); a currency
    # without one takes STASH_COUNTED_BY_DEFAULT (served to the client on /api/capital).
    "stash_counted": {},
    # Gold fee model. Per-unit fees come from the game's CurrencyExchange table
    # (GoldPurchaseFee), fetched automatically. `per_unit` is only for manual
    # overrides; `per_ref_unit` is the fallback for items missing from the table.
    # `fee_side`: "buy" charges per unit received, "sell" per unit given.
    "gold_model": {**_HIDDEN["gold_model"], "per_unit": dict(_HIDDEN["gold_model"]["per_unit"])},   # a copy, never the constant
    # Route search
    "max_steps": _BALANCED["max_steps"],
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
    "batch_max_have": 10,
    "digest_max_age_h": 6,          # digest rate older than this is ignored
    "allow_digest_edges": _HIDDEN["allow_digest_edges"],
    "allow_recipe_edges": _HIDDEN["allow_recipe_edges"],
    # Edge culling: markets thinner than this never enter the graph, so junk
    # loops aren't even searched. Volume is the edge's executed value per hour
    # in the reference currency; depth is listings on a live ladder.
    "min_edge_volume_ref_per_h": 1.0,
    "min_edge_depth": 2,
    # Composite ranking weights (rank-normalised, so scales don't matter). Lead term: velocity =
    # margin_ref / (fill_hours × gold) — profit per hour per gold. Balanced preset's blend.
    "rank_weights": dict(_BALANCED["rank_weights"]),
    "volume_window_h": _BALANCED["volume_window_h"],
    # A market whose traded prices over the window disagree by this much is INACTIVE: nobody
    # quotes it continuously, so you buy at its dearest and sell at its cheapest rather than in
    # the middle (digest.directed_rates). Tunable on the Arbitrage page; 0 turns it off. Every
    # actively traded market measured under 1.4x on 2026-09-19; the median market was 1.25x.
    "wide_spread": _BALANCED["wide_spread"],
    # A wide-spread market is still a market when its book is DEEP on both sides: each side
    # standing at least `depth_hours` of the pair's own executed volume, the thin side at least
    # `depth_balance` of the deep one (owner, 2026-09-23). Measured in the pair's own units, so a
    # market that moves ten a day and one that moves a hundred thousand meet the same bar.
    "depth_hours": 1.0,
    "depth_balance": 0.1,
    "step_overhead_min": _BALANCED["step_overhead_min"],   # minutes per exchange step to place and collect an order
    # Price of gold for ranking, in Divine per 1000 gold. Gold's real worth shifts across a
    # league, so a slider (Arbitrage page, range 100k–10M gold/Divine) tunes this; it feeds
    # Convert's net-value ranking and Arbitrage velocity. Default: the Balanced preset's (1 Divine ≈ 105k gold).
    "gold_value_per_1k": _BALANCED["gold_value_per_1k"],
    # Hold's stability dial (slider on the Hold page). 0 = rank on trailing return alone;
    # higher = favour the steadier asset. Default 2.0 is the backtested setting — see
    # docs/bugs/2026-09-20-hold-ranks-against-its-own-forecast.md.
    "hold_caution": 2.0,
    # Notifications, per family (live trade pings, market signals) and per channel. In-app banner
    # and sound on by default; OS notifications opt-in. `volume` is the shared ping volume.
    "notifications": {
        "volume": 0.15,
        "live": {"banner": True, "sound": True, "os": False, "tone": "soft1"},
        "signals": {"banner": True, "sound": True, "os": False, "tone": "alert"},
    },
    # ExiledExchange2 History (desktop): record every item copied in game as a row in the workspace's
    # history folder. `max` rows kept (20…1000), `retentionDays` (7…90); both enforced by the client store.
    "ee2History": {"enabled": True, "max": 200, "retentionDays": 14},
    # Default filters (UI can override per request): the Balanced preset's, plus the user's own choices.
    "filters": {**_BALANCED["filters"], "live_only": False, "sort": "score", "limit": _HIDDEN["limit"]},
}


def _merged(stored: dict | None) -> dict:
    merged = copy.deepcopy(DEFAULTS)
    _deep_update(merged, stored or {})
    if not (stored or {}).get("league"):
        merged["league"] = youngest_league()
    return merged


_youngest: dict = {}
_YOUNGEST_TTL_S = 300


def youngest_league() -> str:
    """The default league (owner, 2026-10-02): of the leagues poe2scout marks current (`lh_current`,
    never Standard or Hardcore), the one whose history starts latest; one with no dailies yet is the
    newest of all. LEAGUE when none is known."""
    return cache.memo(_youngest, "league", _YOUNGEST_TTL_S, _youngest_now)


def _youngest_now() -> str:
    current = [lg for lg in db.kv_get(marketseries.CURRENT_LEAGUES_KEY, []) or [] if lg]
    if not current:
        return LEAGUE
    with db.q() as c:
        first = {r[0]: r[1] for r in c.execute(
            f"SELECT league, MIN(day) FROM league_daily WHERE league IN ({','.join('?' * len(current))}) GROUP BY league",
            current)}
    return max(current, key=lambda lg: first.get(lg) or "9999-12-31")


def forget_youngest() -> None:
    cache.clear(_youngest)


def get_settings() -> dict:
    """Stored settings over DEFAULTS. Read-only (one-time transforms are user migrations)."""
    return _merged(db.kv_get("settings", {}))


def save_settings(patch: dict) -> dict:
    """Deep-merge `patch` into the stored settings atomically (read → merge → write under the
    write lock, so two concurrent saves never drop each other's keys)."""
    before: dict = {}

    def apply(stored):
        nonlocal before
        before = _merged(stored)
        current = copy.deepcopy(before)
        _deep_update(current, patch)
        if "league" not in patch and not (stored or {}).get("league"):
            current.pop("league", None)   # the default is read, never stored: the next league reaches everyone
        return current
    saved = db.kv_update("settings", apply, {})
    _log_changes(before, _merged(saved))
    return saved


def _log_changes(before: dict, after: dict) -> None:
    """One line per changed setting (when the user switched league is a report's first question)."""
    for k in sorted(set(before) | set(after)):
        a, b = before.get(k), after.get(k)
        if a == b:
            continue
        if isinstance(a, (dict, list)) or isinstance(b, (dict, list)):
            log.info("settings: %s changed", k)
        else:
            log.info("settings: %s %s → %s", k, repr(a)[:80], repr(b)[:80])


# Read-site clamps for tunables the UI can save as 0/blank — one home, not per caller.
GOLD_VALUE_DIVINE_PER_1K = 0.01   # fallback: 1 Divine ≈ 100k gold (the slider's default)
HUB_N = 5                         # fallback hub count (centrality.HUB_N mirrors this)


def gold_value_per_1k(s: dict) -> float:
    return float(s.get("gold_value_per_1k") or GOLD_VALUE_DIVINE_PER_1K)


def hold_caution(s: dict) -> float:
    """Hold's drawdown weight. Clamped by `holdscore.clamp_k`, which owns the range."""
    from .holdscore import clamp_k
    v = s.get("hold_caution")
    return clamp_k(DEFAULTS["hold_caution"] if v is None else v)


def wide_spread(s: dict) -> float:
    """How far apart a market's traded prices may run before it counts as inactive (0 = never)."""
    try:
        v = float(s.get("wide_spread"))
    except (TypeError, ValueError):
        return DEFAULTS["wide_spread"]
    # `hi/lo >= wide` with wide in (0, 1) is true of every market that traded twice; only 0 (off)
    # and >= 1 mean anything. Anything else is the default, not a switch that kills every market.
    return v if v == 0 or v >= 1.0 else DEFAULTS["wide_spread"]


def _positive(s: dict, key: str) -> float:
    try:
        v = float(s.get(key))
    except (TypeError, ValueError):
        return DEFAULTS[key]
    return v if v >= 0 else DEFAULTS[key]


def depth_hours(s: dict) -> float:
    """Hours of the pair's own executed volume each side of the book must stand to be deep."""
    return _positive(s, "depth_hours")


def depth_balance(s: dict) -> float:
    """The thin side of a deep book holds at least this share of the deep side's units."""
    return _positive(s, "depth_balance")


STASH_COUNTED_BY_DEFAULT = True     # every holding is liquid until the user switches it off


def stash_counted(s: dict, currency: str) -> bool:
    """Whether a holding is liquid: the user's Stash switch, else the default."""
    v = (s.get("stash_counted") or {}).get(currency)
    return STASH_COUNTED_BY_DEFAULT if v is None else bool(v)


def hub_count(s: dict) -> int:
    return max(1, int(s.get("hub_count") or HUB_N))


def _deep_update(base: dict, patch: dict) -> None:
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _deep_update(base[k], v)
        else:
            base[k] = v
