"""Local self-diagnostics for the (self-contained) desktop app — the /api/diag payload.

Settings, DB row counts, backfill/digest state, the heavy-analytics pipeline state, and a live
connectivity probe that goes through the SAME gateway every real fetch uses (so a PyInstaller
SSL/cert failure that silently breaks every price fetch shows up here too). Read in-app under
Settings → Diagnostics. No data leaves the machine.
"""
from __future__ import annotations

import asyncio
import time

from . import analytics, config, db, digest, gateway, leaguehistory, movers, orderbook, session, sidecar_supervisor
from .currencies import registry
from .settings import get_settings

_TABLES = ("league_daily", "item_meta", "digest_markets", "orderbook", "capital", "kv", "kv_ops")
# Probes ride the SAME httpx client as every real fetch (so a PyInstaller SSL/cert failure shows
# up here), but on the lenient `static` policy and concurrently: a diagnostic must answer in a
# second or two, not queue behind the exchange sweep's 1-per-6s trade budget.
_PROBES = {
    "poecdn(digest)": (config.GGG_DIGEST_URL, "static"),
    "poe2scout": (leaguehistory.BASE + "/Leagues", "static"),
    "pathofexile": (config.TRADE_STATIC_URL, "static"),
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


def _league_history() -> dict:
    """{league: {rows, items, first, last}} — which leagues the Hold/Movers history covers."""
    with db.q() as c:
        return {r[0]: {"rows": r[1], "items": r[2], "first": r[3], "last": r[4]} for r in c.execute(
            "SELECT league, COUNT(*), COUNT(DISTINCT item_id), MIN(day), MAX(day) FROM league_daily "
            "GROUP BY league ORDER BY league")}


UNKNOWN_LIMIT = 25


def _unknown_traded(league: str, now: float | None = None) -> list[dict]:
    """The exchange items traded in this league over the last 24 h that the app cannot name (no
    currency in the registry), most traded first: they are unpickable and unpriced."""
    since = int((now if now is not None else time.time()) - 24 * 3600)
    vol: dict[str, int] = {}
    with db.q() as c:
        for a, b, va, vb in c.execute("SELECT cur_a, cur_b, vol_a, vol_b FROM digest_markets "
                                      "WHERE league=? AND hour>=?", (league, since)):
            for meta, v in ((a, va), (b, vb)):
                vol[meta] = vol.get(meta, 0) + int(v or 0)
    unknown = [(v, m) for m, v in vol.items() if not registry.resolve_meta(m)]
    return [{"meta": m, "volume_24h": v} for v, m in sorted(unknown, key=lambda x: (-x[0], x[1]))[:UNKNOWN_LIMIT]]


async def _probe(url: str, policy: str):
    try:
        r = await gateway.request("GET", url, policy=policy, retries=0, timeout=8)
        return r.status_code
    except Exception as e:
        return f"ERR {type(e).__name__}: {str(e)[:140]}"


async def _connectivity() -> dict:
    results = await asyncio.gather(*(_probe(url, policy) for url, policy in _PROBES.values()))
    return dict(zip(_PROBES, results))


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
        "league_history": _league_history(),
        "unknown_traded": _unknown_traded(s["league"]),
        "digest": dict(digest.state),
        "orderbook": orderbook.state,
        "leaguehistory_current": db.kv_get("lh_current", []),
        "session_connected": session.status().get("connected", False),
        "connectivity": await _connectivity(),
        "analytics": _analytics(s["league"]),
    }
