// Pins desktop/src/menu.js — the app menu template: no zoom accelerators (they persisted a
// pathofexile.com zoom into the embedded trade window), and an explicit reset item.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const { buildMenuTemplate } = await import('../src/menu.js')

const flat = (items, out = []) => { for (const i of items || []) { out.push(i); flat(i.submenu, out) } return out }

test('no zoom roles anywhere; View has reload/devtools/fullscreen and the reset-zoom item', () => {
  const t = buildMenuTemplate({ platform: 'darwin', arbiter: [], resetTradeZoom: () => {} })
  const all = flat(t)
  for (const i of all) assert.ok(!/zoom/i.test(i.role || ''), `zoom role present: ${i.role}`)
  assert.ok(!all.some(i => i.role === 'viewMenu'), 'the viewMenu role bundles ⌘+/⌘−/⌘0')
  const view = t.find(i => i.label === 'View')
  const roles = view.submenu.map(i => i.role).filter(Boolean)
  for (const r of ['reload', 'forceReload', 'toggleDevTools', 'togglefullscreen']) assert.ok(roles.includes(r), r)
  const reset = view.submenu.find(i => i.label === 'Reset trade window zoom')
  assert.ok(reset && typeof reset.click === 'function')
  assert.ok(t.some(i => i.role === 'appMenu'), 'mac app menu kept')
  assert.ok(!buildMenuTemplate({ platform: 'win32', arbiter: [], resetTradeZoom: () => {} }).some(i => i.role === 'appMenu'))
})

test('main.js pins zoom on every window and guest, and shot.mjs no longer flashes device emulation', () => {
  const ROOT = new URL('../../', import.meta.url).pathname
  const main = readFileSync(`${ROOT}desktop/src/main.js`, 'utf8')
  assert.ok(!main.includes("{ role: 'viewMenu' }"))
  assert.ok((main.match(/zoomFactor: 1/g) || []).length >= 2, 'main window + open-trade pop-out')
  assert.ok(main.includes('setVisualZoomLevelLimits(1, 1)'))
  assert.ok(main.includes('setZoomLevel(0)'))
  const shot = readFileSync(`${ROOT}desktop/scripts/shot.mjs`, 'utf8')
  assert.ok(!shot.includes('scale: 2'))
  assert.ok(shot.includes('finally'))
})
