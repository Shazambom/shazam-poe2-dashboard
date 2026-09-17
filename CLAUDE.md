# Arbiter — project contract

## ⛔ HIGHEST-IMPORTANCE RULE — the desktop contract

**DESKTOP APPS MAY ONLY CALL THE SERVER FOR UPDATES. NOTHING ELSE.**

The desktop app (Arbiter, `desktop/`) is **fully self-contained**: it ships its own
backend (PyInstaller binary in `backend-bin/`, bundled via `build.extraResources`) and
its own local SQLite DB (in the OS user-data dir). Every `/api` request is served by
that **bundled local backend on 127.0.0.1** — never a remote server.

The **only** permitted outbound calls are the **auto-updater** and, **on the beta/dev channel
only**, diagnostics telemetry:
- Auto-updater: electron-updater's `github` provider reads `latest*.yml` + installers from
  **GitHub Releases** (`Shazambom/shazam-poe2-dashboard`, the `desktop-v<ver>` tag GitHub
  marks "Latest"). No token needed (public repo). See the deploy section below.
- Telemetry (owner directive 2026-09-16): **every** diagnostic sender — backend spawn/exit,
  updater, login window, EE2 hooks, sidecar — goes through ONE gate, `diagTelemetryOn()` in
  `desktop/src/main.js` (beta channel or an unpackaged dev run), via the one sender
  `desktop/src/telemetry.js` (`installLog`) / `backend/app/devtelemetry.py` (`ARBITER_TELEMETRY`).
  A **stable** packaged build makes zero telemetry calls. Change what is enabled through that
  gate; do not add a second sender or a second URL constant.

Consequences to preserve in any change:
- Never route `/api`, session, board, routes, prices, telemetry, etc. to the remote
  server from a *packaged* desktop build. `startBackend()` in `desktop/src/main.js` is
  local-only; the only non-local branch is a `!app.isPackaged` DEV convenience
  (`ARBITER_DEV_BACKEND_URL`).
- The pathofexile.com rate budget has ONE owner: the bundled backend (`gateway.Policy`). The
  Electron live-search engine reserves/reports through `POST /api/ratelimits/acquire|observe`
  on loopback (`desktop/src/trade/budget.js`); never re-implement header parsing in JS.
- Every platform must bundle a backend built **on that platform** (PyInstaller can't
  cross-compile): macOS backend via `desktop/build-backend.sh` (built locally on the
  Mac); Windows backend via the GitHub Action (`.github/workflows/release-desktop-win.yml`,
  which PyInstaller-builds `poe2arb-backend.exe` on `windows-latest` before packaging).
- Do NOT build the Windows installer locally on the Mac — it would bundle the Mac
  backend binary. Windows ships through CI only. Mac ships locally. Both platforms build
  their PyInstaller binaries with the SAME scripts (`desktop/build-backend.sh`,
  `desktop/build-sidecar.sh`); CI calls them rather than carrying a second invocation.
- Any new feature that needs data must work against the local backend + local DB
  (which backfills poe2scout on first run), not the server.

## Releases (the update path — contract)

Apps update from **GitHub Releases** directly; the shazam server is NOT in the update path.
One release per version, tagged `desktop-v<ver>`, carrying BOTH platforms' assets (Windows built
in CI, Mac built + uploaded locally). electron-updater's `github` provider resolves off GitHub's
"Latest release" pointer; the `market-seed-latest` release is a **Pre-release** so it's never
"Latest". **Asset names must be space-free** (`nsis.artifactName`) or GitHub rewrites spaces to
dots and the updater 404s.

**How to cut a release** (the mechanics, verification, and gotchas): step-by-step in
[`docs/release-runbook.md`](docs/release-runbook.md); shorter shape in
[`docs/dev-notes.md`](docs/dev-notes.md) → "Deploying a desktop release". Shipping is gated on
authorization (see "Web vs desktop" below).

**Tests gate the deploy scripts, not GitHub Actions** (owner directive 2026-09-16):
`ops/run-tests.sh` (pytest + node tests + style lint) runs at the top of `ops/deploy-web.sh`
and `desktop/publish-github.sh`, and a red test aborts before any rsync, tag push or upload.
The only workflow that does real work is the Windows build; keep it that way.

## Verifying the Windows app — telemetry is mandatory

