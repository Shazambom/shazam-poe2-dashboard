# Dev notes — the working loop & hard-won gotchas

Practical, load-bearing knowledge for building on Arbiter, distilled from doing the work.
This is the **glue** between the canonical docs — read those for the contracts, this for how to
actually move:

- [`../CLAUDE.md`](../CLAUDE.md) — the desktop contract, web-vs-desktop rules, DB rules, philosophy.
- [`release-runbook.md`](./release-runbook.md) — cutting a desktop release, step by step.
- [`desktop-debugging.md`](./desktop-debugging.md) — driving the real renderer over CDP.
- [`ui-styleguide.md`](./ui-styleguide.md) — the visual contract + the style linter.
- [`db-architecture.md`](./db-architecture.md) / [`db-maintenance.md`](./db-maintenance.md) — the DB split.
- [`strategy-ecosystem-plan.md`](./strategy-ecosystem-plan.md) — the Strategy-tab roadmap. Phases 1–7a
  are shipped; only Phase 7b (deploy efficiency) was never started. Read it for the locked
  cross-cutting decisions, not as a queue of work.
- [`README.md`](./README.md) — the index: what each doc is and, for the plan docs, what is actually built.

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

- **The one test gate:** `./ops/run-tests.sh` (backend pytest, the feedback bot + opener pytest,
  frontend + desktop `node --test`, the workspace fuzz, the style lint). The deploy scripts run it
  first; run it yourself before every commit. Setup once: `python3.12 -m venv .venv-test && source
  .venv-test/bin/activate && pip install -r backend/requirements.txt pytest Pillow hypothesis discord.py`.
  The opener fuzz runs ~70 examples per test in the gate; `cd ops/feedback-bot && pytest tests
  --hypothesis-profile=long` for a real soak (3000 each, ~90 s).
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

**T0 blockers, automatic.** Any full-sync fallback (seed failed / unreadable / unseeded, digest
cold start with a seed, a league refetched wholesale, empty mod tables with a seed) is reported
by the client as `[T0]: <kind>: …` (`devtelemetry.t0`, kinds in `T0_KINDS`) on the beta channel;
`ops/t0-scan.py` classifies the log and `ops/t0-check.sh` gates every stable release on it and on a
healthy `[mods]` startup line. See the runbook's "T0 gate". Tests: `backend/tests/test_t0.py`.

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

## Feedback reports ("Report a problem")

