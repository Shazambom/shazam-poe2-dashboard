from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from urllib.parse import urlsplit
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, model_validator

from fastapi.responses import RedirectResponse, PlainTextResponse

from . import analytics, arbitrage, db, devtelemetry, diag, digest, gamedata, gateway, holdscore, inflation, leaguearc, leaguehistory, liquidity, migrations_user, modpool, movers, oauth, orderbook, recipes, seedready, session, sidecar_supervisor, signalsack, stratcalc, watchdog, workspace
from .config import INSTALL_LOG_PATH
from .currencies import registry
from .settings import ARBITRAGE_PRESETS, get_settings, save_settings

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
    if seed_poll_enabled():
        tasks.append(asyncio.create_task(_seed_poll_loop()))
    if not session.get_cookie():
        log.info("no trade session yet: connect one in Settings to enable the live order book")
    try:   # beta telemetry: what the seed left us for the Mods tab
        from . import devtelemetry
        snap, n_pools = db._read_snapshot_version(db.MARKET_DB_PATH), len(modpool.pools())
        devtelemetry.tlog("mods", f"snapshot v{snap} pools={n_pools} currencies={len(modpool.currencies())} meta={db.kv_get('mods_meta', {}).get('pools')}")
        if db.MARKET_SEED_PATH and n_pools == 0:
            devtelemetry.t0("mods-empty", f"seed bundled, snapshot v{snap}, pools=0")
    except Exception as exc:
        log.warning("mods telemetry failed: %s", exc)
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


CRAWL_RETRY_S = 120   # the seed poll holds the crawl lock for minutes at most
CRAWL_FAILED_RETRY_S = 30 * 60   # poe2scout unreachable: try again soon, never hammer it (owner)


async def _league_history_loop():
    while True:
        res = {}
        try:
            res = await leaguehistory.backfill()
        except Exception as exc:
            log.exception("league history backfill error: %s", exc)
            res = {"error": str(exc)}
        # A crawl that found the lock held (the seed poll, or a UI-kicked crawl) retries shortly, and
        # one that failed (offline at launch, poe2scout down: /Leagues or every item fetch) in half an
        # hour, instead of losing its turn for 12 hours.
        res = res or {}
        failed = bool(res.get("error")) or (res.get("attempted", 0) > 0 and res.get("errors") == res.get("attempted"))
        await asyncio.sleep(CRAWL_RETRY_S if res.get("skipped") else CRAWL_FAILED_RETRY_S if failed else 12 * 3600)


SEED_POLL_S = 3600   # hourly: slow on purpose, poe2scout is a free community site
SEED_POLL_AT_S = 5 * 60   # :05, so the answer is fresh when the seed publisher runs at :17 (root's cron)


def seed_poll_enabled() -> bool:
    """Only the server that publishes the market seed sets ARBITER_SEED_POLL (docker-compose.yml);
    a desktop app never does, so it makes no calls beyond its own crawl."""
    return os.environ.get("ARBITER_SEED_POLL") == "1"


def seconds_to_next_poll(now: float) -> float:
    """Until the next :05. Sleeping an hour after each poll drifted a minute an hour past the publisher."""
    return (SEED_POLL_AT_S - now) % SEED_POLL_S or SEED_POLL_S


async def _seed_poll_loop():
    """Verify each current league's newest day item by item and fetch only what holds it back, so the
    seed exporter can ship every day that is final and nothing that is not (app/seedready.py)."""
    while True:
        try:
            await seedready.poll()
        except Exception as exc:
            log.exception("seed poll error: %s", exc)
        await asyncio.sleep(seconds_to_next_poll(time.time()))


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
# No CORS: every client reaches /api through a same-origin proxy (Electron UI server, nginx, vite), so
# no other website may call the loopback backend (audit 2026-09-29, D2; tests/test_no_cross_origin.py).
_LOOPBACK = {"127.0.0.1", "localhost", "[::1]"}


def _hostname(netloc: str) -> str:
    v = (netloc or "").strip().lower()
    return v[: v.find("]") + 1] if v.startswith("[") else v.split(":", 1)[0]


