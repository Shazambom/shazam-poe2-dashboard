from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel

from fastapi.responses import RedirectResponse, PlainTextResponse

from . import analytics, arbitrage, db, digest, gamedata, gateway, holdscore, inflation, leaguearc, leaguehistory, liquidity, migrations_user, movers, oauth, orderbook, recipes, session, sidecar_supervisor, signalsack, watchdog
from .currencies import registry
from .settings import get_settings, save_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("poe2arb")

_bg_tasks: set = set()   # keep strong refs so fire-and-forget tasks aren't GC'd mid-flight


def _spawn(coro) -> None:
    """Run a coroutine in the background, retaining a reference and logging failures
    (a bare create_task can be GC'd early and swallows exceptions)."""
    t = asyncio.create_task(coro)
    _bg_tasks.add(t)
    t.add_done_callback(lambda tt: (_bg_tasks.discard(tt),
                                    tt.cancelled() or tt.exception() and log.error("bg task failed: %s", tt.exception())))


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Die with our parent (Electron). Desktop sets ARBITER_PARENT_PID; the web/server env does
    # NOT, so this is a no-op there (never self-terminate a server). Deliberately PID-poll ONLY
    # (stdin_eof=False): Electron spawns us with stdin='ignore', not a held-open pipe, so there's
    # no EOF signal to watch — and leaving stdin alone keeps uvicorn unaffected. The poll (incl.
    # the Windows handle check in watchdog._win_alive) is the backend's sole death signal, which is
    # sufficient: it catches a hard Electron crash, the exact "dangling backend locks the install
    # dir" case. (The sidecar, spawned WITH a stdin pipe, additionally gets the EOF primary.)
    _parent = os.environ.get("ARBITER_PARENT_PID")
    if _parent and _parent.isdigit():
        watchdog.guard(parent_pid=int(_parent), stdin_eof=False)
    await registry.load_static()
    sidecar_supervisor.start()          # spawn + supervise the heavy-analytics sidecar (no-op if absent)
    tasks = [asyncio.create_task(digest.run_forever()), asyncio.create_task(_gold_fee_loop()),
             asyncio.create_task(orderbook.worker()), asyncio.create_task(orderbook.sweeper()),
             asyncio.create_task(_league_history_loop()), asyncio.create_task(_analytics_loop())]
    if not session.get_cookie():
        log.info("no trade session yet: connect one in Settings to enable the live order book")
    yield
    for t in tasks:
        t.cancel()
    sidecar_supervisor.stop()


async def _gold_fee_loop():
    while True:
        try:
            await gamedata.refresh()
        except Exception as exc:
            log.exception("gold fee refresh error: %s", exc)
        await asyncio.sleep(86400)


async def _league_history_loop():
    while True:
        try:
            await leaguehistory.backfill()
        except Exception as exc:
            log.exception("league history backfill error: %s", exc)
        await asyncio.sleep(12 * 3600)


async def _analytics_loop():
    """Periodically ask the sidecar to refresh analytics for the league actually on screen (the
    resolved current league, so we never target one with no data). enqueue coalesces, so a busy
    or down sidecar just means the request waits — the endpoint degrades to empty meanwhile.
    league_daily only gains rows daily, so a low cadence is plenty."""
    await asyncio.sleep(20)             # let the sidecar come up first
    while True:
        try:
            league = await run_in_threadpool(movers.current_league)
            if league:
                # Both heavy jobs target the on-screen league. enqueue coalesces per kind, so this
                # never piles up; the sidecar claims oldest-first and computes each.
                def _enqueue():
                    c = db._conn()
                    analytics.enqueue(c, "discords", {"league": league})
                    analytics.enqueue(c, "arc", {"league": league})
                await run_in_threadpool(_enqueue)
        except Exception as exc:
            log.warning("analytics enqueue error: %s", exc)
        await asyncio.sleep(7200)       # every 2h (daily data — no need to churn)


