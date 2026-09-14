# Arbiter — project contract

## ⛔ HIGHEST-IMPORTANCE RULE — the desktop contract

**DESKTOP APPS MAY ONLY CALL THE SERVER FOR UPDATES. NOTHING ELSE.**

The desktop app (Arbiter, `desktop/`) is **fully self-contained**: it ships its own
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

## Release auto-publish (Windows) — polling now, webhook at go-live

Windows desktop builds run in CI (see the desktop contract above). They reach the
`/downloads` channel automatically:

- **Now (LAN-only): cron poller.** `ops/publish-latest.sh` runs on shazam every 5 min
  (`/home/shazam/bin/`, in the `shazam` user crontab), pulls the newest `desktop-v*`
  release, renames the installer to the spaced filename `latest.yml` expects, and drops
  it in `/downloads`. GitHub's cloud runners can't reach the LAN, so shazam PULLS.
- **At go-live (public internet): switch to the webhook** for instant publish.
  `ops/webhook-receiver.py` + `ops/poe2-webhook.service` are already built and deployed
  to shazam (`/home/shazam/bin/webhook-receiver.py`), but DORMANT. To activate:
  1. Create the secret: `openssl rand -hex 32 > /home/shazam/.poe2-webhook-secret && chmod 600 …`
  2. Install + start the service: `sudo cp ops/poe2-webhook.service /etc/systemd/system/ &&
     sudo systemctl daemon-reload && sudo systemctl enable --now poe2-webhook` (listens :9099).
  3. Port-forward a public port → shazam:9099 (front it with TLS via the public reverse proxy).
  4. In the GitHub repo → Settings → Webhooks: add the public URL, content-type
     `application/json`, the same secret, event = **Releases** only.
  5. Keep the cron poller enabled as a fallback (it no-ops when already up to date).
  The receiver verifies GitHub's `X-Hub-Signature-256` HMAC and only acts on a published
  `desktop-v*` release — never trust an unsigned call (it runs the publish script).

Mac builds + publishes locally (PyInstaller can't cross-compile), so Mac is not part of
this auto-publish path.

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
