// desktop/src/window-theme.js: ui:setTheme validates the requested theme, persists it via settings-store,
// and recolours the open BrowserWindow from the requested theme even when the save fails.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { windowBackdrop, applyWindowTheme } = require('../src/window-theme.js')
const { updateSettings } = require('../src/settings-store.js')

const fakeWin = () => {
  const colors = []
  return {
    colors,
    win: {
      isDestroyed: () => false,
      setBackgroundColor: (c) => { colors.push(c) },
    },
  }
}

test('applyWindowTheme recolours the window from the requested theme even when saving fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-theme-'))
  try {
    const unwritable = join(dir, 'is-a-dir')
    mkdirSync(unwritable)
    const settings = { betaChannel: false, theme: 'vault' }
    const save = (patch) => updateSettings(() => unwritable, settings, patch)
    const { colors, win } = fakeWin()

    assert.equal(applyWindowTheme('ash', undefined, save, win), false)
    assert.deepEqual(settings, { betaChannel: false, theme: 'vault' }, 'failed save rolls back memory')
    assert.deepEqual(colors, ['#331f24'], 'window still recolours to the requested preset')

    assert.equal(applyWindowTheme('custom', '#AABBCC', save, win), false)
    assert.deepEqual(settings, { betaChannel: false, theme: 'vault' }, 'failed custom save rolls back memory')
    assert.deepEqual(colors, ['#331f24', '#aabbcc'], 'window still recolours to the requested custom backdrop')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('applyWindowTheme rejects invalid themes without saving or recolouring, and persists valid ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-theme-'))
  try {
    const f = join(dir, 'desktop-settings.json')
    const settings = { betaChannel: false, theme: 'vault' }
    let saves = 0
    const save = (patch) => { saves++; return updateSettings(() => f, settings, patch) }
    const { colors, win } = fakeWin()

    assert.equal(applyWindowTheme(null, undefined, save, win), false)
    assert.equal(applyWindowTheme('unknown', undefined, save, win), false)
    assert.equal(applyWindowTheme('custom', 'not-hex', save, win), false)
    assert.equal(saves, 0)
    assert.deepEqual(colors, [])

    assert.equal(applyWindowTheme('vaal', undefined, save, win), true)
    assert.equal(windowBackdrop(settings), '#160d0c')
    assert.deepEqual(colors, ['#160d0c'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('main.js delegates ui:setTheme to applyWindowTheme', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  assert.ok(main.includes("require('./window-theme.js')"))
  assert.ok(main.includes("ipcMain.handle('ui:setTheme', (_e, id, backdrop) => applyWindowTheme(id, backdrop, changeSettings, win))"))
})