app = FastAPI(title="PoE2 currency arbitrage", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ------------------------------------------------------------------ status
@app.get("/api/status")
def status():
    s = get_settings()
    d = dict(digest.state)
    behind = max(0.0, time.time() - (d["last_hour"] + 3600)) if d.get("last_hour") else None
    d["behind_h"] = round(behind / 3600, 1) if behind is not None else None
    d["backfilling"] = behind is not None and behind > 2 * 3600
    return {
        "time": time.time(),
        "league": s["league"],
        "reference": s["reference"],
        "digest": d,
        "orderbook": orderbook.state,
        "rate_limits": gateway.status(),
        "session": session.status(),
        "oauth": oauth.status(),
        "registry_loaded_at": registry.loaded_at,
        "unmapped_metadata_ids": len(registry.unmapped_meta),
        "gold_fees": gamedata.state,
    }


# ------------------------------------------------------ installer telemetry
# The Windows NSIS installer POSTs a diagnostic report here (process list, env,
# existing-install listing) on every attempt, so we can see WHY it fails on a PC
# we can't touch. Appended to /data/install-reports.log; readable back for triage.
_INSTALL_LOG = "/data/install-reports.log"


@app.post("/api/installlog")
async def install_log(request: Request):
    body = (await request.body()).decode("utf-8", "replace")[:20000]
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    client = request.client.host if request.client else "?"
    try:
        with open(_INSTALL_LOG, "a", encoding="utf-8") as f:
            f.write(f"\n===== {stamp} from {client} =====\n{body}\n")
    except Exception as e:  # never let telemetry break the installer
        log.warning("install_log write failed: %s", e)
    log.info("install report from %s (%d bytes)", client, len(body))
    return {"ok": True}


@app.get("/api/backfill")
def backfill_status():
    """Live cold-start progress so the UI can stream 'building your dashboard…' instead
    of showing a blank/stale board on a fresh (self-contained) install."""
    p = dict(leaguehistory.progress)
    # A crawl that hasn't ticked in a while (rare mid-crawl error) is not 'running'.
    if p.get("running") and p.get("updated") and time.time() - p["updated"] > 30:
        p["running"], p["phase"] = False, "stalled"
    tot = p.get("league_total") or 0
    p["pct"] = round(100 * (p.get("league_done") or 0) / tot, 1) if tot else (100.0 if p.get("phase") == "done" else 0.0)
    return p


@app.get("/api/diag")
async def diag():
    """Local self-diagnostics for the (self-contained) desktop app: settings, DB row
    counts, backfill/digest state, and a live connectivity probe. Read in-app under
    Settings → Diagnostics. No data leaves the machine."""
    import httpx

    from . import config
    s = get_settings()
    counts: dict = {}
    with db.q() as c:
        for t in ("league_daily", "item_meta", "digest_markets", "orderbook", "capital", "kv"):
            try:
                counts[t] = c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            except Exception as e:
                counts[t] = f"err:{e}"
        try:
            counts["league_daily[current_league]"] = c.execute(
                "SELECT COUNT(*) FROM league_daily WHERE league=?", (s["league"],)).fetchone()[0]
        except Exception:
            pass
    # Live reachability from THIS backend (catches PyInstaller SSL/cert failures that
    # silently break every price fetch → "no prices").
    net: dict = {}
    probes = {
        "poecdn(digest)": config.GGG_DIGEST_URL,
        "poe2scout": "https://api.poe2scout.com/poe2/Leagues",
        "pathofexile": config.TRADE_STATIC_URL,
    }
    async with httpx.AsyncClient(timeout=8, headers={"User-Agent": config.USER_AGENT}) as cx:
        for name, url in probes.items():
            try:
                r = await cx.get(url)
                net[name] = r.status_code
            except Exception as e:
                net[name] = f"ERR {type(e).__name__}: {str(e)[:140]}"
    return {
        "time": time.time(),
        "data_dir": str(config.DATA_DIR),
        "settings": {"league": s["league"], "reference": s["reference"], "watchlist": s["watchlist"]},
        "db_counts": counts,
        "registry": {"loaded_at": registry.loaded_at, "count": len(registry.by_id)},
        "digest": dict(digest.state),
        "orderbook": orderbook.state,
        "leaguehistory_current": db.kv_get("lh_current", []),
        "session_connected": session.status().get("connected", False),
        "connectivity": net,
    }


@app.get("/api/installlog")
def install_log_read():
    try:
        with open(_INSTALL_LOG, encoding="utf-8") as f:
            return PlainTextResponse(f.read()[-60000:])
    except FileNotFoundError:
        return PlainTextResponse("(no install reports yet)")


# ------------------------------------------------------------- currencies
@app.get("/api/currencies")
def currencies():
    return registry.to_json()


class MetaOverride(BaseModel):
    metadata_id: str
    trade_id: str


@app.post("/api/currencies/map")
def map_currency(body: MetaOverride):
    registry.set_override(body.metadata_id, body.trade_id)
    return {"ok": True}


# ---------------------------------------------------------------- capital
@app.get("/api/capital")
def capital():
    caps = db.get_capital()
    g = arbitrage.cached_graph()
    ref = g.ref_values()
    gv = float(g.s.get("gold_value_per_1k") or arbitrage.GOLD_VALUE_DIVINE_PER_1K)
    cash = liquidity.cash_set(g, ref)          # hub currencies = cash-like; derived once (PageRank)
    rows = []
    for c, q in caps.items():
        row = {"currency": c, "name": registry.name(c), "qty": q, "ref_value": ref.get(c),
               "value_ref": (q * ref[c]) if c in ref else None}
        # Ghost Wealth: what the stack would ACTUALLY realize if cashed out now (best path to
        # the reference, net of gold), plus slippage/fill-time/confidence. Never fails a request.
        liq = liquidity.realizable(g, ref, c, q, cash=cash, gold_value_per_1k=gv)
        row.update(realizable_ref=liq["realizable_ref"], slippage_pct=liq["slippage_pct"],
                   fill_hours=liq["fill_hours"], source=liq["source"], full_fill=liq["full_fill"],
                   cashout_path=liq["path"])
        rows.append(row)
    total = sum(r["value_ref"] for r in rows if r["value_ref"] is not None)
    realizable_total = sum(r["realizable_ref"] for r in rows if r["realizable_ref"] is not None)
    return {"rows": rows, "total_ref": total, "realizable_total_ref": realizable_total,
            "ghost_ref": total - realizable_total, "reference": g.s["reference"]}


class CapitalBody(BaseModel):
    entries: dict[str, float]


@app.put("/api/capital")
def put_capital(body: CapitalBody):
    db.set_capital(body.entries)
    arbitrage.invalidate_caches()   # routes are sized from capital, so drop the route cache
    return capital()


# --------------------------------------------------------------- settings
@app.get("/api/settings")
def settings():
    return get_settings()


class SettingsPatch(BaseModel):
    patch: dict


@app.put("/api/settings")
def put_settings(body: SettingsPatch):
    saved = save_settings(body.patch)
    arbitrage.invalidate_caches()   # league/reference/etc. change what the graph means
    return saved


# ---------------------------------------------------------------- recipes
@app.get("/api/recipes")
def get_recipes():
    return recipes.load()


class RecipesBody(BaseModel):
    recipes: list[dict]


@app.put("/api/recipes")
def put_recipes(body: RecipesBody):
    saved = recipes.save(body.recipes)
    arbitrage.invalidate_caches()   # recipe edges are part of the graph
    return saved


# ---------------------------------------------------------- trade session
class SessionBody(BaseModel):
    cookie: str
    label: str | None = None


@app.get("/api/session")
def session_status():
    return session.status()


@app.post("/api/session")
async def session_connect(body: SessionBody):
    try:
        result = await session.connect(body.cookie, body.label)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    orderbook.request_refresh()
    return result


@app.delete("/api/session")
def session_disconnect():
    return session.disconnect()


# ------------------------------------------------------------------ oauth
class OAuthStart(BaseModel):
    redirect_uri: str | None = None


class OAuthComplete(BaseModel):
    code: str
    state: str


@app.get("/api/oauth/status")
def oauth_status():
    return oauth.status()


@app.post("/api/oauth/start")
def oauth_start(body: OAuthStart | None = None):
    try:
        return oauth.start(body.redirect_uri if body else None)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc))


