"""Phase 4 — signal acknowledgement: pure helpers + the read/ack surface behind /api/signals.

A fired signal is identified by (item_id, spike-day t): stable across the sidecar's periodic
recompute, so a user's dismissal sticks while the same signal keeps re-firing and lapses on its own
once the spike ages out of the recent window. The ack set is `{sig_key: acked_at}` stored in the
user kv `signals_ack`; these helpers annotate the read surface, count what's unseen, merge new
dismissals, and prune acks whose signal is gone so the set stays bounded.
"""
from __future__ import annotations

from . import analytics, db, movers


def sig_key(sig: dict) -> str:
    return f"{sig.get('item_id')}:{sig.get('t')}"


def annotate(signals: list[dict], ack: dict) -> list[dict]:
    """Each signal + an `acked` flag (True if the user has dismissed it)."""
    return [{**s, "acked": sig_key(s) in ack} for s in signals]


def unseen_count(signals: list[dict], ack: dict) -> int:
    return sum(1 for s in signals if sig_key(s) not in ack)


def merge(ack: dict, keys, at: int) -> dict:
    """Add `keys` to the ack set at time `at`, keeping the earliest ack time for a key (idempotent —
    re-acking never resets the timestamp)."""
    out = dict(ack)
    for k in keys:
        out.setdefault(str(k), at)
    return out


def prune(ack: dict, signals: list[dict]) -> dict:
    """Drop acks for signals no longer in the live set — housekeeping so the set can't grow forever."""
    live = {sig_key(s) for s in signals}
    return {k: v for k, v in ack.items() if k in live}


# --------------------------------------------------------------- the read/ack surface
def _fired():
    """(league, signals) from the sidecar's cache — empty when it hasn't run (graceful degrade)."""
    with db.q() as c:
        blob = analytics.read_cache(c, "discords", "current")   # {league, signals}, or None
    league = blob.get("league") if blob else movers.current_league()
    return league, ((blob.get("signals") or []) if blob else [])


def read() -> dict:
    """The /api/signals payload. READ-ONLY: never writes the ack set."""
    league, signals = _fired()
    ack = db.kv_get("signals_ack", {}) or {}
    return {"league": league, "signals": annotate(signals, ack), "unseen": unseen_count(signals, ack)}


def ack(keys, all_fired: bool, now: int) -> dict:
    """Dismiss `keys` (or everything fired when all_fired) atomically, pruning acks whose signal is
    gone. Returns the /api/signals/ack payload."""
    _league, signals = _fired()
    to_ack = [sig_key(s) for s in signals] if all_fired else (keys or [])
    merged = db.kv_update("signals_ack", lambda a: prune(merge(a or {}, to_ack, now), signals), {})
    return {"ok": True, "unseen": unseen_count(signals, merged)}
