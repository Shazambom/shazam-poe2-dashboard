# Cutting a desktop release — runbook

How to ship a new Arbiter desktop version to both platforms. Read alongside the desktop
contract and the Windows auto-publish section in [`../CLAUDE.md`](../CLAUDE.md).

## The model

The version lives **only** in `desktop/package.json` (`"version"`). Bumping it and pushing
a `desktop-v<version>` tag is what drives everything. Both platforms serve their update
manifest from shazam `/downloads` (`http://192.168.1.250:8080/downloads`):

- **macOS** reads `latest-mac.yml`
- **Windows** reads `latest.yml`

electron-builder's `publish` target is `generic → …/downloads`. Mac builds + publishes
**locally** (PyInstaller can't cross-compile); Windows builds in **CI** and reaches
`/downloads` via shazam's cron poller (see CLAUDE.md → "Release auto-publish").

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
   Windows installer + backend `.exe` and attaches `Arbiter.Setup.<v>.exe` + `latest.yml`
   to a GitHub Release.

6. **Build + publish Mac locally:**
   ```bash
   cd desktop && npm run dist:mac   # → release/Arbiter-<v>-arm64.dmg + .zip + latest-mac.yml
   ./publish.sh                     # rsync to shazam /downloads (code-signing-free: identity=null)
   ```

7. **Verify both channels went live:**
   ```bash
   curl -s http://192.168.1.250:8080/downloads/latest-mac.yml | head -3   # Mac: new version, immediate
   gh run list --workflow=release-desktop-win.yml --limit 1               # Windows CI: success
   curl -s http://192.168.1.250:8080/downloads/latest.yml | head -3       # Windows: new version (≤5 min)
   ```
   The shazam cron poller pulls the GH release into `/downloads` within ≤5 min — it is not
   instant.

## Gotcha — `publish.sh` clobbers the Windows `latest.yml`

`publish.sh` rsyncs `latest*.yml` from the local `release/`, which includes a **stale local
`latest.yml`** (left over from an old local `dist:win`). Running it overwrites shazam's
Windows manifest with that stale version (e.g. 0.2.34 → 0.2.18) until the next cron tick
re-heals it from the GitHub release.

- **Impact:** harmless — electron-updater never downgrades, and it self-corrects in ≤5 min.
- **But:** always verify `latest.yml` shows the new version (step 7) before declaring done.
- **Latent fix:** make `publish.sh` rsync only Mac artifacts + `latest-mac.yml` (drop the
  `latest*.yml` glob) and let the cron solely own the Windows manifest.