The design and the threat model: [`feedback-implementation-plan.md`](feedback-implementation-plan.md).
The shape: the app packages ONE sealed file (`arbiter-report-<ID>.arb`: state + logs + a picture of
every screen, X25519→HKDF→AES-GCM to the owner's public key), the user drags it into the Discord
`#bug-reports` forum, and a listener bot on shazam opens it. No drop point, no credential in the
app, no new outbound call (the invite opens in the OS browser); nothing can bill.

- **Code:** `desktop/src/feedback/` (`seal.js`, `redact.js`, `ring.js`, `bundle.js`, `snap.js`,
  `index.js`, `dests.js`), `desktop/src/preload-snap.js`, `frontend/src/components/FeedbackDialog.jsx`,
  `frontend/src/lib/{dests,errorRing}.js`; owner side `ops/feedback-bot/` (`bot/bot.py`,
  `bot/arbseal.py`, `opener/{opener,cell,dests}.py`, two Dockerfiles, the compose block).
- **Entry points:** ⌘K → *Report a problem…*; Settings → Diagnostics → *Report a problem…*. Files
  land in `<userData>/reports/` (the last 10 kept). One packaging per minute.
- **`?snap=1` mode:** the sweep loads the UI in a hidden second window with `preload-snap.js` (no
  IPC writer reachable) and a session filter that cancels any non-GET `/api` request from it. Under
  `SNAP` the app skips polling, notifications, toasts, hotkeys, the trade `<webview>` and workspace
  persistence; `window.__arbiterSnap({section, sub})` switches the screen and resolves once status
  is loaded and the screen's own fetches have gone quiet. Drive it yourself: open the dev app with
  `?snap=1` in `scripts/console.mjs` and expect no renderer exception.
- **Three copies of the screen list must never drift** — `frontend/src/lib/dests.js` (the UI),
  `desktop/src/feedback/dests.js` (the sweep), `ops/feedback-bot/opener/dests.py` (the opener's
  allow-list): `desktop/test/feedback-dests-sync.test.mjs` + `tests/test_cell.py` pin them.
- **Keys (done 2026-09-18, key id 1):** minted on shazam INSIDE the bot image, so the private half
  never exists anywhere else and nobody on the Mac side ever reads it:
  `docker run --rm -u 10001 -w /keys -v /etc/arbiter/keys:/keys -e PYTHONPATH=/app:/app/bot
  shazam-poe2-dashboard-feedback-bot python -m arbseal keygen <keyId>` (dir `/etc/arbiter/keys`,
  0700, owned by uid 10001 = the bot). It writes `feedback-key-<id>.pem` (0600, refuses to
  overwrite) and `feedback-key-<id>.pub`. Copy ONLY the `.pub` into the repo as
  `desktop/src/feedback/owner-key.pub` — `seal.js` reads it at load, `feedback-seal.test.mjs` checks
  it is 32 bytes, differs from the test key, and appears nowhere in code. Rotation: bump `KEY_ID` in
  `seal.js` + `arbseal.py`, keygen the new id, replace the `.pub`, keep the old PEM in `/etc/arbiter/keys`.
- **Discord (once):** a server with a forum channel `#bug-reports`; an invite that targets that
  channel → `DISCORD_INVITE` in `desktop/src/feedback/index.js` (placeholder until then). A bot
  application with *View Channel*, *Read Message History*, *Send Messages in Threads*, *Add
  Reactions*, and the **Message Content** intent (needed to see attachments). Token →
  `/etc/arbiter/discord-token` (root-owned, 0600); the forum channel id → `FEEDBACK_FORUM_ID` in
  shazam's `.env`.
- **Deploy:** `./ops/deploy-web.sh bot` (test gate → rsync `ops/feedback-bot/` + compose → builds and
  starts `feedback-opener`, and `feedback-bot` too once `/etc/arbiter/discord-token` exists on the box;
  pre-creates `feedback-inbox/` owned by uid 10001). Verified 2026-09-18: a report from the Mac app
  handled by the bot container against the live opener on shazam → ✅ + all 10 screens in the inbox;
  a tampered file → ⚠️ + `quarantine/`. The opener runs with `network_mode: none`, read-only root, no
  capabilities, pids/mem/cpu limits, and spawns a fresh child per report under rlimits (RLIMIT_AS
  512 MB, CPU 20 s, FSIZE 64 MB, NPROC 0, NOFILE 16, 30 s wall clock). `RLIMIT_AS` is a Linux
  guarantee — macOS ignores it, so that one sandbox test skips on a Mac.
- **Reading a report:** `~/feedback-inbox/<shortId>/index.html` (screens + logs + state, every
  string escaped, CSP `default-src 'none'`), `report.json`, `logs/*.txt`, `screens/NN-<screen>.jpg`
  (re-encoded pixels — never the reporter's bytes). Unreadable files → `quarantine/<threadId>.arb`,
  the raw sealed bytes; `state.json` holds the last thread id for catch-up.

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

### Regex (Trading → Regex, added 2026-09-24)

The in-game search-string builder for Waystones and Tablets. Plan, decisions and data:
[`regex-filters-plan.md`](regex-filters-plan.md). Pieces: `frontend/src/lib/regex/`
(pure generators: `number.js`, `terms.js`, `waystone.js`, `tablet.js`, `trade.js`, `shortest.js`,
`defaults.js`, `index.js`); `frontend/src/data/regex/` (the shipped tables, built by
`frontend/scripts/sync-regex-data.mjs` from the hand-authored `pools/*.txt`, `tooltip-lines.json`
and `map-names.json`, hashed in `MANIFEST.json`); `components/RegexView.jsx`, `RegexResult.jsx`,
`ModPicker.jsx`, the shared `Knob.jsx`. Settings persist under `regex_tools` in the settings blob.
**When a patch adds a mod:** add its line to the pool, run the sync, read the token it got, commit
both. The fuzz suite (`frontend/test/regex-fuzz.test.mjs`) models the tooltip and the search box;
a wrong assumption about the game is one edit there. `frontend/scripts/regex-number-goldens.mjs`
regenerates the number goldens from the reference implementation (dev only, pinned commit,
source stays in `~/.cache`); `frontend/test/regex-number-golden.test.mjs` holds `number.js` to them.

### Mods (Trading → Mods, added 2026-09-25)

The modifier pool viewer: what can roll on an item type between an orb's minimum modifier
level and the item level, and how likely each family is. Design and decisions:
[`mods-page-design.md`](mods-page-design.md); research: [`mods-page-roadmap.md`](mods-page-roadmap.md).
The tables are **market data**: `backend/app/modpool.py` derives them from the RePoE PoE2 export
and poe2db's currency pages and writes `mod_pools` / `mod_currencies` (in `SEED_TABLES`), rebuilt
on shazam by `ops/publish-market-snapshot.sh` before every seed, so a new patch's pools ship
with the next seed and no file in the repo changes. `GET /api/mods/pools` and
`GET /api/mods/pool/{id}` read them. Client pieces: `frontend/src/lib/mods/` (pure: `pool.js`
arithmetic, `orbs.js`, `defaults.js`, `format.jsx`; `index.js` the session store),
`components/ModsView.jsx`, `ModsBar.jsx`, `ModTable.jsx`, `ModFamily.jsx`, `ModSection.jsx`,
the shared `Num.jsx`. Settings persist under `mods_tools`. "Search on trade" on a family:
`lib/mods/trade.js` builds the query in the Regex frame from what main's `mods:lookup`
(`desktop/src/trade/modsearch.js`, EE2's stat + item catalogues) returns; web has no button.
`lib/mods/stash.js` (Find in stash) maps a waystone/tablet family to the Regex tab's wanted
modifiers by printed line and writes `regex_tools` before `nav.openTrading('regex')`
(tests: `frontend/test/mods-stash.test.mjs`). `lib/mods/prices.js` (`forcedBy`, `priceOf`) joins
grants to tiers by text and reads `modpool.prices(pool_id)` (`/api/mods/pool/{id}/prices`, the
value table by grant name; tests: `frontend/test/mods-prices.test.mjs`, `test_modpool.py`).
Paste item: `desktop/src/vendor/ee2-query/index.js` `parseItem` → worker `parse` message
(`ee2-history/worker.js`, host `parse()`, consumer `parseItem`) → main `mods:item` (reads the
clipboard; only the parse crosses) → preload `trade.modItem` → `lib/mods/item.js` (`poolFor`,
`matchItem`, `slotsFor`) and `atLevel(..., onItem)` (tests: `desktop/test/mods-item.test.mjs`,
`frontend/test/mods-item.test.mjs`).
Tests: `backend/tests/test_modpool.py` (derivations over `tests/fixtures/mods`, a trimmed
export), `frontend/test/mods-*.test.mjs`, `desktop/test/mods-search.test.mjs` (the real
vendored data, so an EE2 sync that renames a group fails here).
**On a dev backend** the tables are empty until `POST /api/mods/refresh` (it fetches the sources
into `DATA_DIR/gamedata`); the desktop app never calls it.

## Deploying a desktop release (mechanics)

Full runbook: [`release-runbook.md`](./release-runbook.md). Shape: bump `desktop/package.json`,
commit on `main`, then `cd desktop && ./publish-github.sh` — it runs the test gate, pushes `main`,
dispatches the Windows CI (no tag is pushed — publishing the draft creates it; CI builds the `.exe`s with the shared `build-*.sh` scripts), builds
the Mac app, waits on the CI run via `gh run watch`, and uploads both platforms into the same
**draft** release, which goes public in one verified step at the end
(`desktop/scripts/release-assets.mjs`: manifests last, retries, go-live check, auto-rollback). Then verify:
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
- **Negative-cycle search (2026-09-17):** `negcycle.py` — Bellman-Ford from the Wikipedia pseudocode,
  twice: `bellman_ford_naive` (line for line; the spec) and `bellman_ford` (numpy, one array pass per
  round; what runs). Held 1:1 to each other, to a brute-force enumerator, to William Fiset's version
  (`test_negcycle_fiset.py`) and to networkx's distances (`test_negcycle_networkx.py`, sidecar venv
  only — networkx's own `find_negative_cycle` fails ~0.25% of inputs, which is why this is not a port).
  `arbitrage/deepscan.py` feeds its loops through the normal `_route_from`/`simulate` path (rows tagged
  `deep`). **numpy is now a main-backend dependency** (optional at runtime: the scan degrades to nothing).
  Beta telemetry: `[deepscan]` lines under `p=sidecar` (numpy ok/missing, loops, ms — no currency names).
- **Route sanity (2026-09-17):** `graph.credible_offers` drops live offers paying > `BAIT_FACTOR`× the
  pair's EXECUTED (digest) rate (price-fixer bait on the whisper-based trade-site exchange: Omen of
  Light "for 1 exalted"). **Do NOT cap loop margins:** a 0.2.58-beta.1 experiment hid loops claiming
  > 50% and the owner rejected it — digest rates are EXECUTED in-game Currency Exchange prices, so a
  +500% loop through a thin market (3 essences sold for 1 divine each) is a real MAKER opportunity
  (place the order, wait); `fill_hours` / volume / the liquidity filter are what qualify it, not the
  margin. The deep scan adds rows silently (no chip, no summary text — the UI speaks for itself).
- **Liquidity floor = 200 ex (owner mandate 2026-09-17):** `settings.DEFAULTS.filters.min_liquidity_ref`,
  `routes.RECOMMENDED_MIN_LIQUIDITY_REF`, and user migration 6 (`_liq_floor_v2`) which lifts SAVED filters
  once — liquidity decides whether a loop can be traded at all. The Arbitrage legend carries no search
  statistics by design (owner: "let the UI speak for itself").
- **Fillable steps (owner mandate 2026-09-17):** (1) `digest.directed_rates` — a digest edge a->b exists only
  if the RECEIVING side had standing stock that hour (`hi_stock_*` > 0); traded volume is never a stand-in
  for stock (Esh's Radiance "for 13 chaos": zero Radiance ever listed for chaos, only bids). (2)
  `simulate()` reports `slowest_step_hours` (units in ÷ units/h of that market) and the
  `max_step_minutes` filter (default 45, 0 = off) drops loops whose worst step needs more — turnover
  judged RELATIVE to the trade, because a fixed ex/h floor passes "expensive, trades twice a day".
- **Price source (owner directive 2026-09-17):** the hourly Currency Exchange digest is the SOLE source for
  prices, valuations and loops. The trade site's Bulk Item Exchange (`orderbook.py`, whisper listings — a
  different venue) is DEPRECATED behind `orderbook.BULK_EXCHANGE_ENABLED = False`. Read
  [`market-data-sources.md`](./market-data-sources.md) before touching pricing.
- **Exchange have-cap:** GGG rejects > 10 `have` per exchange request (was ≥ 12 until 2026-09-17, when
  every live fetch started failing with a 400). `orderbook.state["have_cap"]` learns the cap down on
  "Too many items" and re-queues the same pairs; `last_error` now carries GGG's response body.
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