@app.middleware("http")
async def loopback_only(request: Request, call_next):
    """The desktop backend (`run_desktop.py` sets ARBITER_LOOPBACK_ONLY) answers only its own app. Without
    CORS a page can still fire a simple POST (`mode: 'no-cors'`), and a DNS-rebinding page can read
    GETs, so refuse a non-loopback Host and any Origin that is not the loopback UI server (Electron's
    main process sends none). The web env sits behind nginx and does not set the flag."""
    if os.environ.get("ARBITER_LOOPBACK_ONLY") == "1":
        origin = request.headers.get("origin")
        if _hostname(request.headers.get("host", "")) not in _LOOPBACK or (
                origin is not None and _hostname(urlsplit(origin).netloc) not in _LOOPBACK):
            return PlainTextResponse("forbidden", status_code=403)
    return await call_next(request)


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
        "mod_pools": modpool.state,
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


# The crawl ticks on every fetch; poe2scout's 20/min budget can hold a fetch for most of a minute.
STALL_S = 120


@app.get("/api/backfill")
def backfill_status():
    """Live cold-start progress so the UI can stream 'building your dashboard…' instead
    of showing a blank/stale board on a fresh (self-contained) install."""
    p = dict(leaguehistory.progress)
    # A crawl that hasn't ticked in a while (rare mid-crawl error) is not 'running'.
    if p.get("running") and p.get("updated") and time.time() - p["updated"] > STALL_S:
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
# Beta telemetry for the startup `syncing` state (no markets yet after an update): one line when a
# client starts waiting, one when markets arrive, with the seconds in between. Counts only.
_capital_sync: dict = {"since": None}


def _note_capital_sync(payload: dict) -> None:
    n = len(payload.get("rows") or [])
    if payload.get("syncing"):
        if _capital_sync["since"] is None:
            _capital_sync["since"] = time.time()
            devtelemetry.tlog("capital", f"syncing: no markets yet (rows={n})")
    elif _capital_sync["since"] is not None:
        devtelemetry.tlog("capital", f"markets after {time.time() - _capital_sync['since']:.1f}s (rows={n})")
        _capital_sync["since"] = None


@app.get("/api/capital")
def capital():
    """Holdings at paper value AND at what they would realize (Ghost Wealth) — see liquidity."""
    g = arbitrage.cached_graph()
    rv = g.values()
    out = liquidity.capital_rows(db.get_capital(), g, rv)
    out["group_icons"] = liquidity.group_icons(g, rv, registry.groups())
    _note_capital_sync(out)
    return out


class CapitalBody(BaseModel):
    entries: dict[str, float]
    counted: list[str] = []   # the currencies whose total the user typed (a recount; db.set_capital)


@app.put("/api/capital")
def put_capital(body: CapitalBody):
    db.set_capital(body.entries, body.counted)
    arbitrage.invalidate_caches()   # routes are sized from capital, so drop the route cache
    return capital()


# --------------------------------------------------------------- settings
@app.get("/api/settings")
def settings():
    return get_settings()


@app.get("/api/arbitrage/presets")
def arbitrage_presets():
    """The Arbitrage page's presets (settings.ARBITRAGE_PRESETS, the one definition): the page writes a picked
    preset's values through PUT /api/settings and shows a preset as picked while the saved values equal it."""
    return ARBITRAGE_PRESETS


class SettingsPatch(BaseModel):
    patch: dict


# Settings the market graph never reads: route results are keyed on the Stash switches and Capital is
# not cached, so flipping one rebuilds nothing.
SETTINGS_OUTSIDE_THE_GRAPH = frozenset({"stash_counted"})


@app.put("/api/settings")
def put_settings(body: SettingsPatch):
    saved = save_settings(body.patch)
    if set(body.patch) - SETTINGS_OUTSIDE_THE_GRAPH:
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


# -------------------------------------------------------------- mod pools (Trading → Mods)
# Reads only: the tables ride the market seed and are rebuilt on shazam (app/modpool.py).
@app.get("/api/mods/pools")
def mod_pools():
    return {"pools": modpool.pools(), "currencies": modpool.currencies()}


@app.get("/api/mods/pool/{pool_id}")
def mod_pool(pool_id: str):
    p = modpool.pool(pool_id)
    if p is None:
        raise HTTPException(status_code=404, detail="no such pool")
    return p


@app.get("/api/mods/pool/{pool_id}/prices")
def mod_pool_prices(pool_id: str):
    p = modpool.prices(pool_id)
    if p is None:
        raise HTTPException(status_code=404, detail="no such pool")
    return p


