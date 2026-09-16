# Cutting a desktop release — runbook

How to ship a new Arbiter desktop version to both platforms. Read alongside the desktop
contract and the deploy section in [`../CLAUDE.md`](../CLAUDE.md).

## The model

The version lives **only** in `desktop/package.json` (`"version"`). Bumping it and pushing
a `desktop-v<version>` tag is what drives everything. Both platforms update from **GitHub
Releases** (electron-builder's `publish` target is `github`); the app reads its manifest
off the `desktop-v<version>` release GitHub marks "Latest":

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
(no `-beta`). Nothing else changes.

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
exporter's mid-sync guard enforces this): `sshshazambom sudo bash /home/shazam/bin/publish-market-snapshot.sh`.

> Lesson (2026-09-15): shipped desktop-v0.2.44 (the currency-mapping bridge fix) bundling the
> pre-fix snapshot because this question wasn't asked. The fix lived in an operational kv
> (`meta_bridge`) that rides the snapshot — so the snapshot needed rebuilding even though there
> was no schema change. Patched via desktop-v0.2.45.

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

5. **Tag + push both:**
   ```bash
   git tag -a desktop-v<version> -m "Desktop v<version> — <summary>"
   git push origin main && git push origin desktop-v<version>
   ```
   The tag push triggers `.github/workflows/release-desktop-win.yml` — it builds the
   Windows installer + backend `.exe` and attaches `Arbiter-Setup-<v>.exe` + `latest.yml`
   to the `desktop-v<version>` GitHub Release. (The `nsis.artifactName` override keeps the
   installer name space-free so the yml url, the on-disk file, and the GitHub asset all match
   — otherwise GitHub rewrites spaces to dots and the updater 404s.)

6. **Publish Mac locally (one command, event-driven):**
   ```bash
   cd desktop && ./publish-github.sh   # builds Mac, WAITS on the Windows CI run (gh run watch),
                                       # then uploads Mac assets into the same desktop-v<v> release
   ```
   `publish-github.sh` does the whole local half: it runs `dist:mac`, finds this tag's Windows
   CI run, blocks on `gh run watch` until it finishes (no polling), then uploads. Pass
   `--no-build` if `release/` already holds the current build.

7. **Verify the release went live:**
   ```bash
   gh api repos/Shazambom/shazam-poe2-dashboard/releases/latest -q .tag_name  # == desktop-v<version>
   gh release view desktop-v<version> --json assets -q '[.assets[].name]'     # both latest*.yml + installers
   # Naming sanity: the yml url must resolve on GitHub (dash-form, not dots)
   B=https://github.com/Shazambom/shazam-poe2-dashboard/releases/download/desktop-v<version>
   curl -s -o /dev/null -w '%{http_code}\n' -L "$B/$(curl -fsSL "$B/latest.yml" | awk '/^path:/{print $2}')"
   ```
   The release must be GitHub's "Latest" and carry both `latest-mac.yml` + `latest.yml` plus
   the installers — that is what the `github` updater provider resolves against. The curl must
   print `200` (a `404` means the installer name and the yml url disagree).
