from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, model_validator

from fastapi.responses import RedirectResponse, PlainTextResponse

from . import analytics, arbitrage, db, diag, digest, gamedata, gateway, holdscore, inflation, leaguearc, leaguehistory, liquidity, migrations_user, movers, oauth, orderbook, recipes, session, sidecar_supervisor, signalsack, watchdog, workspace
from .config import INSTALL_LOG_PATH
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
    tasks = [asyncio.create_task(registry.keep_static_fresh()), asyncio.create_task(digest.run_forever()), asyncio.create_task(_gold_fee_loop()),
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
                    with db.tx() as c:
                        analytics.enqueue(c, "discords", {"league": league})
                        analytics.enqueue(c, "arc", {"league": league})
                await run_in_threadpool(_enqueue)
        except Exception as exc:
            log.warning("analytics enqueue error: %s", exc)
        await asyncio.sleep(7200)       # every 2h (daily data — no need to churn)


app = FastAPI(title="PoE2 currency arbitrage", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ------------------------------------------------------------------ status
DIGEST_STALE_S = 2 * 3600      # hourly digest older than this → "stale" (also the backfilling bar)
ORDERBOOK_STALE_S = 3600       # no live book fetched for an hour → "stale"


@app.get("/api/status")
def status():
    s = get_settings()
    now = time.time()
    d = dict(digest.state)
    behind = max(0.0, now - (d["last_hour"] + 3600)) if d.get("last_hour") else None
    d["behind_h"] = round(behind / 3600, 1) if behind is not None else None
    d["backfilling"] = behind is not None and behind > 2 * 3600
    # Feed freshness as a STATE the UI renders verbatim (one owner for the thresholds).
    d["state"] = ("waiting" if not d.get("last_fetch")
                  else "stale" if now - d["last_fetch"] > DIGEST_STALE_S else "ok")
    ob = dict(orderbook.state)
    ob["feed"] = ("idle" if not ob.get("last_fetch")
                  else "stale" if now - ob["last_fetch"] > ORDERBOOK_STALE_S else "ok")
    return {
        "time": now,
        "league": s["league"],
        "reference": s["reference"],
        "digest": d,
        "orderbook": ob,
        "rate_limits": gateway.status(),
        "session": session.status(),
        "oauth": oauth.status(),
        "registry_loaded_at": registry.loaded_at,
        "unmapped_metadata_ids": len(registry.unmapped_meta),
        "gold_fees": gamedata.state,
        "wealth_prices": _wealth_prices(),   # reference per unit of chaos/divine/mirror (UI wealth rule)
    }


def _wealth_prices() -> dict:
    try:
        return arbitrage.anchor_prices()
    except Exception as exc:      # a cold/empty graph must never fail the status poll
        log.warning("wealth prices unavailable: %s", exc)
        return {get_settings()["reference"]: 1.0}


# ------------------------------------------------------ installer telemetry
# The Windows NSIS installer POSTs a diagnostic report here (process list, env,
# existing-install listing) on every attempt, so we can see WHY it fails on a PC
# we can't touch. Appended to DATA_DIR/install-reports.log; readable back for triage.
_INSTALL_LOG = INSTALL_LOG_PATH


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
async def diag_ep():
    """Local self-diagnostics (Settings → Diagnostics). No data leaves the machine."""
    return await diag.collect()


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
    """Holdings at paper value AND at what they would realize (Ghost Wealth) — see liquidity."""
    g = arbitrage.cached_graph()
    return liquidity.capital_rows(db.get_capital(), g, g.ref_values())


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
    """Gone. The flat `watches` shape was migrated into the workspace tree (migration #2) and
    nothing reads the old key; a lagging client's save must fail LOUDLY rather than either
    diverge into a blob nobody shows or overwrite the richer tree with its flat copy."""
    raise HTTPException(410, "saved searches moved to /api/trading/workspace")


# Filesystem workspace (nested tree) — the successor to the flat watches organiser, stored under
# the user-kv key `trading_workspace` (migration #2 derived it from `watches`, which stays as a
# read-only backup behind GET /api/watches).
def _empty_workspace() -> dict:
    return {"version": 2, "tree": [], "layout": None, "openTabs": []}


class WorkspaceBody(BaseModel):
    workspace: dict


@app.get("/api/trading/workspace")
def get_workspace():
    ws = db.kv_get("trading_workspace")
    return {"workspace": ws if isinstance(ws, dict) and ws.get("version") == 2 else _empty_workspace()}


@app.put("/api/trading/workspace")
def put_workspace(body: WorkspaceBody):
    ws = body.workspace
    err = workspace.validate_workspace(ws)   # validates, never truncates (backend/app/workspace.py)
    if err:
        raise HTTPException(status_code=err.status, detail=err.detail)
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
async def hold(window_h: int | None = None, horizon: str | None = None, category: str = "all",
               numeraire: str = "divine"):
    """Store-of-value leaderboard over the app-wide window (`window_h`, clamped to 7d — hold
    scores are tuned to a week; `horizon=1d|3d|7d` is the legacy spelling). Served from the
    stored full-currency backfill; kicks the background crawl if nothing's stored yet."""
    hz = holdscore.horizon_for(window_h, horizon)
    res = await run_in_threadpool(holdscore.leaderboard, hz, category, numeraire)
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
    return await run_in_threadpool(signalsack.read)


class SignalAck(BaseModel):
    keys: list[str] | None = None   # sig_keys ("item_id:t") to dismiss
    all: bool = False               # dismiss every currently-fired signal


@app.post("/api/signals/ack")
async def signals_ack_ep(body: SignalAck):
    """Dismiss signals (user data → signals_ack in user.sqlite). `keys` dismisses those signal ids;
    `all: true` dismisses everything currently fired. Returns the new unseen count."""
    return await run_in_threadpool(signalsack.ack, body.keys, body.all, int(time.time()))


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
    consistent with the rest of the app. Each row carries both raw volumes and the traded value."""
    return digest.top_markets_valued(get_settings()["league"], hours, limit, by,
                                     arbitrage.cached_graph().ref_values())


@app.get("/api/market/history")
def market_history(a: str, b: str, hours: int = 168):
    league = get_settings()["league"]
    return {"digest": digest.pair_history(league, a, b, hours),
            "live": orderbook.pair_history(league, a, b, min(hours, 72))}


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


class RateAcquire(BaseModel):
    policy: str


class RateObserve(BaseModel):
    policy: str
    status: int
    headers: dict[str, str] = {}


def _policy_or_404(name: str) -> gateway.Policy:
    p = gateway.POLICIES.get(name)
    if p is None:
        raise HTTPException(404, f"unknown rate policy {name!r}")
    return p


@app.post("/api/ratelimits/acquire")
def rate_acquire(body: RateAcquire):
    """Reserve one slot of a pathofexile.com budget for the desktop live-search engine (the backend
    is the single owner of the budget both processes share). Non-blocking: {ok} or {ok:false,
    retry_after_s} — the caller fails fast instead of the request thread sleeping."""
    wait = _policy_or_404(body.policy).try_acquire_now()
    return {"ok": True} if wait <= 0 else {"ok": False, "retry_after_s": round(wait, 1)}


@app.post("/api/ratelimits/observe")
def rate_observe(body: RateObserve):
    """Feed the X-Rate-Limit-* headers (and 429s) the engine saw into the shared budget."""
    _policy_or_404(body.policy).observe_headers(body.status, body.headers)
    return {"ok": True}


@app.post("/api/ratelimits/hint")
def rate_hint(body: RateAcquire):
    """An out-of-band request on the same budget (an ExiledExchange2 price check, reported by the
    desktop shell) — fold it in as a used slot so armed live searches don't walk into a penalty."""
    _policy_or_404(body.policy).hint()
    return {"ok": True}


# ------------------------------------------------------------------ sales ledger
# Trading → Sales (roadmap batch 6): the desktop shell fetches the trade site's Merchant History through
# the user's own session + the shared rate budget and hands the rows here; the backend is the ledger's
# only writer (user.sqlite `sales`, migration 5, kept forever). Nothing here talks to pathofexile.com.
class SalesIngest(BaseModel):
    league: str
    result: list[dict]


@app.post("/api/sales/ingest")
def sales_ingest(body: SalesIngest):
    league = body.league.strip()
    if not league:
        raise HTTPException(400, "league required")
    new_rows = db.sales_upsert(league, body.result)
    # A sale just paid out: credit its price to the holdings (NEW rows only, so a re-fetch never
    # double-counts). The trade site never reports refunds, so nothing is ever debited here.
    credited = 0
    for r in new_rows:
        price = r.get("price") or {}
        if price.get("currency") and price.get("amount"):
            db.capital_add(str(price["currency"]), float(price["amount"]))
            credited += 1
    if credited:
        arbitrage.invalidate_caches()   # routes are sized from capital
    return {"ok": True, "new": len(new_rows), "total": db.sales_count(league), "credited": credited}


@app.get("/api/sales")
def sales(league: str | None = None):
    rows = db.sales_list(league or None)
    # Reference price for every currency a sale was paid in (through that currency's own market
    # against the reference), so the client's total counts regal/vaal/annul sales, not just the
    # four wealth anchors.
    prices: dict[str, float] = {}
    try:
        g = arbitrage.cached_graph()
        ref = g.s["reference"]
        rv = g.ref_values()
        for r in rows:
            cur = str((r.get("price") or {}).get("currency") or "")
            if cur and cur not in prices:
                px = 1.0 if cur == ref else g.price_in(cur, ref, rv)
                if px:
                    prices[cur] = px
    except Exception:
        log.exception("sales prices")
    return {"league": league, "rows": rows, "leagues": db.sales_leagues(), "prices": prices}


@app.post("/api/digest/sync")
async def digest_sync():
    await digest.sync_once()
    return digest.state


# ----------------------------------------------------------------- routes
SORT_KEYS = "^(score|velocity|margin_per_1k_gold|margin_ref|margin_pct|margin|value_ref|gold|liquidity_ref|volume_ref_per_h|fill_hours)$"


class RouteQuery(BaseModel):
    """The route-search filters, declared ONCE: the GET query string (via Depends) and the
    `filters` of the refresh POST bodies both use it. Field names are the wire contract with
    frontend api.js (`qs(f)`). Unset fields fall back to the saved default filters."""
    min_margin_pct: float | None = None
    min_margin_ref: float | None = None
    max_gold: float | None = None
    min_margin_per_1k_gold: float | None = None
    min_liquidity_ref: float | None = None
    live_only: bool | None = None
    exclude_recipes: bool | None = None
    min_volume_ref_per_h: float | None = None
    max_fill_hours: float | None = None
    max_step_minutes: float | None = None
    min_velocity: float | None = None
    sort: str | None = Field(None, pattern=SORT_KEYS)
    limit: int | None = None
    start: str | None = None      # comma-separated start currencies; omitted = all held

    @model_validator(mode="before")
    @classmethod
    def _blank_is_unset(cls, data):
        """An empty filter box arrives as '' — that is "unset", not an unparseable number."""
        return {k: v for k, v in data.items() if v != ""} if isinstance(data, dict) else data

    def to_filters(self) -> dict:
        return {k: v for k, v in self.model_dump(exclude={"start"}).items() if v not in (None, "")}

    def starts(self) -> list[str] | None:
        return [x for x in self.start.split(",") if x] if self.start else None


@app.get("/api/routes/stream")
def routes_stream(q: RouteQuery = Depends()):
    """SSE version of /api/routes: loops stream out as the search finds them.

    Events: `meta` (once), `routes` (batches of passing loops), `done` (final
    counts + authoritative score order). Runs in a worker thread; batches flush
    every 25 loops or 150 ms so the UI fills in continuously.
    """
    import json as _json

    from fastapi.responses import StreamingResponse

    f, starts = q.to_filters(), q.starts()

    weights = get_settings().get("rank_weights", {})

    def gen():
        buf: list[dict] = []
        seen: list[dict] = []
        last = time.time()

        def flush():
            """Emit the pending batch, then PROVISIONAL scores for everything streamed so far — the
            same rank-normalised blend `done` finalises — so the order the user watches fill in is
            the order they end up with (the client never re-implements the ranking)."""
            nonlocal buf, last
            if not buf:
                return ""
            out = f"event: routes\ndata: {_json.dumps(buf)}\n\n"
            seen.extend(buf)
            buf = []
            last = time.time()
            scored = [dict(r) for r in seen]
            arbitrage._composite_score(scored, weights)
            out += f"event: scores\ndata: {_json.dumps({r['id']: r['score'] for r in scored})}\n\n"
            return out
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


class RefreshTopBody(BaseModel):
    filters: RouteQuery = RouteQuery()
    start: str | None = None
    n: int | None = None
    wait_s: float = 45

    def query(self) -> RouteQuery:
        return self.filters.model_copy(update={"start": self.start})


@app.post("/api/routes/refresh-top")
async def routes_refresh_top(body: RefreshTopBody):
    """Live-refresh only the exchange pairs behind the top-N loops currently displayed.

    Pairs newer than live_min_age_s are skipped; the rest go into the queue at
    priority 1 and we wait (bounded) before recomputing.
    """
    if not session.get_cookie():
        raise HTTPException(400, "no trade session connected")
    s = get_settings()
    q = body.query()
    f, starts = q.to_filters(), q.starts()
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
    filters: RouteQuery = RouteQuery()
    start: str | None = None
    wait_s: float = 45

    def query(self) -> RouteQuery:
        return self.filters.model_copy(update={"start": self.start})


@app.post("/api/routes/refresh")
async def routes_refresh_one(body: RefreshRouteBody):
    """Force-refresh every exchange pair in one loop (top priority), then return it."""
    if not session.get_cookie():
        raise HTTPException(400, "no trade session connected")
    pairs = [tuple(p) for p in body.pairs] if body.pairs else arbitrage.route_pairs(body.id)
    futs = orderbook.request_pairs(pairs, priority=0, force=True)
    waited = await orderbook.wait_for(futs, body.wait_s)
    q = body.query()
    f, starts = q.to_filters(), q.starts()
    res = arbitrage.find_routes(f, starts, use_cache=False)
    route = next((r for r in res["routes"] if r["id"] == body.id), None)
    if route is None:  # it may no longer pass the filters; recompute unfiltered so the user sees why
        loose = arbitrage.find_routes({"min_margin_pct": -1e9, "min_margin_ref": -1e9, "limit": 100000}, starts, use_cache=False)
        route = next((r for r in loose["routes"] if r["id"] == body.id), None)
    return {"route": route, "routes": res["routes"], "refresh": {**waited, "pairs": len(pairs),
            "queue": orderbook.state["queue"]}, "still_passes": route is not None and any(r["id"] == body.id for r in res["routes"])}