@app.post("/api/mods/refresh")
async def mod_pools_refresh():
    """A dev convenience: rebuild the tables from the sources. Shazam builds them with
    `python -m app.modpool --force` (ops/publish-market-snapshot.sh). A backend with a seed bundled
    is a desktop install: it reads the tables its seed carries and never scrapes or rebuilds them."""
    if db.MARKET_SEED_PATH:
        devtelemetry.tlog("mods", "refresh refused: this install reads its tables from the seed")
        raise HTTPException(status_code=403, detail="desktop installs read their mod tables from the seed")
    return await modpool.refresh(force=True)


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


# Strategy → Strat Calculator (backend/app/stratcalc.py): the saved strats (user kv `strat_calc`) and
# divines per unit of every currency, off the one value table (Graph.values). The math and the
# wall-clock timers are the view's (frontend/src/lib/stratcalc.js).
def _strat_prices() -> dict:
    try:
        g = arbitrage.cached_graph()
        return stratcalc.divine_prices(g.values(), g.s["reference"])
    except Exception as exc:      # a cold graph must not hide the saved strats
        log.warning("strat calc prices unavailable: %s", exc)
        return {}


class StratCalcBody(BaseModel):
    calc: dict


@app.get("/api/strategy/calc")
def get_strat_calc(prices: int = 0):
    # ?prices=1: the view's minute poll, which needs only the prices (the strats are read once)
    # `uses`: the tablets' full uses (kv_ops tablet_uses, from the pipeline via the seed)
    if prices:
        return {"prices": _strat_prices()}
    return {"calc": db.kv_get(stratcalc.KEY), "prices": _strat_prices(), "uses": db.kv_get(modpool.TABLET_USES, []) or []}


@app.put("/api/strategy/calc")
def put_strat_calc(body: StratCalcBody):
    err = stratcalc.validate(body.calc)
    if err:
        raise HTTPException(422, err)
    db.kv_set(stratcalc.KEY, body.calc)
    return {"calc": body.calc}


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


_backfill_asked: dict[str, float] = {}      # league -> when we last kicked a full crawl for it
BACKFILL_RETRY_S = 1800


def _ask_backfill(league: str | None) -> bool:
    """Kick a full poe2scout crawl for an empty board, at most every BACKFILL_RETRY_S per league.
    A league the site has no data for returns nothing however often we crawl, and the Board polls
    this endpoint every 30s — without the cooldown that is a permanent crawl loop."""
    now = time.time()
    if now - _backfill_asked.get(league or "", 0.0) < BACKFILL_RETRY_S:
        return False
    _backfill_asked[league or ""] = now
    return True


@app.get("/api/hold")
async def hold(window_h: int | None = None, horizon: str | None = None, category: str = "all",
               numeraire: str = "divine", k: float | None = None):
    """Store-of-value leaderboard for the app-wide window (`window_h`), which on Hold is how long the
    player plans to hold: the ranking is for that holding period (`horizon=1d|3d|7d|14d` is the
    legacy spelling). Served from the
    stored full-currency backfill; kicks the background crawl if nothing's stored yet."""
    hz = holdscore.horizon_for(window_h, horizon)
    # `k` = the Hold page's CAUTION slider (0 = return alone, higher = favour the steadier
    # asset); omitted it falls back to the `hold_caution` setting.
    res = await run_in_threadpool(holdscore.leaderboard, hz, category, numeraire, k)
    # No rows AND no category scored: nothing is stored, crawl. A category with nothing eligible
    # today is an empty page, not a missing backfill.
    if not res["assets"] and len(res.get("categories") or []) <= 1:
        building = _ask_backfill(get_settings()["league"])
        if building:
            _spawn(leaguehistory.backfill(full=True))
        return {**res, "building": building}
    return res


@app.get("/api/movers")
async def movers_ep(window_h: int = 24, n: int = 3, dir: str = "both"):
    """Biggest movers across the full poe2scout universe, by % change over the window, in the
    league base. dir='both' ranks by |change| (gainers AND crashers); 'up'/'down' keep only
    that direction. Distinct from /api/hold's store-of-value ranking."""
    return await run_in_threadpool(movers.top_movers, window_h, n, movers.MIN_VALUE_EX, dir)


