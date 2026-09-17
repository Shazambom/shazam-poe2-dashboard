# Dev notes — the working loop & hard-won gotchas

Practical, load-bearing knowledge for building on Arbiter, distilled from doing the work.
This is the **glue** between the canonical docs — read those for the contracts, this for how to
actually move:

- [`../CLAUDE.md`](../CLAUDE.md) — the desktop contract, web-vs-desktop rules, DB rules, philosophy.
- [`release-runbook.md`](./release-runbook.md) — cutting a desktop release, step by step.
- [`desktop-debugging.md`](./desktop-debugging.md) — driving the real renderer over CDP.
- [`ui-styleguide.md`](./ui-styleguide.md) — the visual contract + the style linter.
- [`db-architecture.md`](./db-architecture.md) / [`db-maintenance.md`](./db-maintenance.md) — the DB split.
- [`strategy-ecosystem-plan.md`](./strategy-ecosystem-plan.md) — **the roadmap; start here to pick up work.**

---

## The three environments (know which you're in)

| | What it is | Where | How to build/run |
|---|---|---|---|
| **Web** | TEST/staging surface | shazam Docker — backend `:8000`, frontend `:8080` (`http://192.168.1.250:8080`) | rsync + `docker compose up -d --build` (see below) |
| **Desktop dev** | representative local run | this Mac — backend `127.0.0.1:8210`, CDP `:9222` | `npx electron . --remote-debugging-port=9222` |
| **Desktop packaged** | PRODUCTION artifact | `desktop/release/mac-arm64/Arbiter.app` | `npm run dist:mac` → `open …/Arbiter.app` |

**Web = test, desktop = production. "Ship" = publish a desktop release, and only with explicit
per-change authorization** (CLAUDE.md). A desktop **user check** is always the *packaged* app
launched in place (`dist:mac` → `open …/Arbiter.app`), never the dev launch or the web env.

### Deploy to the web test env (fast iteration)

```bash
./ops/deploy-web.sh              # tests → rsync backend/app + sidecar + frontend/src + compose → rebuild both
./ops/deploy-web.sh backend      # ... rebuild only the backend container (or `frontend`)
./ops/deploy-web.sh ops          # sync the seed publisher/exporter/uploader to shazam:~/bin
```
The script runs `ops/run-tests.sh` first and aborts on a red test. Under the hood it is the
rsync + `sshshazambom sudo bash -c 'docker compose up -d --build …'` sequence (shazam is not
in the docker group, so compound commands need `sudo bash -c`).

- `sshshazambom` wrapper: `sshshazambom sudo …` roots **only the first program** — compound
  commands need `sudo bash -c '…'` (note the nested quoting above). Plain `docker` fails with a
  permission error (not in the docker group). See [[reference_sshshazambom]] in memory.
- Rebuild only the service that changed (`backend` and/or `frontend`) to save time.

---

## Backend gotchas (these bit me — save yourself the loop)

1. **Desktop dev runs the COMPILED backend binary, not your `.py`.** After editing anything under
   `backend/app`, you MUST rebuild it or the running app serves stale code:
   ```bash
   cd desktop && ./build-backend.sh    # PyInstaller → backend-bin/poe2arb-backend (~1–2 min)
   ```
   Symptom of forgetting: a new setting/endpoint "does nothing" in the desktop app while the
   web env (which runs the `.py` directly in Docker) works fine. `npm run build:frontend` only
   rebuilds the UI — it does NOT rebuild the backend.

2. **The board is TTL-cached AND keyed.** `arbitrage.board()` caches on
   `(league, reference, watchlist, window_h, hub_count)` + `orderbook.state["version"]`. Any new
   input that changes the board's output MUST be added to that key, **and** `invalidate_caches()`
   must clear `_board_cache` (it clears graph + route + board caches). Settings edits call
   `invalidate_caches()` via the PUT endpoint. Miss either and your change won't show until the
   30s TTL lapses — or ever. (Learned shipping `hub_count`.)