**The user is NOT the tester. If you need to verify behavior in the Windows (or any
packaged) desktop app, you MUST build telemetry so YOU can see what's happening —
never ask the user to be your eyes.** This is the ONE sanctioned exception to the
desktop "server-for-updates-only" contract: a clearly-marked TEMPORARY DEV DIAGNOSTIC,
kept OUTSIDE contract-clean packages, reporting only what you need (never
secrets/keystrokes/raw clipboard), stripped or gated before a clean release.

How (the endpoint, existing `?p=` markers, where to put the file):
[`docs/dev-notes.md`](docs/dev-notes.md) → "Verifying the packaged Windows app".

## Debugging

This is how you debug stuff: [`docs/desktop-debugging.md`](docs/desktop-debugging.md)
— build the local desktop app, launch it with `--remote-debugging-port=9222`, and
drive the real renderer over CDP (`desktop/scripts/cdp.mjs` / `shot.mjs` / `console.mjs`) to
validate UI changes against live backend data. A passing `vite build` proves compilation, not
that the feature renders correctly — always drive the app before claiming a UI change works,
and drive it **before every commit**. ⚠️ The dev launch uses the SAME data dir as the packaged
app (`~/Library/Application Support/Arbiter/data`): probe `/api` read-only, exercise writers
through the UI as a user would, never `PUT`/`POST` synthetic payloads at user-data endpoints
(a write probe once wiped the owner's saved searches; `user.sqlite.bak-N` was the safety net).

## UI styleguide — the visual contract

The frontend's design system (dark "vault" theme: slate surfaces, one gold accent, IBM
Plex Sans, tabular figures) is documented in [`docs/ui-styleguide.md`](docs/ui-styleguide.md).
Design tokens live in the `:root` block of `frontend/src/styles.css` (the single source of
truth), mirrored for JS/Recharts consumers in `frontend/src/theme.js`. **Never paste a raw
hex** — use `var(--token)` in CSS or the `theme.js` export in JS. It's enforced: `cd frontend
&& npm run lint:style` (zero-dep checker, also runs in CI) fails on hex that duplicates a
token or on colors pasted into JSX. New colors → add a semantic token to `:root`, mirror in
`theme.js` if JS needs it, then reference the token.

## Web vs desktop

- **⛔ THE WEB IS THE TEST ENVIRONMENT; DESKTOP IS PRODUCTION.** The shazam web app is a
  **staging/test surface** for cheap iteration and debugging — deploying there is NOT shipping.
  "Ship" means **publish a desktop release** (the product users auto-update to).
- **⛔ SHIPPING NEEDS EXPLICIT PER-CHANGE AUTHORIZATION (owner directive 2026-09-15).** Never
  publish a desktop release on your own. Making the changes the owner asked for, or a prior
  "ship", or the "always build desktop when shipping" rule, is **NOT** permission to ship the
  next change. Correct flow: implement → deploy to the **web test env** → **show the
  verification/testing** → **wait for an explicit "ship"** → only then publish. Do not push a
  `desktop-v*` tag or run `publish-github.sh` until the owner says ship. (Learned the hard way:
  auto-shipped 0.2.41/0.2.42 unprompted; owner objected.)
- **⛔ BUILDING THE DESKTOP APP TO TEST ≠ SHIPPING.** `dist:mac` / running the app locally / the
  CDP drive-validation are all fine anytime — that's testing, not delivery. **Shipping is only
  the publish step**: running `publish-github.sh` (it dispatches the Windows CI build into a draft
  release and publishes it, which creates the `desktop-v*` / beta tag) — or pushing such a tag or
  publishing such a release by hand. Only that step is gated on authorization.
- **⛔ A "USER CHECK" ON DESKTOP IS ALWAYS THE PACKAGED TEST BUILD (owner directive 2026-09-15).**
  When the owner wants to check a change on the desktop app themselves, give them the real
  **packaged** app — `cd desktop && npm run dist:mac`, then just **launch it in place on this Mac**:
  `open desktop/release/mac-arm64/Arbiter.app`. No need to wrap or deliver a `.dmg` — it's the same
  machine (and the DMG is too big to send anyway); only build/deliver a DMG if the owner needs it on
  another machine. NEVER substitute the dev launch (`npx electron .`), the CDP drive-validation
  harness, or the web env for a desktop user check — those aren't the packaged artifact users run.
  This is a test build, NOT a release: building to test ≠ shipping (above), so it needs no ship
  authorization. (My own CDP drive-validation stays how *I* verify; it is not a user check.)
- **Two desktop channels — "deploy dev" vs "ship".** A **beta (dev) channel** lets the owner test the
  packaged app without touching prod. **"deploy dev"** (or "deploy to the dev/beta channel") = publish a
  `x.y.z-beta.N` **pre-release** (GitHub never marks it "Latest"; emits `beta.yml`/`beta-mac.yml`;
  diagnostics telemetry ON). Plain **"ship"/"deploy"** = a stable `x.y.z` release (marked "Latest";
  telemetry OFF). Beta is opt-in per client (Settings → Diagnostics → "Beta updates"), so stable users
  never receive dev builds. Both still require explicit authorization and the Step-0 snapshot check.
- **The how-to** — deploying to the web test env, the desktop dev loop, and cutting a release (stable or
  dev) — lives in [`docs/dev-notes.md`](docs/dev-notes.md) and [`docs/release-runbook.md`](docs/release-runbook.md).
  This section is the policy; those are the mechanics.

## Database: user data vs market data

The DB is split (IMPLEMENTED 2026-09-14) into **`user.sqlite`** (persist forever, migrate
carefully — settings, capital, session, watches; `backend/app/migrations_user.py`) and
**`market.sqlite`** (disposable financial/operational data, seeded from a gzipped snapshot
bundled in the binary at build time, replaced wholesale on newer snapshots, and caught up to
now by the watermark-driven crawl). The split is invisible to users: a seeded install shows a
populated board instantly and only the loading orb (driven by `/api/backfill`) ever surfaces
real work. Highest-level rules:

- **Never lose user data; never blow away user data.** Market data is disposable and rebuildable.
- Adding **user** schema → write a numbered migration. Adding/changing **market** schema → bump
  the snapshot version and ship a new snapshot (no migration).
- New `kv` keys must be classified (user vs operational) in `db.py`.
- **⚠️ If you change the DB on the DATA (market) side in ANY way — a table, a column, a kv
  routing rule, a file/path, the split layout — you MUST verify snapshot generation still
  works against the change.** The seed exporter (`ops/export-market-snapshot.py` +
  `ops/publish-market-snapshot.sh`, run by shazam's root cron) reads the live DB directly and
  is easy to silently break: the DB split moved market data to `market.sqlite` and operational
  kv to `kv_ops`, but the exporter still pointed at the legacy `poe2arb.sqlite` / `kv` table,
  so the bundled seed silently froze until fixed. After any market-side change, run the
  publisher on shazam (`sudo /home/shazam/bin/publish-market-snapshot.sh`) and confirm the
  `market-seed-latest` GitHub asset's version advances. Seeds ship to desktop builds **only**
  via that GitHub release (Windows CI + the Mac build both pull it); the LAN `/downloads`
  channel is gone. The exporter derives each seed table's DDL from the live DB and takes its
  table list + retention from `backend/app/datapolicy.py` — the ONE definition of user-vs-market
  kv keys and market retention (`db.py`, `migrations_user.py` and the exporter all import it).

Full design + rules + implementation plan live in `docs/`:
- [`docs/db-architecture.md`](docs/db-architecture.md) — design & data classification.
- [`docs/db-maintenance.md`](docs/db-maintenance.md) — how to evolve each DB going forward.
- [`docs/db-split-handoff.md`](docs/db-split-handoff.md) — the historical build plan (done 2026-09-14).

## Design philosophy — an ecosystem, not a ball of dashboards

New capabilities must knit into a single harmonious app, NOT each become another page. A
"big ball of dashboards and mud" is the failure mode to avoid. Before building a feature,
decide the RIGHT surface for it — most are not a new page:

- **Time-sensitive discovery** ("what's about to move", a fired signal) → a **notification /
  inbox** entry. Clicking it opens the SAME graph/metric UI the dashboard already uses
  (reuse `CardDetail`), never a bespoke page.
- **A signal that improves another feature** (e.g. exchange-graph **centrality** informing
  which routes/bridge currencies to suggest, or priming "what propagates") → a **background
  signal** feeding existing tools, not a visible tab.
- **An enrichment** ("can I cash out?", realizable-vs-paper value, cheap-vs-history) → a
  **badge / column / section** on an existing view (Board, `CardDetail`, Capital), not a
  standalone screen.
- Give something its **own sub-tab only** when it's a genuinely distinct primary workflow
  (as Hold and Arbitrage are).

**⛔ Restraint — cut, don't clutter (owner directive 2026-09-17).** The app must look nice and
streamlined; nothing on screen may distract the user.
- **Ruthlessly cut UI that isn't used.** A control that no longer drives anything, a status for a
  retired feature, a legend nobody acts on — delete it in the same change that made it useless.
- **Don't propagate logic decisions to the view.** Which algorithm ran, which source won, what was
  filtered or judged implausible, how a pricing currency was chosen — that is OUR business. Do the
  work in the backend; give the view the answer, not the reasoning.
- **Present the information the user requires and nothing more.** Required = the value, its unit,
  and what it is measured against when that isn't obvious. Provenance, counts, diagnostics and
  caveats go to docs, logs and beta telemetry — never the screen. Depth belongs one level down
  (zoomed card / expanded row), not on the base card.
- A new rule gets a **setting with a sane default**, not an on-screen narration of what it did.
Full statement in [`docs/ui-styleguide.md`](docs/ui-styleguide.md) → "§0 Restraint".

Rules of thumb: **reuse UI relentlessly** — new data flows into existing components
(`CardDetail`, board sparkline/graph, chips, capital card) first. Features should cross-link
and share data through the fewest new surfaces. Think ecosystem, not screens.

## Heavy analytics: a local sidecar runtime, not a bloated binary

The stdlib-bias keeps the MAIN backend binary lean. When a capability genuinely needs a heavy
library (graph algorithms via `networkx`, time-series motif/anomaly via `STUMPY`, DTW via
`dtaidistance`, pattern mining), **do NOT reimplement it and do NOT bloat the main binary.**
Run it in a **separate bundled local runtime** (its own process + its own deps), bundled
per-platform and spawned locally exactly as the app already spawns the PyInstaller backend.

**Transport = SQLite, not a network layer** (decided via arena + owner steer). No loopback
server, no port, no socket. Instead:
- The sidecar reads `market.sqlite` **read-only** (WAL → concurrent readers) for BULK input, so
  large series/matrices never cross a channel.
- Sidecar → backend results/events flow through a **dedicated SQLite table** (an outbox/queue
  pattern; evaluate an existing SQLite-backed queue/event library rather than hand-rolling —
  per "use libraries, don't reimplement"). The sidecar is the sole writer of that table; the
  backend reads it. Backend → sidecar control (job triggers) is symmetric (a jobs row it polls).
- Endpoints only ever READ the cache table, so the sidecar can never take down a request
  (graceful degrade when it's down).

**Lifecycle:** the sidecar is the backend's child (supervision tree Electron → backend →
sidecar). It dies on the backend's exit; guarantee no-dangling with a **PARENT_PID watchdog**
(retrofit the same watchdog to the backend — today it can dangle on a hard Electron crash).

This preserves the DESKTOP CONTRACT: the sidecar is LOCAL, bundled per-platform like the
backend — NOT a remote call. (If "internal-network"/LAN access is ever intended for a shared
analytics service, that changes the contract and must be confirmed explicitly first.)

## Porting library code: port the tests first

When you PORT/vendor a piece of an open-source library (rather than pip-installing it as a
dep), **port that code's TESTS for the piece first, watch them fail, then port the code** until
they pass. Never port implementation without its tests. This keeps vendored algorithms faithful
to their upstream behavior and is TDD applied to porting.

## Layout

- `backend/` — FastAPI + SQLite (`run_desktop.py` is the local-mode entrypoint; reads
  `DATA_DIR`/`PORT` env). Prices for every traded currency thread through
  `arbitrage.Graph.ref_values()` (exchange graph + poe2scout fallback); `arbitrage/` is a
  package (graph / routes / convert / board behind one facade). Shared vocabulary lives in
  `marketseries.py` (anchors, window→days, day helpers) and `datapolicy.py`.
- `frontend/` — React/Vite/Recharts. `desktop/` — Electron shell (local UI server + bundled
  backend manager + updater). `docs/` — architecture & maintenance docs.

A **detailed module-by-module map** (and the dev loop, gotchas, testing, and settings-feature
checklist) is in [`docs/dev-notes.md`](docs/dev-notes.md) — read it before touching code.
