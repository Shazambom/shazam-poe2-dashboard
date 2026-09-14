# Exiled-Exchange-2 integration (presence-driven listening layer)

A self-contained, **local-only** package that LISTENS for
[Exiled-Exchange-2](https://github.com/Kvan7/Exiled-Exchange-2) (EE2, a fork of
[Awakened PoE Trade](https://github.com/SnosMe/awakened-poe-trade)) activity and
re-exposes it as an internal event bus ("hooks"), so Arbiter can react
whenever EE2 is used.

## Presence is the only switch (no toggle)

There is **no `settings` flag**. On launch we detect EE2:

- **EE2 present** → the integration runs, **aligned to EE2's own configured
  hotkeys**.
- **EE2 absent** → it stays fully dormant and just re-checks every 30s, so
  installing EE2 later turns it on with no app restart.

## How it listens (deterministic, aligned)

1. **`hotkey-watcher.js` — PRIMARY.** A passive, **non-consuming** global keyboard
   hook via `uiohook-napi` — the *same* mechanism EE2 itself uses
   (`~/Exiled-Exchange-2/main/src/main.ts:127` `uIOhook.start()`,
   `main/src/shortcuts/Shortcuts.ts`). Passive means the game still receives every
   key. We match **only** the combos EE2 has bound (read from EE2's config). When
   EE2's price-check hotkey fires we kick a short **fast clipboard burst** (read
   every ~15ms for ~250ms) to catch the item inside EE2's ~120ms clipboard-restore
   window (`RESTORE_AFTER`, `HostClipboard.ts:11`), then emit
   `item-checked{origin:'ee2'}`. No polling guesswork, no timing race.
2. **`clipboard-watcher.js` — FALLBACK + safety net.** If uiohook can't run
   (native load failure, or macOS Accessibility permission not granted so no
   events arrive) we silently degrade to an adaptive clipboard poll (~90ms while
   EE2 active). It also runs slow (600ms) as a manual-copy safety net while
   uiohook is healthy.
3. **`ee2-config.js`.** Reads EE2's `apt-data/config.json` for the bound hotkeys
   and **watches it**, re-aligning us the moment the user rebinds in EE2.

## Privacy

The hotkey watcher is **not a keylogger**. It compares each keydown against the
small set of EE2-configured combos and emits **only on a match**; non-matching
keys are dropped immediately and **never logged or stored**. We never record
keystrokes or their content.

## Files

| File | Role |
|------|------|
| `index.js` | Presence-driven manager (`EventEmitter`: `start()`/`stop()`/`on()`). Detect → activate/deactivate; owns the observers, dedupe, fallback logic. **The only file callers touch.** |
| `hotkey-watcher.js` | Passive uiohook hook; parses EE2 shortcut strings → keycode+modifier specs; matches; fires `onHotkey`. Own key-name→keycode mapping. |
| `ee2-config.js` | Locates/loads/parses/**watches** EE2 `config.json`; extracts normalized `{action,target,shortcut}` bindings. |
| `clipboard-watcher.js` | Adaptive clipboard poll + `captureItemBurst()` + PoE2 item parser (self-test: `node clipboard-watcher.js`). |
| `detect.js` | Best-effort EE2 detection (config dir / process). |
| `subscribers/log-demo.js` | Demo subscriber; `console.log`s every hook. No side effects. |
| `server-watcher.js`, `log-watcher.js` | OPTIONAL extras (HTTP `/config` probe; PoE2 `Client.txt` tail). Not wired by default — see comments in each. |

## Hooks (events)

| Event | Payload | Backed by | Reliability |
|-------|---------|-----------|-------------|
| `ee2-detected` | `{present, method, dir, config, running}` | `detect.js` | Fires on presence transitions (and at boot). |
| `ee2-missing` | `{}` | `detect.js` | Fires when EE2 goes away / absent at boot. |
| `ee2-hotkey` | `{action, target, shortcut, ts}` | `hotkey-watcher.js` | **High** — deterministic match of an EE2-configured combo. |
| `item-checked` | `{name, baseType, rarity, itemClass, corrupted, unidentified, mirrored, origin, raw, ts}` | burst (hotkey) or clipboard poll | **High** via `origin:'ee2'` burst; `origin:'clipboard'` for stray manual copies. |
| `started` / `stopped` | `{}` | lifecycle | High. |
| `error` | `Error` | any observer | Non-fatal notes (e.g. "clipboard fallback"). Only emitted if a listener is attached. |

`origin`: `'ee2'` = captured by the price-check burst (deterministically tied to
the EE2 hotkey); `'clipboard'` = seen by the background poll (likely a manual
Ctrl+C). Cross-source dedupe means the `'ee2'` burst wins over the poll.

## Native dependency + packaging

- Adds **`uiohook-napi`** (native `.node`). electron-builder auto-rebuilds native
  modules against Electron's ABI during packaging (default `npmRebuild`), and CI
  already runs `npm ci` + `npx electron-builder`, so no workflow change is needed.
- `package.json` `build.asarUnpack` includes `**/*.node` and
  `**/node_modules/uiohook-napi/**` so the native binary loads at runtime (native
  modules can't be `require`d from inside the asar archive).

## macOS Accessibility

uiohook needs **Accessibility** permission (System Settings → Privacy & Security →
Accessibility) to receive global key events. If permission isn't granted, uiohook
loads but no events arrive — after ~10s with zero keys we **silently fall back**
to the adaptive clipboard poll and emit one non-fatal `error` note. We never
hard-fail and never spam OS permission prompts.

## Usage

```js
const { ExiledExchangeIntegration } = require('./integrations/exiled-exchange')
const { attachLogDemo } = require('./integrations/exiled-exchange/subscribers/log-demo')

const ee2 = new ExiledExchangeIntegration()
attachLogDemo(ee2)
await ee2.start()   // self-gates on EE2 presence
// ...later...
ee2.stop()          // stops uiohook + timers cleanly
```

## Adding an actions layer later

1. Write a new subscriber under `subscribers/` (like `log-demo.js`) reacting to
   the events it cares about (e.g. `origin:'ee2'` `item-checked`).
2. Keep it local: any data lookup must go through the **bundled local backend on
   127.0.0.1**, never a remote server (desktop contract).
3. Attach it where the manager is created (`desktop/src/main.js`).
4. Need a new signal? Emit a new event from a new/existing observer and add it to
   the table. Subscribers opt in per event, so additions are backwards-compatible.
