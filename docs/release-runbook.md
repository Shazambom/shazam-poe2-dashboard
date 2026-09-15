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
