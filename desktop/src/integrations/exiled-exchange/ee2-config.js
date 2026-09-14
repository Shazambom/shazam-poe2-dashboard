// Reads (and watches) EE2's own config so our passive hotkey watcher stays
// ALIGNED to whatever combos the user has bound in EE2 — including after a rebind.
//
// Config location: EE2 persists `apt-data/config.json` under its Electron
// userData dir (confirmed against EE2 main/src/host-files/ConfigStore.ts:8-11 —
// path.join(app.getPath("userData"), "apt-data", "config.json")). The dir name is
// "exiled-exchange-2".
//
// Shortcut STRING format (confirmed against EE2 ipc/KeyToCode.ts:243 and
// mergeTwoHotkeys :247-250, and shortcutToElectron in Shortcuts.ts:363 which
// splits on " + "): components are joined by " + " (space-plus-space), e.g.
// "Ctrl + D", "Ctrl + Alt + D", "Shift + Space", "F5". Key NAMES are exactly the
// keys of uiohook-napi's UiohookKey table (EE2 itself does UiohookKey[name] in
// Shortcuts.ts:189,197), which is why our own parser can look names up directly.
//
// The price-check binding lives in the price-check widget as three fields
// (EE2 renderer/src/web/price-check/PriceCheckWindow.vue:193-195): hotkey "D",
// hotkeyHold "Ctrl", hotkeyLocked "Ctrl + Alt + D" — i.e. the live combo is
// `${hotkeyHold} + ${hotkey}`. We extract our OWN normalized list from the JSON;
// we do not import EE2 code.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

function configDir() {
  const home = os.homedir()
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    return path.join(appdata, 'exiled-exchange-2')
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'exiled-exchange-2')
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
  return path.join(xdg, 'exiled-exchange-2')
}

function configPath() { return path.join(configDir(), 'apt-data', 'config.json') }

// Default aligned to EE2's own defaults — used only when we can't read a config
// (portable install / not yet saved) but EE2 is present. Keeps us deterministic.
function defaultShortcuts() {
  return [
    { action: 'price-check', target: 'price-check', shortcut: 'Ctrl + D' },
    { action: 'price-check-locked', target: 'price-check', shortcut: 'Ctrl + Alt + D' },
    { action: 'toggle-overlay', target: 'overlay', shortcut: 'Shift + Space' },
  ]
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')) } catch { return null }
}

// Walk the config JSON and pull out every hotkey binding as our own normalized
// { action, target, shortcut } records. Generic (walks widgets/arrays) so new or
// rebound actions are picked up without hard-coding EE2's widget schema.
function extractShortcuts(cfg) {
  if (!cfg || typeof cfg !== 'object') return []
  const out = []
  const seen = new Set()
  const push = (action, shortcut, target) => {
    if (typeof shortcut !== 'string' || !shortcut.trim()) return
    const key = `${action}|${shortcut}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ action, target: target || null, shortcut: shortcut.trim() })
  }

  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }

    const label = typeof node.wtype === 'string' ? node.wtype : 'hotkey'
    // Combined hold+key (price-check style): hotkeyHold ("Ctrl") + hotkey ("D").
    if (typeof node.hotkey === 'string' && node.hotkey) {
      const combo = typeof node.hotkeyHold === 'string' && node.hotkeyHold
        ? `${node.hotkeyHold} + ${node.hotkey}`
        : node.hotkey
      push(label, combo, node.wtype)
    }
    if (typeof node.hotkeyLocked === 'string') {
      push(`${label}-locked`, node.hotkeyLocked, node.wtype)
    }
    // Any "...Key" string field is a binding (overlayKey, wikiKey, poedbKey,
    // craftOfExileKey, stashSearchKey, samePricedKey, toggleKey, resetKey, ...).
    for (const [k, v] of Object.entries(node)) {
      if (k !== 'hotkey' && k !== 'hotkeyHold' && k !== 'hotkeyLocked' &&
          /Key$/.test(k) && typeof v === 'string') {
        push(k, v)
      }
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v)
  }

  walk(cfg)
  return out
}

// Load + extract in one call, falling back to defaults if unreadable.
function readShortcuts() {
  const cfg = loadConfig()
  const list = extractShortcuts(cfg)
  return list.length ? list : defaultShortcuts()
}

// Watch the config for changes so a rebind re-aligns us live. Watches the DIR
// (EE2 writes config.json.tmp then renames, which file-level watches miss) and
// debounces. Returns a close() fn; never throws.
function watchConfig(onChange) {
  const dir = path.dirname(configPath())
  let watcher = null
  let timer = null
  const fire = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { try { onChange() } catch {} }, 300)
    if (timer.unref) timer.unref()
  }
  try {
    watcher = fs.watch(dir, (_evt, file) => { if (!file || String(file).startsWith('config.json')) fire() })
    watcher.on('error', () => {})
  } catch { watcher = null }
  return () => {
    try { watcher?.close() } catch {}
    if (timer) clearTimeout(timer)
  }
}

module.exports = { configPath, loadConfig, extractShortcuts, readShortcuts, watchConfig, defaultShortcuts }
