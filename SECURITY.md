# Security and privacy

Arbiter is an open-source, local-first desktop app for Path of Exile 2. There is no Arbiter account, no Arbiter backend server, and no analytics or telemetry in stable builds.

## What runs on your machine

Arbiter bundles its own local backend and two local SQLite databases in your OS app-data folder (`user.sqlite` for your settings and saved searches, `market.sqlite` for exchange prices). Every API call inside the app talks to `127.0.0.1` on your own machine.

## Path of Exile login and session cookies

- Normal sign-in happens directly on `pathofexile.com` inside Arbiter's embedded login window ([`desktop/src/poelogin.js`](desktop/src/poelogin.js)). Arbiter never sees or stores your Path of Exile or Steam password.
- An optional manual session-cookie fallback exists in Settings if you prefer pasting a session yourself (`poe-set-cookie` in [`desktop/src/main.js`](desktop/src/main.js)).
- Your `POESESSID` cookie is encrypted at rest with Fernet in your local database using a local key file (`secret.key`, mode `0600`) managed by [`backend/app/secrets.py`](backend/app/secrets.py). This protects the cookie if someone copies the database file alone; it cannot protect against malware already running as your OS user.
- Clicking **Disconnect** clears the stored session.
- **Board**, **Mods**, **Regex**, **Hold**, **Inflation**, **Market**, and **Convert** all work without logging in.

## Outbound network hosts

A stable Arbiter install only talks to these external hosts:

| Host | Why Arbiter contacts it |
|---|---|
| `www.pathofexile.com` | Embedded trade2 site, live searches, merchant history, league list, static currency/item catalog, and login. |
| `api.pathofexile.com` | Official Path of Exile OAuth API (only if OAuth is connected). |
| `web.poecdn.com` | GGG's public hourly Currency Exchange digest and official item/currency icons. |
| `api.poe2scout.com` | Past-league price history used for cross-league economy charts. |
| `cdn.poe2db.tw` (and on-demand data refresh hosts `poe2db.tw`, `repoe-fork.github.io`, `ggpk.exposed`, `github.com/poe-tool-dev/dat-schema`) | Currency icon fallback and game/mod/gold-fee reference data when updated. |
| `github.com` / `objects.githubusercontent.com` | Auto-updater checks against this repository's GitHub Releases (`Shazambom/shazam-poe2-dashboard`). |
| `discord.gg` | Only if you click the Discord link in the app. |

## Telemetry and feedback bundles

- **Stable builds send zero telemetry.** Every diagnostic sender in the app is gated by `diagTelemetryOn()` in [`desktop/src/main.js`](desktop/src/main.js), which is only active on opt-in beta builds or unpackaged dev runs.
- You may notice a hardcoded LAN address (`http://192.168.1.250:8080`) in [`desktop/src/telemetry.js`](desktop/src/telemetry.js) and [`backend/app/devtelemetry.py`](backend/app/devtelemetry.py). That is the developer's private RFC1918 local-network test server used strictly for opt-in beta diagnostics. It is disabled on stable builds and unreachable over the public internet.
- **Report a problem** ([`desktop/src/feedback/`](desktop/src/feedback/)) creates a local, redacted, encrypted `.arbiter-report` file on your machine. Nothing is uploaded automatically; you choose whether to share the file.

## Keyboard hook, clipboard, and `Client.txt`

- **Exiled Exchange 2 integration (`uiohook-napi`):** Arbiter uses `uiohook-napi` in [`desktop/src/integrations/exiled-exchange/hotkey-watcher.js`](desktop/src/integrations/exiled-exchange/hotkey-watcher.js), the same passive, non-consuming keyboard hook library used by Exiled Exchange 2 and Awakened PoE Trade. It listens only for EE2's configured hotkeys so items you price-check appear in your Arbiter history folder, drops all other keystrokes immediately, and stays dormant if EE2 is not installed. Nothing is logged or sent off your machine.
- **`Client.txt` log watcher:** [`desktop/src/integrations/exiled-exchange/log-watcher.js`](desktop/src/integrations/exiled-exchange/log-watcher.js) passively tails PoE 2's local `Client.txt` log file to drive the optional Strat Calculator auto-timer.
- **Game client & ToS:** Arbiter does not read game memory, does not inject into the PoE 2 client, and does not automate in-game actions or trade purchases. Every whisper, repricing click, and hideout travel is triggered one click at a time by you ([`desktop/src/trade/engine.js`](desktop/src/trade/engine.js)), live searches cap at 20 matching the site's own limit, and all trade requests run through one rate-limit budget honoring GGG's rate headers ([`desktop/src/trade/budget.js`](desktop/src/trade/budget.js)).

## Build provenance and code signing

- Windows installers are built publicly in GitHub Actions ([`.github/workflows/release-desktop-win.yml`](.github/workflows/release-desktop-win.yml)) with every action pinned to a commit SHA and build provenance attested via `actions/attest-build-provenance`. You can verify a downloaded installer with:

  ```sh
  gh attestation verify Arbiter-Setup-<version>.exe -R Shazambom/shazam-poe2-dashboard
  ```

- See [`CODE_SIGNING.md`](CODE_SIGNING.md) for our Code Signing Policy and current signing status.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for a security vulnerability or anything involving session cookies. Report it privately using GitHub's **Security -> Report a vulnerability** tab on this repository, or message the maintainer directly via the project Discord (`https://discord.gg/xxEDMkfqJg`).
