# Audit 2026-09-29 — open items that reproduced

**Status:** mostly FIXED 2026-09-29, uncommitted and unshipped (see each item) · **Found:** 2026-09-29 (whole-codebase audit) · Every item below was reproduced
against the code, a read-only copy of the owner's local DB, or the real GitHub release feed. Claims
that did not survive checking are listed at the end so nobody re-reports them.

Repro scripts ran from a scratch dir with the test venv:
`cd backend && DATA_DIR=<copy of the app data dir> MARKET_SEED= ../.venv-test/bin/python <script>`.
The DB copy was made with `sqlite3 "file:…/market.sqlite?mode=ro" ".backup <copy>"`.

## Stability

### S1. A failed league-history crawl waits the full 12 hours
**FIXED:** retries in 30 min (owner: about that, never more often); `tests/test_seed_poll_loop.py`. Code review: also when /Leagues answered but every item fetch failed (`backfill` now returns `attempted`/`errors`).
`main._league_history_loop` retries soon only on `{"skipped": …}`; `leaguehistory.backfill()` returns
`{"error": …}` when `/Leagues` fails (`leaguehistory.py:335`), so the loop sleeps `12 * 3600`.
On macOS `asyncio.sleep` runs on `time.monotonic`, which pauses while the laptop sleeps, so it is 12
hours of awake time. An app started before the network is up keeps stale current-league daily data
for that long.
- Repro: stub `leaguehistory.backfill` to return `{"error": "x"}`, stub `asyncio.sleep` to record →
  `[43200]`.
- Fix: back off on error (e.g. 5 min doubling to 2 h), same as the `skipped` path.

### S2. A sidecar that dies at start is respawned every second, forever
**FIXED:** backoff resets only after a 60 s run; `tests/test_sidecar_supervisor.py`.
`sidecar_supervisor._supervise` resets `backoff = 1.0` right after `Popen` succeeds, so the doubling
is undone on every start. Each respawn is a PyInstaller unpack plus a numpy import (one CPU core),
and on beta one `_tlog` post per second.
- Repro: stub `Popen` with a child that exits at once, record `time.sleep` → `[1.0, 1.0, 1.0, 1.0, 1.0]`.
- Fix: reset the backoff only after the child has run for 60 s or more.

### S3. A backend crash leaves the app dead until relaunch
**FIXED:** `desktop/src/respawn.js` (1 s doubling to 60 s; cancelled on quit); `desktop/test/respawn.test.mjs`. Driven: a SIGKILLed backend answered again in 9 s; quitting started no new one. Code review: a spawn that fails (ENOENT emits no 'exit') or throws is retried too (`onceGone`).
`desktop/src/main.js` backend `exit` handler logs and sets `backendProc = null`; nothing respawns it.
Every `/api` call then returns the proxy's 502.
- Fix: respawn on an unrequested exit with backoff; show an error after N failures.

### S4. Startup waits on a live pathofexile.com fetch
`main.lifespan` awaits `registry.load_static()` before the server accepts connections; that is
`gateway.request(..., policy="trade")` with `retries=2`, and a 429 makes `Policy.acquire` wait out
`retry-after + 1` before each retry. A user already rate-limited at launch waits up to twice the
retry-after before the UI gets any data (Electron gives up waiting after about 2 minutes).
- Fix: apply `trade_static_cache` first and do the live fetch in the background
  (`keep_static_fresh` already exists), or boot with `retries=0`.

### S5. Update failures are shown as "up to date"
**DROPPED** (owner: nothing useful a user can do; Windows retries every 30 min).
`main.js` updater `error` handler treats any message matching
`/No published versions|404|Cannot find (channel|latest)|ENOTFOUND|net::/` as `{phase: 'none'}`. That
was meant for an empty beta channel, but it also swallows an asset 404 or a network error during
download.
- Fix: treat only "no latest/beta yml at check time" as benign; surface the rest.

### S6. A sale and its capital credit are separate transactions (low)
`POST /api/sales/ingest` commits `db.sales_upsert`, then calls `db.capital_add` per row. A kill in
between stores the sale without the credit, and the next ingest treats it as not new.
The window is milliseconds.
- Fix: one `db.tx()` for the upsert and the credits.

## Desktop / security

### D1. Turning on "Beta updates" from a stable build installs an older beta
**FIXED:** `desktop/src/updater-channel.js` sets `allowDowngrade = false`; `desktop/test/updater-channel.test.mjs`.
electron-updater's `channel` setter sets `allowDowngrade = true`
(`node_modules/electron-updater/out/AppUpdater.js:44`); `_applyChannel` never resets it. On the beta
channel the GitHub provider skips non-semver tags (`desktop-v0.3.6`, `market-seed-latest`) and picks
the first semver tag in the feed.
- Repro (real feed, 2026-09-29): feed order `0.3.6-beta.12, 0.3.6-beta.11, desktop-v0.3.6, …`; the
  beta channel picks `0.3.6-beta.12`, which is older than the running 0.3.6 → offered, and downloaded
  automatically on Windows.