3. **Everything is priced through `arbitrage.Graph.ref_values()`** (levelled BFS from the
   reference, poe2scout fallback for unreachable currencies). The board's per-currency **display
   numeraire** is `pref_num` — the highest-**volume** readable counterpart (MIN_READABLE walk in
   `board()`). Reuse `pref_num` / the frontend `numFor(r)` whenever you show a currency's price so
   it matches the cards (e.g. Mirror shows in Divine, Divine in Chaos) — never hardcode a unit.

4. **One-time settings seeds** follow the `_liq_floor_v1` pattern in `settings.py::get_settings`
   (and `_hub_seed_v1`, applied in `board()` once real data exists). Use this when a default needs
   to be computed from live data or back-filled for existing users: guard with a boolean flag,
   run once, then leave the user in control (their later edits stick).

5. **Market-side DB changes must not silently break the snapshot exporter** — the CLAUDE.md DB
   guardrail. Centrality/hubs touch **no DB** (computed live from the in-memory graph), so they're
   exempt; anything that adds a market table/column/kv-routing is not.

---

## Frontend patterns

- **Design tokens are law.** No raw hex in `.jsx` or `styles.css` — `var(--token)` in CSS, the
  `theme.js` export in JS. `cd frontend && npm run lint:style` enforces it (and bans raw
  `<input type="checkbox">`). Run it before every commit; it's in CI.
- **Reuse these components** before writing UI: `Toggle` (the only on/off control), `RefreshButton`
  (icon-only), `CurrencyPicker` (every currency field — progressive search), `CardDetail` (+ its
  `useAssetModal` / `rangeLabel`; it **requires** a `range` prop or `"all"` and throws otherwise),
  `Cur` (canonical currency icon+name). The board's **pulse-strip** groups (Hubs/Hold/Movers) are
  the pattern for at-a-glance clusters that click into `CardDetail`.
- **New pages are the failure mode.** Prefer a sub-tab, a badge/column on an existing view, or an
  inbox entry (see CLAUDE.md "ecosystem, not dashboards"). Hubs shipped as a tile glyph + a
  pulse-strip group + a CardDetail stat — zero new pages, zero new endpoints.
- **Scale-to-fit over premature wrap:** the pulse-strip measures itself vs its container
  (`ResizeObserver`) and applies `transform: scale()` to stay on one line, only adding `.wrap`
  below a floor. `vw`-based `clamp()` alone does NOT help near normal widths (it only shrinks near
  small viewports) — measure and scale when "always fits" is the requirement.

---

## Adding a settings-driven feature (end-to-end checklist)

Threading a new user setting all the way through (as `hub_count` did):

1. **`backend/app/settings.py`** → add the key + default to `DEFAULTS` (with a comment).
2. **Consume it** in the relevant backend module; clamp/validate at the read site
   (`max(1, int(s.get("hub_count") or …))`). If it affects `board()`, add it to the **cache key**.
3. **`frontend/src/components/SettingsView.jsx`** → add the field (themed `.field` + number input,
   or `Toggle`/`CurrencyPicker`) **and** add the key to the `persist()` whitelist — that function
   only sends listed keys, so a field with no whitelist entry silently never saves.
