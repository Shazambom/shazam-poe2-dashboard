# Debugging the desktop app — drive it, don't guess

This is how you validate desktop UI/behavior changes for real: build the local app,
run it with a remote-debugging port, and inspect the **actually-rendered DOM** (and
screenshots) over the Chrome DevTools Protocol (CDP). A production `vite build`
passing proves the code *compiles* — it does **not** prove the feature renders
correctly against real backend data. Always drive the app before claiming a UI
change works.

> Why this matters: the pulse-strip rework built + type-checked clean, but driving
> the app revealed `<Cur id={numericItemId}>` was printing the raw id `"13607"`
> instead of an icon — the hold API uses numeric item-ids while the icon registry is
> keyed by string slugs. Only a running renderer surfaced that.

## The model

Dev launch (`npx electron .`, i.e. `!app.isPackaged` with a bundled backend binary
present) is *representative*: it spawns the real local backend on `127.0.0.1:8210`
and serves the built frontend from `desktop/app-dist` via a random-port local UI
server that proxies `/api` to the backend. Two consequences:

- **The UI is served from `app-dist`, not `frontend/dist`.** After editing frontend
  code you MUST `npm run build:frontend` (rebuilds `frontend/dist` → copies to
  `desktop/app-dist`) or the app serves stale UI. `location.reload()` alone re-serves
  the same stale bundle.
- Dev has **no market seed** (seed only ships in packaged `resources/`), so the
  backend live-crawls poe2scout on first run. `/api/hold` etc. populate within a
  minute; check `building`/`count` before asserting on data.

## Steps

1. **Build the UI into `app-dist`:**
   ```bash
   cd desktop && npm run build:frontend
   ```

2. **Launch with a remote-debugging port** (kill any running instance first — a
   normal launch has no debug port, and its orphaned backend keeps `:8210`; kill
   both the electron parent and the `poe2arb-backend` holding `:8210`):
   ```bash
   npx electron . --remote-debugging-port=9222 > /tmp/electron.log 2>&1 &
   ```

3. **Wait until CDP + backend are up:**
   ```bash
   curl -s http://127.0.0.1:9222/json/version >/dev/null && \
   curl -s http://127.0.0.1:8210/api/status   >/dev/null && echo ready
   ```

4. **Sanity-check the data your feature depends on** — hit the local backend
   directly so you know what the UI *should* render:
   ```bash
   curl -s "http://127.0.0.1:8210/api/hold?horizon=1d&numeraire=divine" | python3 -m json.tool | head
   ```

5. **Drive / inspect the renderer** with the CDP helpers (run from `desktop/`):
   ```bash
   # Evaluate any JS in the page (async is awaited). Returns JSON.
   node scripts/cdp.mjs "Array.from(document.querySelectorAll('.pulse-strip .pulse-chip')).map(c => c.innerText)"
   node scripts/cdp.mjs "location.hash"
   node scripts/cdp.mjs "location.reload() || 'reloaded'"   # after a rebuild

   # Screenshot a selector to a PNG (then Read the PNG to see it).
   node scripts/shot.mjs ".pulse-strip" pulse.png
   ```
   Confirm images actually loaded, not just that `<img>` exists:
   ```bash
   node scripts/cdp.mjs "Array.from(document.querySelectorAll('.pulse-strip img.cur-img')).map(i => ({alt:i.alt, ok:i.complete && i.naturalWidth>0}))"
   ```

6. **Iterate:** edit frontend → `npm run build:frontend` → `node scripts/cdp.mjs "location.reload()||1"` → re-inspect. No app relaunch needed for frontend-only changes (relaunch only for `desktop/src/main.js` / backend changes).

## The helper scripts

- [`desktop/scripts/cdp.mjs`](../desktop/scripts/cdp.mjs) — evaluate an (awaited) JS
  expression in the renderer, print the JSON result.
- [`desktop/scripts/shot.mjs`](../desktop/scripts/shot.mjs) — screenshot a CSS
  selector's bounding box to a PNG.

Both connect to the first `127.0.0.1` page target on `CDP_PORT` (default 9222) and
use the `ws` package already in `desktop/node_modules` — run them from `desktop/`.

## Notes / gotchas

- **`vite build` passing ≠ feature works.** It's necessary, not sufficient. Drive it.
- Never trigger native JS `alert/confirm/prompt` while driving — a modal blocks the
  renderer and CDP hangs.
- This is a **local-dev diagnostic only**. It does not violate the desktop contract
  (server-for-updates-only): everything here talks to the app's own local backend.
- To verify *packaged Windows* behavior (which this Mac can't run), use the telemetry
  path instead — see CLAUDE.md → "Verifying the Windows app".