- Fix: `au.allowDowngrade = false` after setting the channel.

### D2. The local backend accepts cross-origin writes from any website
**FIXED:** CORS middleware removed; `tests/test_no_cross_origin.py`. Driven: a foreign-origin preflight gets 405, no allow header. Code review: without CORS a `no-cors` simple POST still ran and a DNS-rebinding page could read GETs, so the desktop backend (`run_desktop.py` sets ARBITER_LOOPBACK_ONLY) refuses a non-loopback Host or a foreign Origin (403). Driven: the app's pages, route stream and Node fetch pass; a foreign POST to /api/oauth/logout and a rebinding Host get 403.
`backend/app/main.py:144` `CORSMiddleware(allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])`
on a fixed port (8210). The renderer never needs CORS: it goes through the same-origin UI proxy.
- Repro: `TestClient(main.app).options("/api/settings", headers={Origin: https://evil.example,
  Access-Control-Request-Method: PUT, …})` → `access-control-allow-origin: *`.
- Impact: a page built to target this app can overwrite settings, watches or capital, or disconnect
  the session, while the app runs (browser-dependent; recent Chrome prompts for local-network
  access). It cannot read the session cookie: `GET /api/session` returns only status fields.
- Fix: drop the CORS middleware from the desktop build (keep it for the web env if it needs it).

### D3. `shell.openExternal` opens any URL scheme (hardening)
`main.js` webview/login/main-window handlers call `shell.openExternal(url)` for every non-auth URL
with no scheme check. Exploiting it needs pathofexile.com to pass a non-web link, which is unlikely.
- Fix: allow only `https:`/`http:`.

### D4. The Windows installer posts diagnostics on every build (cleanup)
**FIXED:** removed (owner: "just remove dead code"); the installer posts nowhere and keeps its self-heal; `desktop/test/installer-telemetry.test.mjs`.
`desktop/build/installer.nsh` `customInit` POSTs OS version, username and matching process paths to
the LAN telemetry address on every install, stable included. It is ungated, unlike every other
sender (`diagTelemetryOn()`). Off the owner's LAN it goes nowhere or to whatever device holds that
address, and can add up to 8 s to an install. Owner: telemetry only on beta; a separate cleanup.

## Accuracy

