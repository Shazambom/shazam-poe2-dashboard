// desktop/src/trade/hotkey.js: the global focus hotkey. A combo the OS refuses must not cost the user the
// hotkey they had: Settings keeps showing (and main keeps saving) the previous combo, so it stays registered.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

// A stand-in for Electron's globalShortcut: `taken` combos belong to another app.
function fakeShortcuts(taken) {
  const registered = new Map()
  return {
    registered,
    globalShortcut: {
      register: (combo, fn) => {
        if (taken.has(combo) || registered.has(combo)) return false
        registered.set(combo, fn)
        return true
      },
      unregister: (combo) => { registered.delete(combo) },
      unregisterAll: () => { registered.clear() },
    },
  }
}

function loadHotkey(shortcuts) {
  const electron = require.resolve('electron')
  const file = require.resolve('../src/trade/hotkey.js')
  const before = require.cache[electron]
  require.cache[electron] = /** @type {any} */ ({ id: electron, filename: electron, loaded: true, exports: { globalShortcut: shortcuts.globalShortcut } })
  delete require.cache[file]
  try { return require(file) } finally {
    if (before) require.cache[electron] = before
    else delete require.cache[electron]
  }
}

test('a combo the OS refuses leaves the previous hotkey registered', () => {
  const s = fakeShortcuts(new Set(['Alt+Space']))
  const H = loadHotkey(s)
  assert.deepEqual(H.registerHotkey(() => null, 'CommandOrControl+G'), { ok: true, combo: 'CommandOrControl+G' })
  assert.deepEqual(H.registerHotkey(() => null, 'Alt+Space'), { ok: false, combo: 'Alt+Space' })
  assert.deepEqual([...s.registered.keys()], ['CommandOrControl+G'], 'the previous combo still works')
  assert.deepEqual(H.registerHotkey(() => null, 'CommandOrControl+K'), { ok: true, combo: 'CommandOrControl+K' })
  assert.deepEqual([...s.registered.keys()], ['CommandOrControl+K'], 'a combo that registers replaces it')
  H.unregisterAll()
  assert.equal(s.registered.size, 0)
})

test('re-choosing the combo already in use keeps it registered', () => {
  const s = fakeShortcuts(new Set())
  const H = loadHotkey(s)
  assert.equal(H.registerHotkey(() => null, 'CommandOrControl+G').ok, true)
  assert.equal(H.registerHotkey(() => null, 'CommandOrControl+G').ok, true)
  assert.deepEqual([...s.registered.keys()], ['CommandOrControl+G'])
})

// Settings' label asks main for the hotkey state (hotkey:get). A saved combo the OS refused at launch is
// not registered (combo: null, registered: false), while saved still carries the saved/default combo.
test('the registered combo is reported, and none when the OS refused it', () => {
  const s = fakeShortcuts(new Set(['CommandOrControl+G']))
  const H = loadHotkey(s)
  assert.equal(H.registeredHotkey(), null)
  assert.equal(H.registerHotkey(() => null, 'CommandOrControl+G').ok, false)
  assert.equal(H.registeredHotkey(), null, 'refused at launch: nothing is registered')
  assert.equal(H.registerHotkey(() => null, 'Alt+K').ok, true)
  assert.equal(H.registeredHotkey(), 'Alt+K')
  assert.equal(H.registerHotkey(() => null, 'CommandOrControl+G').ok, false)
  assert.equal(H.registeredHotkey(), 'Alt+K', 'a refused re-bind keeps the previous combo')
  H.unregisterAll()
  assert.equal(H.registeredHotkey(), null)
})

test('hotkeyState reports combo, saved fallback, and whether a hotkey is registered', () => {
  const s = fakeShortcuts(new Set(['CommandOrControl+G']))
  const H = loadHotkey(s)
  assert.deepEqual(H.hotkeyState(undefined), { combo: null, saved: 'CommandOrControl+G', registered: false })
  assert.equal(H.registerHotkey(() => null, 'CommandOrControl+G').ok, false)
  assert.deepEqual(H.hotkeyState(undefined), { combo: null, saved: 'CommandOrControl+G', registered: false })
  assert.deepEqual(H.hotkeyState('Alt+Space'), { combo: null, saved: 'Alt+Space', registered: false })
  assert.equal(H.registerHotkey(() => null, 'Alt+K').ok, true)
  assert.deepEqual(H.hotkeyState('Alt+K'), { combo: 'Alt+K', saved: 'Alt+K', registered: true })
  H.unregisterAll()
  assert.deepEqual(H.hotkeyState('Alt+K'), { combo: null, saved: 'Alt+K', registered: false })
})

test('main.js answers hotkey:get through hotkeyState with the saved combo', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  assert.ok(main.includes("ipcMain.handle('hotkey:get', () => hotkeyState(settings.focusHotkey))"))
})