@app.post("/api/oauth/complete")
async def oauth_complete(body: OAuthComplete):
    try:
        return await oauth.complete(body.code, body.state)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.get("/callback")
@app.get("/api/oauth/callback")
async def oauth_callback(code: str | None = None, state: str | None = None,
                         error: str | None = None, error_description: str | None = None):
    if error:
        return RedirectResponse(f"/?oauth=error&msg={error_description or error}")
    if not code or not state:
        raise HTTPException(400, "missing code or state")
    try:
        await oauth.complete(code, state)
    except ValueError as exc:
        return RedirectResponse(f"/?oauth=error&msg={exc}")
    return RedirectResponse("/?oauth=ok")


@app.post("/api/oauth/logout")
def oauth_logout():
    return oauth.logout()


@app.get("/api/account/profile")
async def account_profile():
    try:
        return await oauth.get("/profile")
    except PermissionError as exc:
        raise HTTPException(401, str(exc))


@app.get("/api/account/characters")
async def account_characters():
    try:
        return await oauth.get("/character/poe2")
    except PermissionError as exc:
        raise HTTPException(401, str(exc))


# -------------------------------------------------------------- gold fees
@app.get("/api/goldfees")
def gold_fees():
    return gamedata.fees()


@app.post("/api/goldfees/refresh")
async def gold_fees_refresh():
    return await gamedata.refresh(force=True)


