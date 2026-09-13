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
├── backend manager
│   ├── local mode: spawns backend-bin/poe2arb-backend (PyInstaller onefile),
│   │   DATA_DIR=<userData>/data → each machine has its own SQLite + secret.key
│   └── remote mode: proxies to the shazam server (menu: Dashboard → Use remote server)
├── "Connect PoE trade session…" menu: login window → cookies.get(POESESSID) → POST /api/session
└── electron-updater → http://192.168.1.250:8080/downloads (generic provider)
```

The dockerised server deployment is unchanged and doubles as the dev/test environment;
the desktop app in remote mode is a thin client for it.

## Build & run (dev)

```
cd desktop
npm install
./build-backend.sh        # PyInstaller binary for THIS OS (needs python3.12)
npm run build:frontend    # copies ../frontend/dist into app-dist/
npm start
```

Without `backend-bin/`, the app silently uses the remote server — that's the intended
mode for platforms whose backend binary hasn't been built yet.

## Release & auto-update

```
npm run dist:mac          # release/: dmg + zip + latest-mac.yml
npm run dist:win          # release/: NSIS installer + latest.yml (no Windows backend
                          #   binary unless built on Windows — remote mode by default)
./publish.sh              # rsync artifacts to shazam:.../downloads/
```

Anyone running the app checks `/downloads/latest*.yml` on launch and every 30 min:

- **Windows**: downloads + installs in place (NSIS supports unsigned auto-update).
- **macOS**: Squirrel refuses to swap unsigned apps, so the app pops "Update available →
  Download" and opens the downloads page. Signing with an Apple Developer ID would make
  it fully automatic — drop the `identity: null` from package.json when there's a cert.

To ship the FULL local experience on Windows, run `build-backend.sh` (or the PyInstaller
command inside it) once on any Windows machine with Python 3.12 and commit/copy the
resulting `poe2arb-backend.exe` into `desktop/backend-bin/` before `dist:win`.

## Data locations

- macOS: `~/Library/Application Support/poe2-dashboard-desktop/data/`
- Windows: `%APPDATA%/poe2-dashboard-desktop/data/`
- The local backend defaults to league "Standard" — pick your league from the top bar.
