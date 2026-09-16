"""Local self-diagnostics for the (self-contained) desktop app — the /api/diag payload.

Settings, DB row counts, backfill/digest state, the heavy-analytics pipeline state, and a live
connectivity probe that goes through the SAME gateway every real fetch uses (so a PyInstaller
SSL/cert failure that silently breaks every price fetch shows up here too). Read in-app under
Settings → Diagnostics. No data leaves the machine.
"""
from __future__ import annotations

import time

from . import analytics, config, db, digest, gateway, leaguehistory, movers, orderbook, session, sidecar_supervisor
from .currencies import registry
from .settings import get_settings

_TABLES = ("league_daily", "item_meta", "digest_markets", "orderbook", "capital", "kv", "kv_ops")
_PROBES = {
    "poecdn(digest)": (config.GGG_DIGEST_URL, "digest"),
    "poe2scout": (leaguehistory.BASE + "/Leagues", "poe2scout"),
    "pathofexile": (config.TRADE_STATIC_URL, "trade"),
}


def _db_counts(league: str) -> dict:
    counts: dict = {}
    with db.q() as c:
        for t in _TABLES:
            try:
                counts[t] = c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            except Exception as e:
                counts[t] = f"err:{e}"
        try:
            counts["league_daily[current_league]"] = c.execute(
                "SELECT COUNT(*) FROM league_daily WHERE league=?", (league,)).fetchone()[0]
        except Exception:
            pass
    return counts


async def _connectivity() -> dict:
    net: dict = {}
    for name, (url, policy) in _PROBES.items():
        try:
            r = await gateway.request("GET", url, policy=policy, retries=0, timeout=8)
            net[name] = r.status_code
        except Exception as e:
            net[name] = f"ERR {type(e).__name__}: {str(e)[:140]}"
    return net


def _analytics(league: str) -> dict:
    """Is the sidecar producing signals, or failing? Jobs by state + the newest error pinpoint it;
    screen_league vs cache_league tells "computed the wrong league" from "no discords right now"."""
    out: dict = {}
    try:
        out["sidecar_cmd"] = bool(sidecar_supervisor._sidecar_cmd())
        with db.q() as c:
            out["jobs"] = {r[0]: r[1] for r in c.execute(
                "SELECT state, COUNT(*) FROM analytics_jobs GROUP BY state")}
            err = c.execute("SELECT kind, error FROM analytics_jobs WHERE state='error' "
                            "ORDER BY id DESC LIMIT 1").fetchone()
            out["last_error"] = (f"{err[0]}: {str(err[1])[:200]}" if err else None)
            sig = analytics.read_cache(c, "discords", "current")
            out["signals"] = len((sig or {}).get("signals") or [])
            out["cache_league"] = (sig or {}).get("league")
            out["arc_weighted"] = bool((analytics.read_cache(c, "arc", "current") or {}).get("weights"))
        try:
            out["screen_league"] = movers.current_league()
        except Exception:
            out["screen_league"] = league
    except Exception as e:
        out["err"] = f"{type(e).__name__}: {str(e)[:160]}"
    return out


async def collect() -> dict:
    s = get_settings()
    return {
        "time": time.time(),
        "data_dir": str(config.DATA_DIR),
        "settings": {"league": s["league"], "reference": s["reference"], "watchlist": s["watchlist"]},
        "db_counts": _db_counts(s["league"]),
        "registry": {"loaded_at": registry.loaded_at, "count": len(registry.by_id)},
        "digest": dict(digest.state),
        "orderbook": orderbook.state,
        "leaguehistory_current": db.kv_get("lh_current", []),
        "session_connected": session.status().get("connected", False),
        "connectivity": await _connectivity(),
        "analytics": _analytics(s["league"]),
    }