# ----------------------------------------------------------------- market
# ---------------------------------------------------------------- watches
# Saved trade searches (Better-Trading style): folders -> searches, each search
# storing only {type, slug} + title. The league is NOT stored — it's injected at
# open time so a watch survives league resets. Pure organiser; opening a search
# just navigates the trade site (GGG runs the live search, whispering is manual).
class WatchesBody(BaseModel):
    folders: list[dict]


@app.get("/api/watches")
def get_watches():
    return {"folders": db.kv_get("watches", [])}


@app.put("/api/watches")
def put_watches(body: WatchesBody):
    db.kv_set("watches", body.folders)
    return {"folders": body.folders}


# Filesystem workspace (nested tree) — the successor to the flat watches organiser.
# Stored under a NEW user-kv key `trading_workspace`; the legacy `watches` blob is kept
# untouched as a backup (see migrations_user._m2). /api/watches stays alive so a lagging
# desktop build during a batched rollout keeps working.
def _empty_workspace() -> dict:
    return {"version": 2, "tree": [], "layout": None, "openTabs": []}


class WorkspaceBody(BaseModel):
    workspace: dict


@app.get("/api/trading/workspace")
def get_workspace():
    ws = db.kv_get("trading_workspace")
    if isinstance(ws, dict) and ws.get("version") == 2:
        return {"workspace": ws}
    # Belt-and-suspenders: coerce a legacy watches blob on read if the migration hasn't run
    # (e.g. a dev DB). Non-destructive — does not write.
    legacy = db.kv_get("watches", [])
    return {"workspace": migrations_user.watches_to_workspace(legacy) if legacy else _empty_workspace()}


@app.put("/api/trading/workspace")
def put_workspace(body: WorkspaceBody):
    ws = body.workspace
    if ws.get("version") != 2 or not isinstance(ws.get("tree"), list):
        raise HTTPException(status_code=400, detail="workspace must be {version:2, tree:[...]}")
    db.kv_set("trading_workspace", ws)
    return {"workspace": ws}


@app.get("/api/inflation")
def inflation_view(anchor: str = "hinekora", hours: int = 336):
    return inflation.compute(anchor, hours)


