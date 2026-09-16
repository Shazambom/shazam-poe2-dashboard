# Desktop app (Electron)

Chromium shell around the exact same frontend + backend. Being the browser solves the
POESESSID problem natively (EE2/awakened-poe-trade pattern): the PoE login happens in
our own window and the HttpOnly cookie is read from the app's session — no extension,
no paste.

## How it fits together

```
Electron main process
├── local UI server (random port): serves app-dist/ and proxies /api + /callback
│   → the web frontend runs byte-identical, no CORS, SSE streams through
├── backend manager: spawns backend-bin/poe2arb-backend (PyInstaller onefile) with
│   DATA_DIR=<userData>/data (each machine has its own user.sqlite + market.sqlite + secret.key),
│   which in turn supervises sidecar-bin/poe2arb-sidecar (heavy analytics, SQLite transport)
├── trade engine (src/trade/): live-search WebSockets + fetch + whisper on the user's own session;
│   rate budget reserved through the local backend (/api/ratelimits)
├── "Connect PoE trade session…": login window → cookies.get(POESESSID) → POST /api/session
├── telemetry.js: the ONE diagnostics sender, beta/dev channel only
└── electron-updater → GitHub Releases (`github` provider; stable = latest*.yml, beta = beta*.yml)
```

The dockerised server deployment is the web TEST environment; a packaged app never talks to
it (desktop contract in CLAUDE.md). Only an unpackaged `npm start` without a bundled binary
points at a dev backend (`ARBITER_DEV_BACKEND_URL`, default the shazam test env).

## Build & run (dev)

```
cd desktop
npm install
./build-backend.sh        # PyInstaller binary for THIS OS (needs python3.12)
npm run build:frontend    # copies ../frontend/dist into app-dist/
npm start
```

Without `backend-bin/`, an unpackaged launch points at the dev backend (see above); a
packaged build always requires the bundled binary.

## Release & auto-update

```
npm run dist:mac          # release/: dmg + zip + latest-mac.yml
./publish-github.sh       # test gate → tag + push (Windows CI builds the .exe with the same
                          #   build-*.sh scripts) → builds Mac → waits on CI → uploads both
                          #   platforms' assets to the GitHub Release (docs/release-runbook.md)
```

Anyone running the app checks the latest **GitHub Release**'s `latest*.yml` on launch and
every 30 min (electron-updater `github` provider):

- **Windows**: downloads + installs in place (NSIS supports unsigned auto-update).
- **macOS**: Squirrel refuses to swap unsigned apps, so the app pops "Update available →
  Download" and opens the release's DMG. Signing with an Apple Developer ID would make
  it fully automatic — drop the `identity: null` from package.json when there's a cert.

Windows binaries are built by CI on a Windows runner (`release-desktop-win.yml`) — never
build the Windows installer on the Mac.

## Data locations

- macOS: `~/Library/Application Support/Arbiter/data/`
- Windows: `%APPDATA%/Arbiter/data/`
- The local backend defaults to league "Standard" — pick your league from the top bar.
