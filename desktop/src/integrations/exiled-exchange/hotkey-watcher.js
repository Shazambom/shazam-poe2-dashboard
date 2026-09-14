// Passive, non-consuming global hotkey watcher — the deterministic EE2 signal.
//
// This is exactly how EE2 itself hooks the keyboard: uiohook-napi
// (~/Exiled-Exchange-2/main/src/main.ts:127 `uIOhook.start()`;
// main/src/shortcuts/Shortcuts.ts). uiohook is a PASSIVE OS-level hook — it
// observes key events without consuming them, so the game still receives every
// keypress. We attach the same way and simply MATCH the combos EE2 has bound
// (read from EE2's own config), firing a deterministic event the instant EE2's
// price-check hotkey is pressed. No polling guesswork, no timing race.
//
// PRIVACY: we never log or store keystrokes or their content. We compare each
// keydown against the small set of EE2-configured combos and emit ONLY on a
// match; non-matching keys are dropped immediately, never recorded.
//
// The key-name -> keycode mapping is our OWN: uiohook-napi exports a `UiohookKey`
// table whose property names are exactly the names EE2 stores in its shortcut
// strings, so we look names up directly against that runtime table. We do NOT
// import EE2's KeyToCode.ts (reference-only).
'use strict'

// Modifier tokens we recognize in an EE2 shortcut string.
const MODS = {
  ctrl: /^(ctrl|control)$/i,
  alt: /^(alt|option)$/i,
  shift: /^shift$/i,
  meta: /^(meta|cmd|command|super|win|windows)$/i,
}

// Load uiohook-napi lazily and defensively — a missing/ABI-mismatched native
// binary (or an unsupported platform) must degrade to the clipboard fallback,
// never crash the app.
function loadUiohook() {
  try {
    const mod = require('uiohook-napi')
    if (mod && mod.uIOhook && mod.UiohookKey) return mod
  } catch {}
  return null
}

// Parse "Ctrl + Alt + D" -> { ctrl, alt, shift, meta, keyName, keycode }.
// Returns null if the non-modifier key isn't in UiohookKey (unsupported here).
function parseShortcut(str, UiohookKey) {
  if (typeof str !== 'string' || !str.trim()) return null
  const spec = { ctrl: false, alt: false, shift: false, meta: false, keyName: null, keycode: null }
  for (const raw of str.split('+').map((s) => s.trim()).filter(Boolean)) {
    let isMod = false
    for (const [flag, re] of Object.entries(MODS)) {
      if (re.test(raw)) { spec[flag] = true; isMod = true; break }
    }
    if (isMod) continue
    // Non-modifier key: look up its uiohook keycode by name.
    const code = UiohookKey[raw] ?? UiohookKey[raw.length === 1 ? raw.toUpperCase() : raw]
    if (code == null) return null
    spec.keyName = raw
    spec.keycode = code
  }
  return spec.keycode == null ? null : spec
}

class HotkeyWatcher {
  // onHotkey({action, target, shortcut, ts}) fires on a configured match.
  // onFirstKey() fires once when the FIRST key event of any kind arrives — used
  // to confirm uiohook is actually delivering events (macOS permission check).
  constructor({ onHotkey, onFirstKey, cooldownMs = 250 } = {}) {
    this._onHotkey = typeof onHotkey === 'function' ? onHotkey : () => {}
    this._onFirstKey = typeof onFirstKey === 'function' ? onFirstKey : () => {}
    this._cooldownMs = cooldownMs
    this._mod = null
    this._specs = []                 // [{action,target,shortcut,ctrl,alt,shift,meta,keycode}]
    this._lastFire = new Map()       // shortcut -> ts (debounce auto-repeat)
    this._sawKey = false
    this._handler = null
  }

  // Attempt to start the OS hook. Returns true if uiohook loaded (events may
  // still be blocked by OS permission — see onFirstKey), false if unavailable.
  start() {
    if (this._mod) return true
    const mod = loadUiohook()
    if (!mod) return false
    this._mod = mod
    this._handler = (e) => this._onKeydown(e)
    try {
      mod.uIOhook.on('keydown', this._handler)
      mod.uIOhook.start()
      return true
    } catch {
      this._mod = null
      this._handler = null
      return false
    }
  }

  stop() {
    if (!this._mod) return
    try { this._mod.uIOhook.removeListener('keydown', this._handler) } catch {}
    try { this._mod.uIOhook.stop() } catch {}
    this._mod = null
    this._handler = null
    this._specs = []
    this._lastFire.clear()
  }

  isLoaded() { return Boolean(this._mod) }
  sawKey() { return this._sawKey }

  // (Re)apply the set of EE2 combos to match. Unsupported combos are skipped.
  setShortcuts(list) {
    if (!this._mod) { this._specs = []; return }
    const K = this._mod.UiohookKey
    const specs = []
    for (const item of list || []) {
      const parsed = parseShortcut(item.shortcut, K)
      if (!parsed) continue
      specs.push({ ...parsed, action: item.action, target: item.target || null, shortcut: item.shortcut })
    }
    this._specs = specs
  }

  _onKeydown(e) {
    if (!this._sawKey) { this._sawKey = true; try { this._onFirstKey() } catch {} }
    // Ignore modifier-only keydowns fast; match on the real key.
    for (const s of this._specs) {
      if (e.keycode !== s.keycode) continue
      if (Boolean(e.ctrlKey) !== s.ctrl) continue
      if (Boolean(e.altKey) !== s.alt) continue
      if (Boolean(e.shiftKey) !== s.shift) continue
      if (Boolean(e.metaKey) !== s.meta) continue
      const now = Date.now()
      const last = this._lastFire.get(s.shortcut) || 0
      if (now - last < this._cooldownMs) return   // debounce auto-repeat
      this._lastFire.set(s.shortcut, now)
      try { this._onHotkey({ action: s.action, target: s.target, shortcut: s.shortcut, ts: now }) } catch {}
      return
    }
  }
}

module.exports = { HotkeyWatcher, parseShortcut }