@app.get("/api/inflation/cross")
async def inflation_cross(item: int = leaguehistory.DEFAULT_ITEM):
    """Age-aligned cross-league inflation (Divine-in-Exalted). Backfills from
    poe2scout on first call / when current-league data is stale, then serves."""
    res = await run_in_threadpool(leaguehistory.cross, item)   # sync DB scan off the event loop
    if not res["leagues"]:                       # cold cache — quick anchors-only pull then serve
        await leaguehistory.backfill(full=False)
        res = await run_in_threadpool(leaguehistory.cross, item)
    return res


@app.get("/api/hold")
async def hold(horizon: str = "3d", category: str = "all", numeraire: str = "divine"):
    """Store-of-value leaderboard. Served from the stored full-currency backfill;
    kicks the background crawl if nothing's stored yet."""
    res = await run_in_threadpool(holdscore.leaderboard, horizon, category, numeraire)
    if not res["assets"]:
        _spawn(leaguehistory.backfill(full=True))
        return {**res, "building": True}
    return res


@app.get("/api/movers")
async def movers_ep(window_h: int = 24, n: int = 3, dir: str = "both"):
    """Biggest movers across the full poe2scout universe, by % change over the window, in the
    league base. dir='both' ranks by |change| (gainers AND crashers); 'up'/'down' keep only
    that direction. Distinct from /api/hold's store-of-value ranking."""
    return await run_in_threadpool(movers.top_movers, window_h, n, movers.MIN_VALUE_EX, dir)


@app.get("/api/asset")
async def asset_ep(q: str, window_h: int = 24):
    """One asset's price/volume/trend detail for the Board's expand modal (any pulse-strip
    item, not just watchlist currencies). `q` is a currency name or slug."""
    res = await run_in_threadpool(movers.asset_row, q, window_h)
    if not res:
        raise HTTPException(404, f"no daily data for {q!r}")
    return res


@app.get("/api/signals")
async def signals_ep():
    """Volume-confirmed 'about to move' discord signals for the current league, computed by the
    analytics sidecar and cached in market.sqlite. READ-ONLY: if the sidecar is down or hasn't
    run yet this returns an empty list — it never fails a request (graceful degrade). The Phase-4
    inbox UI will consume this; for now it's the sidecar's read surface."""
    def _read():
        with db.q() as c:
            blob = analytics.read_cache(c, "discords", "current")   # {league, signals}, or None
        league = blob.get("league") if blob else movers.current_league()
        signals = (blob.get("signals") or []) if blob else []
        ack = db.kv_get("signals_ack", {}) or {}
        pruned = signalsack.prune(ack, signals)     # drop acks whose signal has aged out
        if pruned != ack:
            db.kv_set("signals_ack", pruned)
        return {"league": league, "signals": signalsack.annotate(signals, pruned),
                "unseen": signalsack.unseen_count(signals, pruned)}
    return await run_in_threadpool(_read)


class SignalAck(BaseModel):
    keys: list[str] | None = None   # sig_keys ("item_id:t") to dismiss
    all: bool = False               # dismiss every currently-fired signal


@app.post("/api/signals/ack")
async def signals_ack_ep(body: SignalAck):
    """Dismiss signals (user data → signals_ack in user.sqlite). `keys` dismisses those signal ids;
    `all: true` dismisses everything currently fired. Returns the new unseen count."""
    def _ack():
        with db.q() as c:
            blob = analytics.read_cache(c, "discords", "current")
        signals = (blob.get("signals") or []) if blob else []
        keys = [signalsack.sig_key(s) for s in signals] if body.all else (body.keys or [])
        ack = db.kv_get("signals_ack", {}) or {}
        merged = signalsack.prune(signalsack.merge(ack, keys, int(time.time())), signals)
        db.kv_set("signals_ack", merged)
        return {"ok": True, "unseen": signalsack.unseen_count(signals, merged)}
    return await run_in_threadpool(_ack)


