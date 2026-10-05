# Cutting a desktop release — runbook

How to ship a new Arbiter desktop version to both platforms. Read alongside the desktop
contract and the deploy section in [`../CLAUDE.md`](../CLAUDE.md).

## The model

The version lives **only** in `desktop/package.json` (`"version"`). Bumping it and running
`desktop/publish-github.sh` is what drives everything: the script builds into a **draft**
release and publishes it once every file is verified — publishing is what creates the
`desktop-v<version>` tag (no tag is pushed up front; see step 5). Both platforms update from
**GitHub Releases**; the app reads its manifest off the `desktop-v<version>` release GitHub
marks "Latest":

- **macOS** reads `latest-mac.yml`
- **Windows** reads `latest.yml`

Windows builds in **CI** and uploads its assets to the release directly. Mac builds + uploads
**locally** (PyInstaller can't cross-compile) via `publish-github.sh`, into the same release.
Installer names are space-free (`nsis.artifactName`) so the yml url, the on-disk file, and
the GitHub asset all match — otherwise GitHub rewrites spaces to dots and the updater 404s.

## Two channels: stable and beta (dev)  — "deploy dev"

There are **two update channels**, so we can iterate on the packaged app WITHOUT testing in prod:

| Channel | Version form | GitHub release | Manifests | Who gets it | Diagnostics telemetry |
|---|---|---|---|---|---|
| **stable** | `x.y.z` | marked **Latest** | `latest.yml`, `latest-mac.yml` | everyone (default) | **off** |
| **beta (dev)** | `x.y.z-beta.N` | **pre-release** (never Latest) | `beta.yml`, `beta-mac.yml` | only clients opted into beta | **on** |

- **Opt in (client side):** Settings → Diagnostics → **"Beta updates (dev channel + diagnostics telemetry)"**.
  That persists `betaChannel` in `desktop-settings.json`; `main.js` then sets `autoUpdater.channel='beta'`
  + `allowPrerelease=true`. A build that is *itself* a `-beta` version forces the beta channel on
  (`locked`). Diagnostics telemetry (`p=backend`, `p=sidecar`, the `/api/diag.analytics` probe) fires
  **only** on the beta channel or an unpackaged dev run — gated by `diagTelemetryOn()` in `main.js`
  (which passes `ARBITER_TELEMETRY=1` to the backend→sidecar). Stable builds are silent.
- **Isolation:** beta releases are GitHub **pre-releases**, so `releases/latest` never points at them and
  stable clients (`allowPrerelease=false`, `channel='latest'`) never pull them. Safe to push freely.

### "deploy dev" — publish a beta build
When the owner says **"deploy dev"** (or "deploy to the dev/beta channel"), cut a **pre-release** with a
`-beta.N` version — same mechanics as a stable release, three differences:
1. **Version:** set `desktop/package.json` to `x.y.z-beta.N` (bump `N` per dev push).
   ⚠️ electron-builder does **not** auto-name the channel from the prerelease tag — it always writes
   `latest.yml`/`latest-mac.yml`. Both build paths therefore **rename** it to `beta.yml`/`beta-mac.yml`
   for a `-beta` version (Win CI after `electron-builder`; `publish-github.sh` after `dist:mac`), so a
   beta build emits ONLY the beta manifest and never disturbs stable's `latest*.yml`.
2. **Tag:** the **bare semver** `x.y.z-beta.N` (⚠️ NOT `desktop-v…`). electron-updater's GitHub
   provider parses the tag as semver on the prerelease/channel path (`if (!semver.valid(hrefTag))
   continue`), so a `desktop-v` prefix makes it skip every release → "No published versions on
   GitHub". Stable keeps `desktop-v*` (that path resolves via `/releases/latest`, a literal tag
   match, no semver check). `publish-github.sh` picks the tag automatically from the version; CI
   triggers on both `desktop-v*` and `*-beta.*`. The Windows CI marks it **pre-release**
   (`contains(ref,'-beta')`), renames + uploads `beta.yml`; `publish-github.sh` uploads `beta-mac.yml`;
   the crash gate still runs.
3. **Snapshot rule still applies** (Step 0) — a dev build with stale market data still shows wrong data
   to the tester (you). Ask first.

Verify a dev release resolves on the beta channel:
```
gh release view desktop-v<x.y.z-beta.N> --json isPrerelease,assets \
  -q '{prerelease:.isPrerelease, files:[.assets[].name]}'   # isPrerelease:true, beta.yml + beta-mac.yml present
```
Then read `p=sidecar` / `p=backend` telemetry once the tester's app updates.

