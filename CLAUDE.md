# ShazamDash — project contract

## ⛔ HIGHEST-IMPORTANCE RULE — the desktop contract

**DESKTOP APPS MAY ONLY CALL THE SERVER FOR UPDATES. NOTHING ELSE.**

The desktop app (ShazamDash, `desktop/`) is **fully self-contained**: it ships its own
backend (PyInstaller binary in `backend-bin/`, bundled via `build.extraResources`) and
its own local SQLite DB (in the OS user-data dir). Every `/api` request is served by
that **bundled local backend on 127.0.0.1** — never a remote server.

The **only** permitted outbound call to our server (`http://192.168.1.250:8080`) is the
**auto-updater** (electron-updater → `/downloads`, i.e. `latest*.yml` + installers).

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

## Web vs desktop

- **Web** (served from shazam via Docker) is the cheap iteration surface: rsync
  `frontend/src` + `backend/app` to shazam and `docker compose up -d --build`.
- **Desktop** ships in deliberate batches; web-only features don't reach desktop until
  a desktop build bundles the updated frontend. Mac builds locally; Windows via CI.

## Layout

- `backend/` — FastAPI + SQLite (`run_desktop.py` is the local-mode entrypoint; reads
  `DATA_DIR`/`PORT` env). Prices for every traded currency thread through
  `arbitrage.Graph.ref_values()` (exchange graph + poe2scout fallback via
  `leaguehistory.scout_prices`).
- `frontend/` — React/Vite/Recharts.
- `desktop/` — Electron shell: local UI server + bundled backend manager + updater.