@app.get("/api/leaguearc")
async def leaguearc_ep(numeraire: str = "divine"):
    """League-level arc anchor for the topbar chip: {league, day, phase, resembles, weighted}. The
    ambient 'where are we in the league' indicator; per-item detail is /api/arc. Read-only."""
    return await run_in_threadpool(leaguearc.context, numeraire)


@app.get("/api/arc")
async def arc_ep(item: str, numeraire: str = "divine"):
    """Phase 3 league-arc for one item priced in `numeraire`: the price history so far ('you are here
    at day N'), a forward projected band, buy/sell windows, and which past league it resembles. The
    projection is DTW-weighted by the sidecar when available and silently falls back to recency
    otherwise. READ-ONLY over market data + the analytics cache — never fails a request."""
    return await run_in_threadpool(leaguearc.arc_for, item, numeraire)


@app.get("/api/convert")
async def convert_ep(have: str, want: str, amount: float | None = None, max_steps: int | None = None):
    """Cheapest way to turn `have` into `want` across the live exchange graph (open path, not a
    profit loop). Returns the best route + the direct-market baseline + loss. Read-only."""
    return await run_in_threadpool(arbitrage.convert, have, want, amount, max_steps)


@app.get("/api/inflation/marketcap")
async def inflation_marketcap():
    """Economy size per league in Mirrors (total value traded/day). Served from the
    stored full-currency backfill; if that hasn't run yet, kick it in the background."""
    res = await run_in_threadpool(leaguehistory.marketcap)
    if not res["leagues"]:
        _spawn(leaguehistory.backfill(full=True))
        return {**res, "building": True}
    return res


@app.post("/api/inflation/cross/refresh")
async def inflation_cross_refresh(force: bool = False):
    # Fire-and-forget: the full backfill takes minutes (rate-limited), longer than any
    # proxy/client timeout, and a disconnected request would be cancelled mid-way.
    _spawn(leaguehistory.backfill(force=force, full=True))
    return {"started": True}


@app.get("/api/board")
def board(window_h: int = 24):
    return arbitrage.board(window_h)


@app.post("/api/board/refresh")
async def board_refresh(wait_s: float = 30, window_h: int = 24):
    """Live-refresh both directions of every watched pair, then return the board."""
    if not session.get_cookie():
        raise HTTPException(400, "no trade session connected")
    s = get_settings()
    futs = orderbook.request_pairs(arbitrage.board_pairs(), priority=1, max_age_s=s["live_min_age_s"])
    waited = await orderbook.wait_for(futs, wait_s)
    return {**arbitrage.board(window_h), "refresh": {**waited, "queue": orderbook.state["queue"]}}


@app.get("/api/market/edges")
def market_edges():
    return arbitrage.edge_table()


@app.get("/api/market/top")
def market_top(hours: int = 24, limit: int = 40, by: str = "activity"):
    """Busiest markets. `by=activity` (default) ranks on how many hours the pair traded (raw turnover);
    `by=value` ranks on traded VALUE normalized to Exalted (volume × the exchange graph's ref-value),
    consistent with the rest of the app. Each row carries both raw volumes and `value_ex`."""
    league = get_settings()["league"]
    rows = digest.top_markets(league, hours, max(limit, 1000))   # value-sort needs the full field, not top-N-by-activity
    ref = arbitrage.cached_graph().ref_values()                  # {trade_id: value in Exalted}
    for r in rows:
        va = (r.get("volume_a") or 0) * (ref.get(r["a"]) or 0)
        vb = (r.get("volume_b") or 0) * (ref.get(r["b"]) or 0)   # same trade valued from the other side (fallback)
        r["value_ex"] = round(va or vb, 2) if (va or vb) else None
    if by == "value":
        rows.sort(key=lambda r: (r.get("value_ex") or 0), reverse=True)
    return rows[:limit]


@app.get("/api/market/history")
def market_history(a: str, b: str, hours: int = 168):
    league = get_settings()["league"]
    return {"digest": digest.pair_history(league, a, b, hours),
            "live": orderbook.pair_history(league, a, b, min(hours, 72))}