**Promote beta → stable:** when a dev build is good, cut the SAME code as a plain `x.y.z` stable release
(no `-beta`). Besides the version, a stable release adds one file:

- **Release notes** (owner, 2026-10-04): write `docs/release-notes/<x.y.z>.md` following
  [`docs/release-notes/STYLE.md`](release-notes/STYLE.md), from the commits since the last stable release.
- **Show the owner the draft and wait for their OK** before running the publish.
- After every correction, ask whether it generalises, and add the rule to STYLE.md's "Lessons" section.
- **Before anything is pushed,** `publish-github.sh` refuses a stable release unless all three hold:
  - the notes are good;
  - the notes are committed;
  - shazam's feedback bot accepts the announcement (`ops/announce.sh check`). If it doesn't, run
    `./ops/deploy-web.sh bot` first.
- **Once the release is live,** `ops/announce.sh` confirms it (GitHub's Latest; every installer downloadable,
  checked by `release-assets.mjs verify --live`). It hands the notes to the bot and waits until the bot reports
  the post in Discord `#releases`, tagging `@notifier`.
- **If the post isn't confirmed,** the release only warns: it's already live. Re-run the announcement by hand
  with `ops/announce.sh desktop-v<x.y.z>`; the bot never posts a version twice.

## ⚠️ Regression gate — enforced by `publish-github.sh` (owner, 2026-09-30)

`publish-github.sh` runs `ops/regression-diff.py` right after the test gate, before anything remote. It
runs the last stable version (the newest `desktop-v*` tag) and the release's code on one snapshot of the
owner's desktop data, and diffs what users see:
- every currency's value, busiest market and price card;
- the Economy -> Market table;
- Hold at 1d / 3d / 7d;
- every exchange-only loop the route search finds;
- the Arbitrage pool;
- a fixed set of Convert pairs.

The script stops the release on any difference that `ops/regression-accept.txt` doesn't accept.
- The acceptance is valid only for the exact `version:` it names.
- Every line in it must still match a reported difference, so a stale line blocks too.
- It fails closed when the data is missing or too thin to compare.

For each release, write the accept file for its version:
1. Run `python3 ops/regression-diff.py` to see the differences.
2. Accept only the ones the change intends, with a comment saying why.
3. Tell the owner what was accepted.

Its tests are `backend/tests/test_regression_gate.py`, which also pins the gate's place in the script.

**Why:** 0.3.8-beta.1/2 (crafting recipes) passed every test and moved 17 prices by up to 4300%. The
tests checked the new feature, never what must not change. With 0.3.8-beta.3's acceptance, this gate
blocks beta.2's code with 106 unaccepted differences.

## ⚠️ T0 gate — a full-sync fallback on beta blocks stable (owner directive 2026-09-25)

A client rebuilding market data it should have received from the seed (seed failed or
unreadable, DB left unseeded, digest starting from scratch, a league refetched wholesale, no mod
tables with a seed bundled) is a T0 blocker. Beta clients detect it themselves and post one line,
`[T0]: <kind>: …`, on the beta telemetry log (`backend/app/devtelemetry.py` → `T0_KINDS`).
`publish-github.sh` runs `ops/t0-check.sh <x.y.z>` before any **stable** release: it reads the log
on shazam through `ops/t0-scan.py` for the version's beta line since the latest beta went live and
refuses on a blocker. It also refuses when **no** beta client has reported a healthy startup
(`[mods]: … pools=N>0`) since then: silence is not validation. It fails closed (no ssh, no beta).
Read the state by hand: `ops/t0-check.sh 0.3.6`, or the summary
`python3 /tmp/t0-scan.py --log data/install-reports.log` on shazam, run through `sshshazambom`.
Why: the 2026-09-25 Windows seed failure (`docs/bugs/2026-09-25-windows-seed-never-applied.md`)
was a silent fallback for weeks; on stable it would have surfaced as a bug report, which is a failure.

## ⚠️ Step 0 — ALWAYS ASK: does this release need a fresh market snapshot?

The desktop app bundles a **market snapshot** at build time (`desktop/market-seed/`, fetched
from the `market-seed-latest` GitHub release). Clients seed their `market.sqlite` from it. If a
release changes **what the snapshot should contain or how market data is derived/keyed**, the
snapshot is STALE and must be rebuilt + republished FIRST, then bundled in this release (a
matched pair) — otherwise clients ship with wrong/old market data until (if ever) their own
crawl heals it.

