// Reading EE2's config.json (integrations/exiled-exchange/ee2-config.js) and the two things built on it:
// the hotkeys our watcher aligns to (readShortcuts → the integration's _applyShortcuts) and the prefs the
// history consumer builds searches with (ee2-history/prefs.js readPrefs). The home dir is a temp dir.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { loadConfig, readShortcuts } = require('../src/integrations/exiled-exchange/ee2-config.js')
const { readPrefs } = require('../src/ee2-history/prefs.js')
const { ExiledExchangeIntegration } = require('../src/integrations/exiled-exchange/index.js')

const ee2Dir = (home) => (process.platform === 'win32' ? join(home, 'AppData', 'Roaming', 'exiled-exchange-2')
  : process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'exiled-exchange-2')
    : join(home, '.config', 'exiled-exchange-2'))
const settle = () => new Promise(resolve => { setTimeout(resolve, 20) })

async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'arb-ee2cfg-'))
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
  process.env.HOME = home; process.env.USERPROFILE = home; delete process.env.APPDATA; delete process.env.XDG_CONFIG_HOME
  try { await fn(home) } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    rmSync(home, { recursive: true, force: true })
  }
}
const writeConfig = (home, text) => {
  mkdirSync(join(ee2Dir(home), 'apt-data'), { recursive: true })
  writeFileSync(join(ee2Dir(home), 'apt-data', 'config.json'), text)
}
const CFG = { leagueId: 'Forbidden Rites', language: 'de', widgets: [{ wmType: 'price-check', wtype: 'price-check', hotkey: 'D', hotkeyHold: 'Alt', hotkeyLocked: 'Ctrl + Alt + D', searchStatRange: 15 }] }

test('loadConfig: the parsed config.json; null when it is missing or not JSON', () => withHome(async (home) => {
  assert.equal(await loadConfig(), null)
  writeConfig(home, '{ not json')
  assert.equal(await loadConfig(), null)
  writeConfig(home, JSON.stringify(CFG))
  assert.deepEqual(await loadConfig(), CFG)
}))

test('readShortcuts: the bindings in the config; the EE2 defaults when there is none', () => withHome(async (home) => {
  assert.deepEqual((await readShortcuts()).map(s => s.shortcut), ['Ctrl + D', 'Ctrl + Alt + D', 'Shift + Space'])
  writeConfig(home, JSON.stringify(CFG))
  assert.deepEqual(await readShortcuts(), [
    { action: 'price-check', target: 'price-check', shortcut: 'Alt + D' },
    { action: 'price-check-locked', target: 'price-check', shortcut: 'Ctrl + Alt + D' },
  ])
}))

test('readPrefs: the EE2 settings from its config, its defaults without one', () => withHome(async (home) => {
  const none = await readPrefs()
  assert.equal(none.source, 'default')
  assert.equal(none.prefs.leagueId, 'Standard')
  writeConfig(home, JSON.stringify(CFG))
  const got = await readPrefs()
  assert.equal(got.source, 'ee2')
  assert.equal(got.prefs.leagueId, 'Forbidden Rites')
  assert.equal(got.prefs.host, 'de.pathofexile.com')
  assert.equal(got.prefs.searchStatRange, 15)
}))

test('the integration hands the hotkeys of the config to its hotkey watcher', () => withHome(async (home) => {
  writeConfig(home, JSON.stringify(CFG))
  const set = []
  const integ = new ExiledExchangeIntegration()
  integ._hotkey = /** @type {any} */ ({ setShortcuts: (l) => set.push(l.map(s => s.shortcut)) })
  integ._applyShortcuts()
  await settle()
  assert.deepEqual(set, [['Alt + D', 'Ctrl + Alt + D']])
}))

// Two reads in flight (a rebind right after activation) where the older one finishes last: only the
// newest is applied; a watcher dropped by a deactivate meanwhile gets nothing.
test('the integration applies only the newest config read, and only to the watcher that asked', async (t) => {
  const fs = await import('node:fs')
  const texts = [JSON.stringify({ widgets: [{ wtype: 'old', hotkey: 'O' }] }), JSON.stringify({ widgets: [{ wtype: 'new', hotkey: 'N' }] })]
  const delays = [30, 1]
  let n = 0
  t.mock.method(fs.promises, 'readFile', async () => {
    const i = n++
    await new Promise(resolve => { setTimeout(resolve, delays[i]) })
    return texts[i]
  })
  const set = []
  const integ = new ExiledExchangeIntegration()
  integ._hotkey = /** @type {any} */ ({ setShortcuts: (l) => set.push(l.map(s => s.shortcut)) })
  integ._applyShortcuts()
  integ._applyShortcuts()
  await new Promise(resolve => { setTimeout(resolve, 60) })
  assert.deepEqual(set, [['N']])

  n = 0
  const dropped = []
  integ._hotkey = /** @type {any} */ ({ setShortcuts: (l) => dropped.push(l) })
  integ._applyShortcuts()
  integ._hotkey = null   // deactivated before the read finished
  await new Promise(resolve => { setTimeout(resolve, 60) })
  assert.deepEqual(dropped, [])
})