@app.post("/api/market/refresh")
def market_refresh():
    """Queue the whole watchlist at low priority (respects min_refetch_s)."""
    if not session.get_cookie():
        raise HTTPException(400, "no trade session connected")
    orderbook.request_refresh()
    return {"queued": orderbook.state["queue"]}


@app.get("/api/leagues")
async def leagues(force: bool = False):
    try:
        return await orderbook.leagues(force)
    except Exception as exc:
        raise HTTPException(502, f"could not load league list: {exc}")


@app.get("/api/ratelimits")
def rate_limits():
    from . import pairscore
    return {"policies": gateway.status(), "queue": orderbook.state, "pair_scores": pairscore.top(12)}


@app.post("/api/digest/sync")
async def digest_sync():
    await digest.sync_once()
    return digest.state


# ----------------------------------------------------------------- routes
@app.get("/api/routes")
def routes(
    min_margin_pct: float | None = None,
    min_margin_ref: float | None = None,
    max_gold: float | None = None,
    min_margin_per_1k_gold: float | None = None,
    min_liquidity_ref: float | None = None,
    live_only: bool | None = None,
    exclude_recipes: bool | None = None,
    min_volume_ref_per_h: float | None = None,
    max_fill_hours: float | None = None,
    min_velocity: float | None = None,
    sort: str | None = Query(None, pattern="^(score|velocity|margin_per_1k_gold|margin_ref|margin_pct|margin|value_ref|gold|liquidity_ref|volume_ref_per_h|fill_hours)$"),
    limit: int | None = None,
    start: str | None = None,
):
    f = {k: v for k, v in {
        "min_margin_pct": min_margin_pct, "min_margin_ref": min_margin_ref, "max_gold": max_gold,
        "min_margin_per_1k_gold": min_margin_per_1k_gold, "min_liquidity_ref": min_liquidity_ref,
        "live_only": live_only, "exclude_recipes": exclude_recipes, "sort": sort, "limit": limit,
        "min_volume_ref_per_h": min_volume_ref_per_h, "max_fill_hours": max_fill_hours, "min_velocity": min_velocity,
    }.items() if v is not None}
    starts = [s for s in start.split(",") if s] if start else None
    return arbitrage.find_routes(f, starts)


@app.get("/api/routes/stream")
def routes_stream(
    min_margin_pct: float | None = None,
    min_margin_ref: float | None = None,
    max_gold: float | None = None,
    min_margin_per_1k_gold: float | None = None,
    min_liquidity_ref: float | None = None,
    live_only: bool | None = None,
    exclude_recipes: bool | None = None,
    min_volume_ref_per_h: float | None = None,
    max_fill_hours: float | None = None,
    min_velocity: float | None = None,
    sort: str | None = Query(None, pattern="^(score|velocity|margin_per_1k_gold|margin_ref|margin_pct|margin|value_ref|gold|liquidity_ref|volume_ref_per_h|fill_hours)$"),
    limit: int | None = None,
    start: str | None = None,
):
    """SSE version of /api/routes: loops stream out as the search finds them.

    Events: `meta` (once), `routes` (batches of passing loops), `done` (final
    counts + authoritative score order). Runs in a worker thread; batches flush
    every 25 loops or 150 ms so the UI fills in continuously.
    """
    import json as _json

    from fastapi.responses import StreamingResponse

    f = {k: v for k, v in {
        "min_margin_pct": min_margin_pct, "min_margin_ref": min_margin_ref, "max_gold": max_gold,
        "min_margin_per_1k_gold": min_margin_per_1k_gold, "min_liquidity_ref": min_liquidity_ref,
        "live_only": live_only, "exclude_recipes": exclude_recipes, "sort": sort, "limit": limit,
        "min_volume_ref_per_h": min_volume_ref_per_h, "max_fill_hours": max_fill_hours, "min_velocity": min_velocity,
    }.items() if v is not None}
    starts = [s for s in start.split(",") if s] if start else None

    def gen():
        buf: list[dict] = []
        last = time.time()
        def flush():
            nonlocal buf, last
            if buf:
                out = f"event: routes\ndata: {_json.dumps(buf)}\n\n"
                buf = []
                last = time.time()
                return out
            return ""
        try:
            for kind, payload in arbitrage.stream_routes(f, starts):
                if kind == "route":
                    buf.append(payload)
                    if len(buf) >= 25 or time.time() - last > 0.15:
                        yield flush()
                else:
                    out = flush()
                    if out:
                        yield out
                    yield f"event: {kind}\ndata: {_json.dumps(payload)}\n\n"
        except Exception as exc:   # surface instead of a dead stream
            log.exception("route stream failed: %s", exc)
            yield f"event: error\ndata: {_json.dumps({'error': str(exc)})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _filters_from(body: dict) -> tuple[dict, list[str] | None]:
    f = {k: v for k, v in (body.get("filters") or {}).items() if v not in (None, "")}
    start = body.get("start")
    starts = [x for x in start.split(",") if x] if isinstance(start, str) and start else None
    return f, starts


