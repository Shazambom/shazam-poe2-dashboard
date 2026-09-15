# Arbiter — project contract

## ⛔ HIGHEST-IMPORTANCE RULE — the desktop contract

**DESKTOP APPS MAY ONLY CALL THE SERVER FOR UPDATES. NOTHING ELSE.**

The desktop app (Arbiter, `desktop/`) is **fully self-contained**: it ships its own
backend (PyInstaller binary in `backend-bin/`, bundled via `build.extraResources`) and
its own local SQLite DB (in the OS user-data dir). Every `/api` request is served by
that **bundled local backend on 127.0.0.1** — never a remote server.

The **only** permitted outbound calls are the **auto-updater** and **update telemetry**:
- Auto-updater: electron-updater's `github` provider reads `latest*.yml` + installers from
  **GitHub Releases** (`Shazambom/shazam-poe2-dashboard`, the `desktop-v<ver>` tag GitHub
  marks "Latest"). No token needed (public repo). See the deploy section below.
- Update telemetry: `updLog()` still POSTs to `…/api/installlog?p=update` on shazam (the
  sanctioned diagnostic exception, "telemetry only" — never data/metrics).

Consequences to preserve in any change:
- Never route `/api`, session, board, routes, prices, telemetry, etc. to the remote
  server from a *packaged* desktop build. `startBackend()` in `desktop/src/main.js` is
  local-only; the only non-local branch is a `!app.isPackaged` DEV convenience.
- Every platform must bundle a backend built **on that platform** (PyInstaller can't
  cross-compile): macOS backend via `desktop/build-backend.sh` (built locally on the
  Mac); Windows backend via the GitHub Action (`.github/workflows/release-desktop-win.yml`,
  which PyInstaller-builds `poe2arb-backend.exe` on `windows-latest` before packaging).
- Do NOT build the Windows installer locally on the Mac — it would bundle the Mac
  backend binary. Windows ships through CI only. Mac ships locally.
- Any new feature that needs data must work against the local backend + local DB
  (which backfills poe2scout on first run), not the server.

## Deploy: publish to GitHub Releases

Apps update from **GitHub Releases** directly, and versions publish by pushing artifacts
to GitHub — the shazam server is not in the update path. One release per version, tagged
`desktop-v<ver>`, carrying BOTH platforms' assets:
- **Windows**: CI (`release-desktop-win.yml`) builds on `windows-latest` and uploads the
  `.exe`/`.zip`/`.blockmap` + `latest.yml` to the release.
- **Mac**: built + uploaded locally (PyInstaller can't cross-compile) by `desktop/publish-github.sh`,
  which drops the `arm64` dmg/zip/blockmap + `latest-mac.yml` into the same `desktop-v<ver>` release.

electron-updater's `github` provider resolves updates off GitHub's "Latest release"
pointer, so the `desktop-v*` tag name is fine (the compared version comes from the yml's
`version:` field). The `market-seed-latest` release is a **Pre-release**, so it is never
picked as "Latest".

Asset names must be **space-free** (`nsis.artifactName` → `Arbiter-Setup-<ver>.exe`):
GitHub rewrites spaces to dots on upload, which would leave the yml url and the asset name
disagreeing and the updater would 404. Keep it dash-form.

## Cutting a desktop release

Full step-by-step runbook: [`docs/release-runbook.md`](docs/release-runbook.md). TL;DR: bump
`desktop/package.json`, commit on `main`, push a `desktop-v<version>` tag (fires the Windows
CI, which builds + uploads Windows assets to the GitHub release), then
`cd desktop && ./publish-github.sh` — it builds the Mac app, waits on the Windows CI run
(`gh run watch`, event-driven, no polling), and uploads the Mac assets into the same release.
Verify the GitHub release is GitHub's "Latest" and shows both platforms' `latest*.yml` +
installers, and that the Windows installer URL resolves (not a 404 — the naming check above).

## Verifying the Windows app — telemetry is mandatory

**The user is NOT the tester. If you need to verify behavior in the Windows (or any
packaged) desktop app, you MUST build telemetry so YOU can see what's happening —
never ask the user to be your eyes.** Cross-platform desktop behavior (native modules,
OS permissions, install/update, EE2 hooks) can't be observed from this Mac, so:

- Add server-reporting telemetry to the thing you're testing, cut a build, have the
  user just *use* it, and read the results yourself from the shazam dev server
  (`GET http://192.168.1.250:8080/api/installlog`, filtered by a `?p=<tag>` marker —
  e.g. `p=login`, `p=update`, `p=ee2`).
- This is the ONE sanctioned exception to the desktop contract above. Keep it clearly
  marked as a TEMPORARY DEV DIAGNOSTIC, put it OUTSIDE contract-clean packages (e.g.
  `desktop/src/dev-ee2-telemetry.js`, not inside `integrations/`), report only what you
  need (never secrets/keystrokes/raw clipboard), and strip or gate it before a
  contract-clean release.
- Existing markers: `p=init` (installer self-heal), `p=login` (PoE/Steam login flow),
  `p=update` (auto-updater events), `p=ee2` (EE2 integration hooks).

## Debugging

This is how you debug stuff: [`docs/desktop-debugging.md`](docs/desktop-debugging.md)
— build the local desktop app, launch it with `--remote-debugging-port=9222`, and
drive the real renderer over CDP (`desktop/scripts/cdp.mjs` / `shot.mjs`) to validate
UI changes against live backend data. A passing `vite build` proves compilation, not
that the feature renders correctly — always drive the app before claiming a UI change works.

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
  the publish step**: pushing a `desktop-v*` tag (fires Windows CI → creates the GitHub release)
  and running `publish-github.sh`. Only that step is gated on authorization.
- **Web (TEST env)** — served from shazam via Docker: rsync `frontend/src` + `backend/app` to
  shazam and `docker compose up -d --build`. Fast; for validation, not delivery.
- **Desktop release (only when told to ship)**: bump `desktop/package.json`, commit, push a
  `desktop-v<ver>` tag (fires Windows CI), then `cd desktop && ./publish-github.sh` (builds Mac,
  waits on CI, uploads both platforms). Full steps: [`docs/release-runbook.md`](docs/release-runbook.md).

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
  via that GitHub release (Windows CI + the Mac build both pull it; the old `/downloads` path
  is deprecated).

Full design + rules + implementation plan live in `docs/`:
- [`docs/db-architecture.md`](docs/db-architecture.md) — design & data classification.
- [`docs/db-maintenance.md`](docs/db-maintenance.md) — how to evolve each DB going forward.
- [`docs/db-split-handoff.md`](docs/db-split-handoff.md) — **implementer start here** (the split
  is designed but NOT yet built).

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
  `arbitrage.Graph.ref_values()` (exchange graph + poe2scout fallback via
  `leaguehistory.scout_prices`).
- `frontend/` — React/Vite/Recharts.
- `desktop/` — Electron shell: local UI server + bundled backend manager + updater.
- `docs/` — architecture & maintenance docs (see the Database section above).