4. `/api/settings` PUT already deep-merges arbitrary keys and calls `invalidate_caches()`.
5. Rebuild the backend binary (gotcha #1) before checking on desktop.

---

## Testing & validation

- **The one test gate:** `./ops/run-tests.sh` (backend pytest, frontend + desktop `node --test`,
  the workspace fuzz, the style lint). The deploy scripts run it first; run it yourself before
  every commit. Setup once: `python3.12 -m venv .venv-test && source .venv-test/bin/activate &&
  pip install -r backend/requirements.txt pytest`.
- **Backend tests** are pure over a synthetic `arbitrage.Graph` — no DB needed (see
  `test_convert.py`, `test_centrality.py`). Prefer extracting a pure helper and testing that over
  trying to test `board()`/endpoints directly. `tests/golden/*.json` pin the arbitrage core's
  full JSON output (routes, stream==direct, convert, board) — a deliberate behaviour change
  regenerates them with `UPDATE_GOLDEN=1`.
- **Drive the real renderer** for any UI/data claim (`desktop-debugging.md`): `build:frontend` →
  launch with `--remote-debugging-port=9222` → `node scripts/cdp.mjs "<js>"` / `scripts/shot.mjs`
  / `scripts/console.mjs` (reload + capture renderer exceptions — a blank page after a rebuild
  means look here). A passing `vite build` proves compilation, not that the feature renders. The
  CDP tab is hidden, so animations freeze mid-flight — assert on settled DOM, not on a frame.
  ⚠️ The dev launch shares the packaged app's data dir: probe `/api` read-only, exercise writers
  through the UI, never `PUT`/`POST` synthetic payloads at user-data endpoints.
- **`transform: scale()` and clicks:** click targets still map correctly under a scaled ancestor
  (verified with `elementFromPoint`) — scaling the pulse-strip didn't break its chip buttons.
- **Owner review on the packaged app (a REQUIRED step, before committing UI/UX changes).** After the
  automated tests + your own CDP drive-validation pass, build the app the owner actually runs and let
  them check the changes in the real production binary — don't declare a UI change reviewable off the
  web/dev drive alone:
  ```bash
  cd desktop && npm run dist:mac:all          # from-scratch: backend + sidecar + frontend + electron
  #   (use `npm run dist:mac` if backend-bin/ + sidecar-bin/ are already current — faster)
  open desktop/release/mac-arm64/Arbiter.app  # launch in place on this Mac for the owner to explore
  ```
  To also CDP-screenshot the production binary yourself, launch it with a debug port instead of `open`:
  `desktop/release/mac-arm64/Arbiter.app/Contents/MacOS/Arbiter --remote-debugging-port=9222 &`, then
  `node scripts/cdp.mjs`/`scripts/shot.mjs` against `:9222` (backend on `:8210`). Heavy sidecar jobs
  (STUMPY/DTW) need ~30–60 s of numba cold-JIT after boot before `/api/signals` + `/api/arc` fill in.
  This is a **test build, NOT a ship** (building/running/CDP ≠ delivery — see CLAUDE.md), so it needs no
  ship authorization. Sequence: implement → tests + CDP drive → **owner reviews the packaged build** →
  commit → (only on explicit "ship") publish.

---

## Verifying the packaged Windows app (telemetry)

The policy — *the user is not your tester; build telemetry so YOU can see behavior* — lives in
CLAUDE.md. The mechanics:

- This Mac can't run the Windows build, and native-module / install / update / OS-permission
  behavior isn't observable from dev. So: add server-reporting telemetry to the thing under test,
  cut a build, have the user just *use* it, and read the results yourself:
  `GET http://192.168.1.250:8080/api/installlog`, filtered by a `?p=<tag>` marker.
- Existing markers: `p=init` (installer self-heal), `p=backend` (spawn/exit/bind + the analytics
  probe), `p=login` (PoE/Steam login), `p=update` (auto-updater events), `p=ee2` (EE2 hooks),
  `p=sidecar` (sidecar + supervisor lifecycle).
- This is the **one sanctioned exception** to the desktop "server-for-updates-only" contract, and it
  is **beta/dev-only in every case**: every sender goes through `desktop/src/telemetry.js`
  (`installLog(marker, body)`, gated by `diagTelemetryOn()` in `main.js`) or
  `backend/app/devtelemetry.py` (`tlog(tag, msg)`, gated by `ARBITER_TELEMETRY=1`, which
  `main.js` sets only on beta/dev). Add a marker, never a second sender or URL. Report only what
  you need (never secrets / keystrokes / raw clipboard).

## Trading workspace pieces (added 2026-09-17)

- **Vendored EE2 query port** — `desktop/src/vendor/ee2-query` (generated; never hand-edit: the drift test
  compares every file to `data/MANIFEST.json`). Refresh with `node desktop/scripts/sync-ee2.mjs`
  (`--src ~/Exiled-Exchange-2` for a local checkout, `--tag vX` to pin, `--offline` to keep the GGG snapshot,
  `--no-goldens` to skip the EE2-vitest golden run). `publish-github.sh` runs it before the test gate on every
  release. EE2's vitest needs Node ≥ 20 — the script finds one (Homebrew) if the shell's is older.
- **Driving the history flow without EE2 installed:** in a dev launch,
  `window.poe2desktop.dev.ee2Item({ raw, origin: 'ee2' })` pushes a fixture through the real consumer +
  utilityProcess worker (main refuses it when packaged). Fixtures: `desktop/test/fixtures/ee2/items/*.txt`.
  The CLI form: `node desktop/src/ee2-history/worker.js --stdin --league "Standard" < item.txt`.
- **Telemetry markers** added: `ee2` (history-*), `ws` (workspace save/undo/flush), `sales`.
- **Sales tab** — main fetches Merchant History under policy `trade-history`; the backend's `sales` table
  (user migration 5) is the ledger. Only `POST /api/sales/ingest` writes it.
- **Drive scripts:** target workspace rows by `data-id` (never by name — names collide with real searches).

## Deploying a desktop release (mechanics)

Full runbook: [`release-runbook.md`](./release-runbook.md). Shape: bump `desktop/package.json`,
commit on `main`, then `cd desktop && ./publish-github.sh` — it runs the test gate, tags + pushes
(which fires the Windows CI that builds the `.exe`s with the shared `build-*.sh` scripts), builds
the Mac app, waits on the CI run via `gh run watch`, and uploads both platforms into the same
release. Then verify:
GitHub's "Latest" == your tag, both `latest*.yml` + installers present, and the installer URLs
resolve `200` (a 404 means the space-free-naming rule was violated — GitHub rewrites spaces to
dots and the updater can't find the asset). **Shipping requires explicit per-change authorization**
(CLAUDE.md) — do not push a `desktop-v*` tag or run `publish-github.sh` until told.

**Two channels — "deploy dev":** a **beta (dev) channel** lets us iterate on the packaged app without
testing in prod. Same mechanics, but the version is `x.y.z-beta.N` → GitHub **pre-release** (never
"Latest") → `beta.yml`/`beta-mac.yml`; diagnostics telemetry (`p=backend`/`p=sidecar`) fires **only**
on beta. Clients opt in via Settings → Diagnostics → "Beta updates". When the owner says **"deploy
dev"**, publish a `-beta.N` pre-release; "ship"/"deploy" (no "dev") means a stable `x.y.z` release.
Full table + steps: [`release-runbook.md`](./release-runbook.md) → "Two channels".

## Quick map (where things live)

- **Pricing/graph:** the `arbitrage/` package (import the facade `arbitrage`): `graph.py`
  (`Graph.build/ref_values/iter_cycles/iter_paths`, `simulate`, the graph cache), `routes.py`
  (`find_routes/stream_routes`, ranking, the route cache), `convert.py` (`convert`/`_best_conversions`),
  `board.py` (`board()`, `edge_table`); `centrality.py` alongside.
- **Analytics:** `movers.py`, `holdscore.py`, `inflation.py`/`leaguehistory.py`, `centrality.py`.
- **Data ingest:** `digest.py`, `orderbook.py`, `gamedata.py` (gold fees), `gateway.py` (rate-limited HTTP).
- **API:** `main.py` (all routes). **Settings:** `settings.py`. **DB:** `db.py`/`config.py`.
- **Frontend views:** `BoardView`, `HoldView`, `RoutesView`/`ConvertView`, `InflationView`,
  `MarketView`, `WorkspaceView`/`LiveView`, `SettingsView`; shells `EconomyView`/`StrategyView`/
  `TradingView` over one `SubTabs`. **Shared client plumbing:** `lib/hooks.js` (`useApi`,
  `useAutosave`), `lib/statusStore.js` (the one status/capital/settings poll),
  `lib/icons.js` (`useCurrencies`), `lib/session.js` (`isDesktop`, trade URLs), `lib/api.js`
  (`fmt`, the toast `bus`).
- **Backend shared plumbing:** `cache.py` (the one TTL memo), `datapolicy.py` (user-vs-market
  kv, retention, seed tables), `marketseries.py` (anchors, day/window helpers, the league
  reader — sidecar-safe), `devtelemetry.py`, `diag.py`.
- **Ops:** `ops/{run-tests,deploy-web}.sh`, `ops/` (market-seed export/publish),
  `desktop/{build-backend,build-sidecar,fetch-seed,publish-github}.sh`,
  `desktop/scripts/{cdp,shot,console}.mjs`.