class RefreshTopBody(BaseModel):
    filters: dict = {}
    start: str | None = None
    n: int | None = None
    wait_s: float = 45


@app.post("/api/routes/refresh-top")
async def routes_refresh_top(body: RefreshTopBody):
    """Live-refresh only the exchange pairs behind the top-N loops currently displayed.

    Pairs newer than live_min_age_s are skipped; the rest go into the queue at
    priority 1 and we wait (bounded) before recomputing.
    """
    if not session.get_cookie():
        raise HTTPException(400, "no trade session connected")
    s = get_settings()
    f, starts = _filters_from(body.dict())
    n = body.n if body.n is not None else s["live_top_n"]
    before = arbitrage.find_routes(f, starts)
    pairs = [tuple(p) for r in before["routes"][:max(0, n)] for p in r["pairs"]]
    futs = orderbook.request_pairs(pairs, priority=1, max_age_s=s["live_min_age_s"])
    waited = await orderbook.wait_for(futs, body.wait_s)
    after = arbitrage.find_routes(f, starts, use_cache=False) if waited["done"] else before
    return {**after, "refresh": {**waited, "pairs_considered": len(set(pairs)), "top_n": n,
                                 "queue": orderbook.state["queue"], "in_flight": orderbook.state["in_flight"]}}


class RefreshRouteBody(BaseModel):
    id: str
    pairs: list[list[str]] | None = None   # exchange pairs only (the UI sends route.pairs)
    filters: dict = {}
    start: str | None = None
    wait_s: float = 45


@app.post("/api/routes/refresh")
async def routes_refresh_one(body: RefreshRouteBody):
    """Force-refresh every exchange pair in one loop (top priority), then return it."""
    if not session.get_cookie():
        raise HTTPException(400, "no trade session connected")
    pairs = [tuple(p) for p in body.pairs] if body.pairs else arbitrage.route_pairs(body.id)
    futs = orderbook.request_pairs(pairs, priority=0, force=True)
    waited = await orderbook.wait_for(futs, body.wait_s)
    f, starts = _filters_from(body.dict())
    res = arbitrage.find_routes(f, starts, use_cache=False)
    route = next((r for r in res["routes"] if r["id"] == body.id), None)
    if route is None:  # it may no longer pass the filters; recompute unfiltered so the user sees why
        loose = arbitrage.find_routes({"min_margin_pct": -1e9, "min_margin_ref": -1e9, "limit": 100000}, starts, use_cache=False)
        route = next((r for r in loose["routes"] if r["id"] == body.id), None)
    return {"route": route, "routes": res["routes"], "refresh": {**waited, "pairs": len(pairs),
            "queue": orderbook.state["queue"]}, "still_passes": route is not None and any(r["id"] == body.id for r in res["routes"])}
