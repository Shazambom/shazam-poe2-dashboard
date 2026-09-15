# Cutting a desktop release — runbook

How to ship a new Arbiter desktop version to both platforms. Read alongside the desktop
contract and the Windows auto-publish section in [`../CLAUDE.md`](../CLAUDE.md).

## The model

The version lives **only** in `desktop/package.json` (`"version"`). Bumping it and pushing
a `desktop-v<version>` tag is what drives everything. As of 0.2.38 both platforms update
from **GitHub Releases** (electron-builder's `publish` target is `github`); the app reads
its manifest off the `desktop-v<version>` release GitHub marks "Latest":

- **macOS** reads `latest-mac.yml`
- **Windows** reads `latest.yml`

Windows builds in **CI** and uploads its assets to the release directly. Mac builds + uploads
**locally** (PyInstaller can't cross-compile) via `publish-github.sh`, into the same release.

> **0.2.38 bridge only:** 0.2.38 is ALSO mirrored to shazam `/downloads` (run `./publish.sh`)
> so users on ≤0.2.37 — whose updater still points at shazam — can pull it. Drop that step
> from the next release; the shazam channel + cron poller retire after 0.2.38.

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
   to the `desktop-v<version>` GitHub Release.

6. **Build + publish Mac locally:**
   ```bash
   cd desktop && npm run dist:mac   # → release/Arbiter-<v>-arm64.dmg + .zip + latest-mac.yml
   ./publish-github.sh              # upload Mac assets into the same desktop-v<v> release
   ./publish.sh                     # 0.2.38 BRIDGE ONLY — mirror to shazam /downloads (drop next release)
   ```

7. **Verify the release went live:**
   ```bash
   gh release view desktop-v<version> --json isLatest,assets \
     -q '{latest:.isLatest, files:[.assets[].name]}'   # isLatest:true + both latest*.yml + installers
   gh run list --workflow=release-desktop-win.yml --limit 1   # Windows CI: success
   # Bridge check (0.2.38 only): shazam still serves the old channel for ≤0.2.37 users
   curl -s http://192.168.1.250:8080/downloads/latest-mac.yml | head -3
   ```
   `gh release view` must show `isLatest: true` and both `latest-mac.yml` + `latest.yml`
   among the assets — that is what the `github` updater provider resolves against.

## Gotcha — `publish.sh` clobbers the Windows `latest.yml` (bridge only)

`publish.sh` (the retiring shazam mirror, used only for the 0.2.38 bridge) rsyncs `latest*.yml`
from the local `release/`, which includes a **stale local `latest.yml`** left over from an old
local `dist:win`. It overwrites shazam's Windows manifest until the next cron tick re-heals it
from the GitHub release. Harmless (electron-updater never downgrades; self-corrects in ≤5 min),
and moot once the shazam channel is gone. The GitHub release itself is never affected.
