# CLAUDE.md — Exiled-Exchange-2 integration package

Contract and invariants for anyone (human or agent) changing this package.

## What this is

A **presence-driven, local-only, observational** listening layer for
Exiled-Exchange-2 (EE2). It turns EE2 activity into an internal event bus. It does
NOT modify or control EE2 and has NO side effects on it.

## Hard rules

- **No settings toggle.** Presence is the switch: EE2 present → active; absent →
  dormant + periodic re-detect. Do not reintroduce a `settings.ee2Integration`
  flag or any gating in `main.js` beyond `startEe2Integration()` on ready.
- **Local only.** uiohook, reading EE2's config, and localhost peers are allowed.
  NEVER call `192.168.1.250` or any remote host from this package (desktop
  contract). No telemetry.
- **Passive / non-consuming.** The keyboard hook must never consume or inject
  keys into the price-check flow. We observe; the game still gets every key.
- **Privacy.** Not a keylogger. Match ONLY EE2-configured combos; drop all other
  keys immediately. Never log/store keystrokes or their content. `ee2-hotkey`
  reports the action label + the configured shortcut string, never raw input.
- **Best-effort, no throwing.** Any observer failure is swallowed (optionally
  surfaced via the `error` event). If EE2/uiohook/config is missing, the app must
  behave exactly as before. Clean `stop()` must call `uIOhook.stop()` and clear/
  unref all timers.
- **Original code only.** The EE2/APT clone under `~/Exiled-Exchange-2` is
  REFERENCE-ONLY (for format + behavior). Do NOT copy their source — notably
  `ipc/KeyToCode.ts` (the key table) and their clipboard/shortcut parsers. Write
  our own; cite their file:line in comments where a format is confirmed.

## Signals & why

- PRIMARY: passive `uiohook-napi` keyboard hook (same lib EE2 uses,
  `main/src/main.ts:127`), matching EE2's bound combos from `apt-data/config.json`.
  On the price-check combo → fast clipboard burst to beat EE2's ~120ms restore
  window (`HostClipboard.ts:11`) → `item-checked{origin:'ee2'}`.
- FALLBACK: adaptive clipboard poll when uiohook can't load or macOS withholds
  events (no Accessibility permission). Degrade silently.

## EE2 formats we depend on (reference clone, keep in sync if EE2 changes)

- Config path: `userData/exiled-exchange-2/apt-data/config.json`
  (`ConfigStore.ts:8-11`).
- Shortcut string: components joined by `" + "`; key names == `UiohookKey` keys
  (`KeyToCode.ts:243`, `Shortcuts.ts:189,197,363`).
- Price-check binding: price-check widget `hotkey`/`hotkeyHold`/`hotkeyLocked`
  (`PriceCheckWindow.vue:193-195`); live combo = `${hotkeyHold} + ${hotkey}`.
- Item clipboard text: `Item Class:` / `Rarity:` header, `--------` separators.

## Packaging

- Native dep `uiohook-napi`; `package.json build.asarUnpack` must keep
  `**/*.node` + `**/node_modules/uiohook-napi/**`. electron-builder auto-rebuilds
  native modules (default `npmRebuild`); CI runs `npm ci` + `electron-builder`.

## Verify before done

- `node --check` every file here.
- `node clipboard-watcher.js` (parser self-test) passes.
- Do not commit or run a build unless explicitly asked.