@app.get("/api/asset")
async def asset_ep(q: str, window_h: int = 24, num: str | None = None):
    """One asset's price/volume/trend detail for the Board's expand modal (any pulse-strip
    item, not just watchlist currencies). `q` is a currency name or slug; `num` the numeraire
    the modal shows it in (the series is expressed in it)."""
    res = await run_in_threadpool(movers.asset_row, q, window_h, num)
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
        building = _ask_backfill("__marketcap__")
        if building:
            _spawn(leaguehistory.backfill(full=True))
        return {**res, "building": building}
    return res


def _parse_nums(nums: str | None) -> dict[str, str]:
    """`nums=omen-of-light:exalted,divine:chaos` → the client's per-card "priced in" picks."""
    out = {}
    for part in (nums or "").split(","):
        c, _, n = part.partition(":")
        if c and n:
            out[c.strip()] = n.strip()
    return out


@app.get("/api/board")
def board(window_h: int = 24, nums: str | None = None):
    return arbitrage.board(window_h, _parse_nums(nums))


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
                                     arbitrage.cached_graph().values())


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
    spare: float = 0.0   # a low-priority request: only with this share of every window free (gateway.Policy.headroom)


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
    wait = _policy_or_404(body.policy).try_acquire_now(max(0.0, min(1.0, body.spare)))
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
    server_time: str | None = None   # the trade site's clock when it answered (its Date header)


@app.post("/api/sales/ingest")
def sales_ingest(body: SalesIngest):
    league = body.league.strip()
    if not league:
        raise HTTPException(400, "league required")
    # A sale paid out: credit its price to the holdings — NEW rows only (a re-fetch never double-counts),
    # and only one the typed amount can't already count (db.sales_ingest). The trade site never reports
    # refunds, so nothing is ever debited here.
    new_rows, credited, added = db.sales_ingest(league, body.result, skew_s=_clock_skew(body.server_time))
    if added:
        arbitrage.invalidate_caches()   # routes are sized from capital
    return {"ok": True, "new": len(new_rows), "total": db.sales_count(league), "credited": len(credited), "added": added}


def _clock_skew(server_time: str | None) -> float:
    """The trade site's clock minus this PC's, in seconds (0 when unknown)."""
    try:
        site = datetime.fromisoformat(str(server_time).replace("Z", "+00:00"))
        return (site - datetime.now(timezone.utc)).total_seconds() if site.tzinfo else 0.0
    except (TypeError, ValueError):
        return 0.0


@app.get("/api/sales")
def sales(league: str | None = None):
    rows = db.sales_list(league or None)
    # Reference price for every currency a sale was paid in (the one value table, Graph.values),
    # so the client's total counts regal/vaal/annul sales, not just the four wealth anchors.
    prices: dict[str, float] = {}
    try:
        g = arbitrage.cached_graph()
        ref = g.s["reference"]
        V = g.values()
        for r in rows:
            cur = str((r.get("price") or {}).get("currency") or "")
            if cur and cur not in prices:
                px = 1.0 if cur == ref else V.get(cur)
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
def routes_stream(request: Request, q: RouteQuery = Depends()):
    """SSE version of /api/routes: loops stream out as the search finds them.

    Events: `meta` (once), `routes` (batches of passing loops), `done` (final
    counts + authoritative score order). Runs in a worker thread; batches flush
    every 25 loops or 150 ms so the UI fills in continuously. When the page closes the stream (every
    Arbitrage edit starts a new search) the search is told to stop instead of running to the end.
    """
    import json as _json

    from fastapi.responses import StreamingResponse

    f, starts = q.to_filters(), q.starts()
    stop = threading.Event()

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
            for kind, payload in arbitrage.stream_routes(f, starts, cancelled=stop.is_set):
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

    async def until_gone():
        """Each chunk is computed in a worker thread; between chunks, a closed page stops the search. On any
        exit (the client gone, the response task cancelled) the search is told to stop."""
        it = gen()
        try:
            while not await request.is_disconnected():
                chunk = await run_in_threadpool(next, it, None)
                if chunk is None:
                    return
                yield chunk
        finally:
            stop.set()

    return StreamingResponse(until_gone(), media_type="text/event-stream",
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