**Rebuild the snapshot before shipping when the change touches:**
- currency mapping / how digest markets are keyed (e.g. the `meta_bridge`),
- digest/market ingestion or parsing,
- any market-side schema, or a new **operational kv** the client should have at boot,
- anything where "wait for the client's crawl to self-heal" is not good enough.

**Skip it only for** pure UI / user-side / backend-logic changes that don't change snapshot
contents. **When in doubt, rebuild** — it's cheap and a stale snapshot ships wrong data.

Order matters (avoid a Mac/Windows snapshot mismatch): **publish the new snapshot to
`market-seed-latest` BEFORE pushing the `desktop-v*` tag**, so both the Windows CI and the local
Mac build fetch the same fresh snapshot. Publish it only from a **caught-up** server (the
exporter's mid-sync guard enforces this): the publisher (`ops/publish-market-snapshot.sh`) through `sshshazambom sudo`.

> Lesson (2026-09-15): shipped desktop-v0.2.44 (the currency-mapping bridge fix) bundling the
> pre-fix snapshot because this question wasn't asked. The fix lived in an operational kv
> (`meta_bridge`) that rides the snapshot — so the snapshot needed rebuilding even though there
> was no schema change. Patched via desktop-v0.2.45.

## ⚠️ Before you run `publish-github.sh` — the traps that have caught us

Check these every time; each one has cost a deploy before. (The general rules every deploy playbook follows are in
[`dev-notes.md`](./dev-notes.md) → "Deploy rules — every playbook".)
- **Node 22+ on PATH.** The test gate globs `"frontend/test/*.test.mjs"`, which only Node ≥ 22 expands; an nvm
  Node 18 first on PATH fails the gate with "Could not find …" before a single test runs. Run the script as
  `PATH=/opt/homebrew/bin:$PATH ./publish-github.sh`.
- **`desktop/release/` is shared by every Mac build.** `publish-github.sh`, `dist:mac` and a test app launched
  from `release/mac-arm64/Arbiter.app` all use it. Stop any test build or test run first; let the script build;
  test *that* build only once the log says `watching Windows CI run` (the Mac half is done and `release/` is
  stable while CI runs).
- **The regression accept file is for exactly one version.** Set its `version:` line to the new version and
  drop the previous release's lines (a stale line fails the gate). A release that changes no user-visible data
  has an accept file with only its `version:` line.
- **Version and tag:** a beta is `x.y.z-beta.N` in `desktop/package.json` (bare-semver tag); stable is `x.y.z`
  (tag `desktop-v…`). Bump, commit on `main`, then run — the script pushes `main` itself.
- **Run it in the background and wait on its own lines**, anchored to the line start: `^watching Windows CI run`,
  `^release .* is live`, `^FATAL`, `^EXIT`. Never match loose words (a test's name contains "missing"), and never
  chain sleeps.
- **A local `-beta` build forces the beta channel**, so its diagnostics telemetry is on — useful for checking the
  release build itself while CI runs.

## Steps, in order

1. **Pre-flight (before committing).** Confirm no leftover debug/test scaffolding in the
   diff:
   - env-gated drive routines (`LIVE_DEBUG` / `TAB_TEST` / `RESTORE_TEST` / `LIVETREE_TEST`
     / `ARM_ONLY`) are removed from `desktop/src/main.js`.
   - trace logs stay behind `dlog` / `TRADE_DEBUG` (failure logs may stay always-on); no
     stray always-on `console.log('[trade]…`.
   - the DEV-only `__arbiterTestPing` hook stays behind `import.meta.env.DEV`.
   - fuzz suites pass:
     - `node frontend/test/workspace-store.fuzzy.mjs`
     - `DATA_DIR=$(mktemp -d) MARKET_SEED= desktop/.venv-build/bin/python backend/tests/test_workspace_fuzzy.py`

2. **Bump** `desktop/package.json` version.

3. **Commit** on `main`. Releases are cut from main — every `desktop-v*` tag is on main.

4. **Rebuild the Mac backend only if `backend/app` changed** since the last tag. Check
   `git diff desktop-v<prev> HEAD -- backend/app`; if empty, the bundled
   `backend-bin/poe2arb-backend` is current and you may skip. When in doubt rebuild:
   `desktop/build-backend.sh` (~1–2 min; needs local python3.12 → `.venv-build`). The
   Windows CI **always** rebuilds its own backend `.exe` on the runner regardless.

   **Also rebuild the Mac analytics SIDECAR** (`desktop/build-sidecar.sh`, ~1 min → `sidecar-bin/`)
   when `backend/sidecar/**`, `backend/app/marketseries.py`, or `backend/requirements-sidecar.txt`
   changed since the last tag. It's a SECOND per-platform PyInstaller binary (numpy/stumpy, ~73 MB)
   bundled via `sidecar-bin` extraResources; the Windows CI builds its own `.exe`. `dist:mac`/
   `publish-github.sh` bundle whatever is in `sidecar-bin/`, so it must exist and be current.

   > **Build everything as one packaged app.** `npm run dist:mac:all` chains
   > `build:backend` + `build:sidecar` + `build:frontend` + `electron-builder --mac`, producing one
   > `Arbiter.app` whose `Contents/Resources/` holds `backend-bin/`, `sidecar-bin/`, `market-seed/`,
   > and the frontend `app.asar` — the single double-clickable artifact users run. Use it for a
   > from-scratch build; use the individual `build:*` scripts when iterating. (`dist:mac` alone
   > packages whatever binaries already exist in `backend-bin/`/`sidecar-bin/`.)

   > Workspace fields like `activeId` / `armed` are stored inside the `trading_workspace`
   > JSON blob, which the backend persists opaquely — new fields need **no backend change
   > and no migration**. Adding/altering an actual DB **table/column** does (user → numbered
   > migration; market → new snapshot). See the Database section in CLAUDE.md.

5. **Publish (one command, test-gated, event-driven, atomic go-live):**
   ```bash
   cd desktop && ./publish-github.sh   # tests → push main → DRAFT release → dispatch Windows CI →
                                       # dist:mac → waits on CI → uploads Mac assets →
                                       # verifies both platforms → publishes → re-checks → (rollback)
   ```
   `publish-github.sh` first runs `ops/run-tests.sh` (a red test aborts here, before anything
   remote), pushes `main`, creates the release as a **draft** targeting that commit, and starts
   `.github/workflows/release-desktop-win.yml` with `gh workflow run -f tag=… -f sha=…`. **No tag is
   pushed**: the tag (`desktop-v<version>`, or the bare `<version>` for a beta) is created by GitHub
   when the draft is published, because `releases.atom` — what beta clients read — lists bare tags,
   and a tag pushed up front left them chasing an unpublished manifest for the whole build. The
   workflow is dispatch-only (a tag push no longer starts anything); it builds the Windows installer +
   backend/sidecar `.exe` with the SAME `desktop/build-*.sh` scripts and uploads
   `Arbiter-Setup-<v>.exe` + `latest.yml` **into the draft**. Meanwhile it fetches the seed and runs
   `dist:mac`, blocks on `gh run watch` until CI finishes, then uploads the Mac assets into the
   same draft. Pass `--no-build` if `release/` already holds the current build. (The
   `nsis.artifactName` override keeps the installer name space-free so the yml url, the on-disk
   file and the GitHub asset all match — otherwise GitHub rewrites spaces to dots and the updater 404s.)

   **Why a draft:** a draft is invisible to electron-updater and never becomes "Latest", so no
   client can be told about an update whose files aren't there yet (the 0.2.60 incident —
   `docs/bugs/2026-09-17-release-publish-not-atomic.md`). Both halves upload through ONE tool,
   `desktop/scripts/release-assets.mjs`:
   - `upload` — installers first, **manifests (`*.yml`) last**; clears half-created (`starter`)
     assets; streams each file itself and **cuts a connection whose speed collapses** (under
     300 KB/s averaged over 30 s — `RELEASE_MIN_KBPS` / `RELEASE_STALL_WINDOW_MS`) to retry on a
     fresh one, up to 6 tries (20-min hard cap each); success = GitHub's own sha256 of the asset equals
     the local file (never `gh`'s exit code — it has lied both ways).
   - `publish` — refuses unless every file named by both channel manifests **and the Mac DMG**
     (the Mac in-app update opens the DMG, not the zip) is `uploaded` at the manifest's size; flips
     the draft public; re-checks every public URL for a 200; **re-drafts automatically** if that
     fails, so clients stay on the previous version.
   A re-run of `publish-github.sh --no-build` after any failure is safe: finished files are skipped.

6. *(folded into step 5.)*

7. **Verify the release went live** (step 5 already did this; to re-check any release by hand):
   ```bash
   node desktop/scripts/release-assets.mjs verify desktop-v<version> --live   # or <version>-beta.N
   gh api repos/Shazambom/shazam-poe2-dashboard/releases/latest -q .tag_name  # == desktop-v<version> (stable)
   ```
   The release must be GitHub's "Latest" and carry both `latest-mac.yml` + `latest.yml` plus
   the installers — that is what the `github` updater provider resolves against. A `404` in the
   live check means the installer name and the yml url disagree.

8. **Audit the deploy — every deploy, beta or stable.** Before reporting it done, look back over the session:
   - Did any gate fail, any step retry, any wait or command need a second try?
   - Did anything need a manual fix, a workaround, or a guess? Did anything take far longer than expected?
   - Did the release run into other work (a test build, a running app, another script)?
   For each "yes", write one **condensed, general** lesson into "Lessons from deploys" below: dated, one or two
   lines, phrased as a rule for next time (not a story of this one). If the lesson is a check, also add it to
   "Before you run" above. If nothing went wrong, say so in the report — no entry needed.

### If a release goes wrong

- **An upload hangs or 500s** (`Error saving asset`): nothing is exposed — the release is still a
  draft. Re-run `./publish-github.sh --no-build` (or re-run the failed CI job); the tool deletes the
  half-created asset and retries. By hand: `gh api repos/<repo>/releases/<id>/assets` → any
  `state: starter` → `gh api -X DELETE repos/<repo>/releases/assets/<asset-id>`.
- **A manifest is live without its file** (should be impossible now): **delete the manifest first,
  fix second.** Removing `latest*.yml` / `beta*.yml` makes clients see "no update" and stay put;
  or `gh release edit <tag> --draft=true` to pull the whole release. Then upload, `verify`, restore.
- **Two drafts share a tag** (`ensure-draft` refuses): delete the stray one in the GitHub UI.

## Lessons from deploys

- **2026-10-05, 0.3.14: the regression gate needs current local market data, and acceptances go stale.**
  - **Stale data:** no app had run on the Mac for 8h, so the digest rates were past `digest_max_age_h`. The gate saw
    0 market rows and 0 loops, and failed closed with "too little data". Fix: open the app, wait until `/api/status`
    shows the digest caught up (`behind_h` under 1), quit it, then run the gate.
  - **Stale acceptances:** with fresh data the beta's `hold *` acceptance matched nothing, and the gate rejects
    stale lines. Re-run the diff for the new version and trim the accept file to what it reports today.

- **2026-10-05, 0.3.14-beta.1: the regression gate runs on the owner's real settings, which dev builds may already
  have migrated.** A dev build's m8 saved Balanced (volume window 72h) into the owner's data. Stable 0.3.13 then
  priced every screen over 72h, while the release keeps the market at 24h, so the gate reported 105 price, market and
  Hold differences. To tell a real regression from a settings artefact, re-run `ops/regression-diff.py --data <copy>`
  on a copy with the setting reset to its default. Here the copy showed NO DIFFERENCES. Accept with that evidence in
  the comment. To read a WAL database copy read-only, set its `journal_mode` to DELETE first.

Condensed and general, newest first; each came from a post-deploy audit (step 8).

- **2026-10-05 (0.3.13-beta.1):** the EE2 port sync at the top of `publish-github.sh` can bring a new GGG
  `stats.json`, and the Regex tab's drift test (`regex-data.test.mjs`, "the GGG snapshot changed") then fails the test
  gate before anything is pushed. Fix: `cd frontend && node scripts/sync-regex-data.mjs`, review the diff (usually only
  `MANIFEST.json`'s `sourceSha256`; a change to `waystone.json`/`tablet.json` changes what players see, so read it),
  commit, and re-run the publish. The sync commit stays; the re-run reuses it.
- **2026-10-04 (0.3.12-beta.2):** the Windows build shipped with no market snapshot. shazam's cron was replacing
  `market-seed-latest` while CI downloaded it, so only the `.version` sidecar arrived, and the CI step checked nothing.
  Both platforms now fetch through `desktop/fetch-seed.sh` (it retries until a valid snapshot is there, else fails).
  `publish-github.sh` refuses a CI run whose log lacks its `seed ready (` line. After every beta, confirm each
  platform's first telemetry says `[seed]: replacing local …`, never `no seed bundled`.
- **2026-10-04 (0.3.12-beta.3):** in a `set -o pipefail` script, never pipe a long output into `grep -q`: grep exits at
  the first match, the writer gets SIGPIPE, and the pipeline "fails" on success. Save the output to a file, then grep it.
  A check that only runs when CI was dispatched also skips on a `--no-build` re-run; checks run on every path.

- **2026-10-03 (0.3.11-beta.1):** a deploy requested mid-testing collides with any test build or app running from
  `release/`. Stop the testing, cut the release, and resume testing on the release's own build once the log says
  `watching Windows CI run`.
- **2026-10-03 (0.3.11-beta.1):** wait on the script's own anchored lines. A loose match ("missing") hit a test name
  in the gate's output and started the next step before the Mac build was done.