### A1. Native prices read a dead market's worst-case rate
**FIXED:** `Graph.traded_rate` (quoted rate for a dead market) feeds `native_price`; routes keep `direct_rate`; `tests/test_native_price_dead_market.py`. Driven: Mods page Perfect Essence of Seeking 39.9 → 15.5 ex. Code review: a recipe that takes a dead market's slot keeps the market edge in `meta["market"]` (`Graph.add_recipe`), so the recipe ratio is never shown as the price.
`board.native_price` (used by Capital's native amount and the Mods page's costs) takes
`g.direct_rate(c, cur)`, which returns the edge's `rate` even when the market is flagged
`inactive`, where `rate` is the worst-case side (`digest.directed_rates`), not what it traded at
(`meta.quoted_rate`).
- Repro (owner's DB copy, Forbidden Rites): 6 currencies, e.g. Orb of Transmutation native
  0.0319 ex vs that market's traded rate 0.577 ex (18x low); perfect-essence-of-seeking 39.9 vs 15.5;
  ancient-liquid-disgust 7 vs 2.8.
- Fix: for an inactive edge use `quoted_rate` (or fall back to the value table), per the volume rule
  ("that market's own rate").

### A2. Route margins come from averaged rates, and the spread can exceed them
Live order books are off (`orderbook.BULK_EXCHANGE_ENABLED = False`), so routes use each market's
48 h averaged rate in both directions (`digest.directed_rates`, by design so one market cannot loop
against itself). Margins are the gaps between different markets' averages.
- Repro (owner's DB copy): the top route Divine → Chaos → core-destabiliser → Divine shows +26%,
  fill 0.8 h. The destabiliser's Divine market averaged 0.79–0.97 div per hour, but each hour's
  trades ranged 0.5–1.0 div, wider than the margin. Whether the loop pays depends on which side of
  that range the user gets; the screen shows no risk.
- Not a proven bug: a product decision on how to price routes (charge each market's spread,
  require the gap to persist, or show a range).

### A3. Prices are 48 h averages, labelled with the newest hour's age
`digest.RATE_WINDOW_H = 48`, `RATE_HALF_LIFE_H = 12.0`; the card's age is the newest hour. In a fast
move the shown price lags while reading as fresh. Size not measured here.

### A4. Hold's drawdown cap was tuned on named items
**RESOLVED:** re-derived without named items; −40% kept for returns (owner); `docs/hold-research.md` "Drawdown cap re-derived".
`holdscore.py:51` `MDD_CAP = -0.40  # Tightest cap that still spares Mirror/Hinekora`. It applies to
every item, but the value was chosen by looking at two named items, against the no-hardcoded-bias
rule (feedback memory "Hold: no hardcoded bias"). The gate also uses raw closes from league-day 0,
while the Drawdown column shows the smoothed dip since day 7.
- Fix: re-derive the cap from the backtest without targeting items; gate on the measure shown.

### A5. "% change over the window" when the series is shorter (low)
`marketseries.change_over` falls back to the first point when the series is shorter than the window
(documented). A 3-day-old market shows a "7d" change. Early-league only.

## UX

### U1. "Building your dashboard" shows on every routine crawl
**FIXED:** crawl reports `building`; label says "Refreshing market data" otherwise; `tests/test_backfill_building.py`, `frontend/test/backfill-label.test.mjs`. Driven. Code review: `building` is install-wide (`_has_history`), so a new league on a populated install is a refresh.
`leaguehistory.backfill()` always sets `phase: "leagues"` then `"crawling"`; `BrandOrb.jsx` spins on
both and `backfillLabel.js` says "Building your dashboard …". Every launch after 12 h closed and every
12 h while open, even on a seeded install with a full board.
- Fix: expose a `cold` flag (first crawl of a league with no stored history); spin only then.

### U2. Arbitrage filters are never saved; every keystroke restarts the search
**FIXED:** saved to settings (user.sqlite), search debounced; `frontend/test/route-filters.test.mjs`. Driven: 0.7 saved and survived a tab switch (restored to 0.5). Code review: the search sends the form's values explicitly (`streamQuery`: a cleared box is 0 = off, never left for the server to fill from the saved settings) and re-runs on any change, "Show at most" included; the pool stays at least 100.
`RoutesView.jsx:81` reads `s.filters`; nothing in `frontend/src` writes them back. The search effect
depends on the filter values, so typing reopens the route stream each keystroke. Edits are lost on a
tab or league switch.
- Fix: debounce and `saveSettings({filters})`.

### U3. Opening Settings runs the diagnostics probe
**FIXED:** runs when the section opens; `frontend/test/diag-on-open.test.mjs`. Driven.
`SettingsView.jsx:184` `useEffect(() => { run() }, [])` in `DiagPanel`, mounted inside a closed
`<details>`; `/api/diag` counts the market tables and makes outbound connectivity probes.
- Fix: run on the `<details>` opening.

### U4. The Board polls Hold and Movers every 30 s, visible or not
**FIXED:** `lib/poll.js`: every 5 min while visible, at once on focus; tiles keep 30 s, paused while hidden; `frontend/test/poll.test.mjs`. Driven. Code review: focus + visibility on return count as one refresh (5 s minimum gap).
`BoardView.jsx` (the pulse strip) refetches `/api/hold` (full leaderboard scoring) and `/api/movers`
every 30 s with no visibility check; both come from daily/hourly data.
- Fix: gate on `document.visibilityState`, poll every 5–10 min.

### U5. Tabs remount and refetch on every visit
`App.jsx:234-238` renders each tab conditionally, so returning to Board shows the skeleton and
Strategy reruns the route search.

### U6. Restraint (§0) cuts
- Market tab "Edges in the current graph" (`MarketView.jsx:93`): the raw graph, every edge.
- Settings → OAuth "Not configured … See README → OAuth" (`AccountsPanel.jsx:92`), shown to every
  desktop user; OAuth is not configured in desktop builds.

## Code health

### H1. The deploy test gate depends on this Mac's own app data
**FIXED (gate):** replays opt-in via `ARBITER_PROD_TESTS=1` (`tests/_proddb.py`); converting them to fixtures is a follow-up.
Four `test_review_2026_09_23.py` tests read `~/Library/Application Support/Arbiter/data/market.sqlite`
and need its newest digest hour to equal "now" (e.g. line 116 `only 0 lines checked`). They fail
whenever the local app has not run in the last hour, independent of the code.
- Fix: an opt-in marker outside `ops/run-tests.sh`, or point them at a fixture.

### H2. Electron 33 is out of support
`desktop/package.json` `"electron": "^33.0.0"`; its Chromium renders the embedded trade site.

## Did not survive checking
- "The installer sends users' data to the owner's server": the address is a LAN address; see D4.
- "Any website can read the trade session": `GET /api/session` returns no cookie.
- "55 currencies have wrong native prices": 6 are A1; in the other 49 the native price is the
  market's own traded rate and the value table uses a different market (the two markets disagree,
  up to 7x). Open question, not a bug.
- "Zarokh's Revolt is overvalued 32x": it traded at about 2.4 div each (41 div for 17) and at about
  65 ex each; the markets disagree 20x. Not provable either way.
- "The Bulk Exchange workers waste resources": they block idle on an empty queue; the sweeper still
  prunes `orderbook_history`.
