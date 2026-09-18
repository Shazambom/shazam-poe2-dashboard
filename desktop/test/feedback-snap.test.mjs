// Pins desktop/src/feedback/snap.js — the hidden window that photographs every screen — with a
// BrowserWindow double. No Electron here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

const { sweepScreens, SNAP_URL_SUFFIX } = await import('../src/feedback/snap.js')

const DESTS = [
  { id: 'board', section: 'Board', sub: null }, { id: 'strategy-hold', section: 'Strategy', sub: 'hold' },
  { id: 'settings', section: 'Settings', sub: null },
]
const image = (tag) => ({ resize: ({ width }) => image(`${tag}@${width}`), toJPEG: (q) => Buffer.from(`${tag}:q${q}`) })

// A window double: records what happened; `plan` scripts per-call behaviour.
function harness(plan = {}) {
  const log = []
  let filter = null, destroyed = 0
  const sessionDouble = { webRequest: { onBeforeRequest: (f, cb) => { filter = cb ? { f, cb } : null; log.push(cb ? 'filter:on' : 'filter:off') } } }
  class BrowserWindow {
    constructor(opts) {
      log.push('new'); this.opts = opts; this._d = false
      this.webContents = {
        id: 77,
        executeJavaScript: async (js) => { log.push(`js:${js}`); if (plan.jsThrows?.test(js)) throw new Error('js failed'); if (plan.jsHangs?.test(js)) return new Promise(() => {}); return true },
        capturePage: async (_r, o) => { log.push(`cap:${o?.stayHidden ? 'hidden' : 'plain'}`); if (plan.capThrows) throw new Error('cap'); return image('snap') },
      }
    }
    loadURL(u) { log.push(`load:${u}`); if (plan.loadThrows) return Promise.reject(new Error('load')); return Promise.resolve() }
    destroy() { this._d = true; destroyed++; log.push('destroy') }
    isDestroyed() { return this._d }
  }
  const visibleWin = { webContents: { capturePage: async () => { log.push('cap:visible'); if (plan.visibleThrows) throw new Error('v'); return image('visible') } } }
  const run = (over = {}) => sweepScreens({ uiUrl: 'http://127.0.0.1:1234', bounds: { width: 1440, height: 847 }, dests: DESTS,
    BrowserWindow, session: sessionDouble, visibleWin, perScreenMs: 30, totalMs: 500, ...over })
  return { log, run, filter: () => filter, destroyed: () => destroyed }
}

test('walks the full dest list: visible window first, then one hidden capture per screen, resized to 1200 and JPEG q60', async () => {
  const h = harness()
  const { screens, partial } = await h.run()
  assert.equal(partial, false)
  assert.deepEqual(Object.keys(screens), ['current', ...DESTS.map(d => d.id)])
  assert.equal(screens.current.toString(), 'visible@1200:q60')
  assert.equal(screens.board.toString(), 'snap@1200:q60')
  assert.equal(h.log[0], 'cap:visible', 'the visible window is captured before anything else')
  assert.ok(h.log.indexOf('filter:on') < h.log.findIndex(l => l.startsWith('load:')), 'GET-only filter installed before load')
  assert.ok(h.log.some(l => l === `load:http://127.0.0.1:1234${SNAP_URL_SUFFIX}`))
  assert.ok(h.log.some(l => l.includes('__arbiterSnap') && l.includes('"section":"Strategy"') && l.includes('"sub":"hold"')))
  assert.equal(h.log.filter(l => l === 'cap:hidden').length, 3)
  assert.equal(h.destroyed(), 1); assert.equal(h.filter(), null, 'filter removed after the sweep')
})

test('the snap window is hidden, sandboxed, isolated, without webviewTag, and its /api filter cancels only its own non-GETs', async () => {
  const h = harness()
  let opts
  const BW = class { constructor(o) { opts = o; throw new Error('stop here') } }
  await h.run({ BrowserWindow: BW })
  assert.equal(opts.show, false)
  assert.equal(opts.webPreferences.sandbox, true); assert.equal(opts.webPreferences.contextIsolation, true)
  assert.equal(opts.webPreferences.webviewTag, false); assert.match(opts.webPreferences.preload, /preload-snap\.js$/); assert.ok(existsSync(opts.webPreferences.preload), 'preload-snap.js exists at that path')
  assert.equal(opts.width, 1440); assert.equal(opts.height, 847)
  // The filter is installed even though construction threw (before load), and then removed.
  assert.ok(h.log.includes('filter:on') && h.log.includes('filter:off'))
})

test('the filter cancels a POST from the snap window and nothing else', async () => {
  const h = harness()
  let cb
  const sessionDouble = { webRequest: { onBeforeRequest: (f, c) => { if (c) { cb = c; assert.deepEqual(f.urls, ['http://127.0.0.1:1234/api/*']) } } } }
  await h.run({ session: sessionDouble })
  const verdict = (d) => new Promise(res => cb(d, res))
  assert.deepEqual(await verdict({ webContentsId: 77, method: 'POST' }), { cancel: true })
  assert.deepEqual(await verdict({ webContentsId: 77, method: 'GET' }), { cancel: false })
  assert.deepEqual(await verdict({ webContentsId: 1, method: 'PUT' }), { cancel: false })
})

test('a per-screen timeout skips that screen and sets partial; the rest are still taken', async () => {
  const h = harness({ jsHangs: /"sub":"hold"/ })
  const { screens, partial } = await h.run()
  assert.equal(partial, true)
  assert.deepEqual(Object.keys(screens), ['current', 'board', 'settings'])
  assert.equal(h.destroyed(), 1)
})

test('a throw inside a screen falls through to the next; a thrown loadURL leaves `current` only; window always destroyed', async () => {
  const a = harness({ jsThrows: /"section":"Board"/ })
  const ra = await a.run()
  assert.equal(ra.partial, true); assert.deepEqual(Object.keys(ra.screens), ['current', 'strategy-hold', 'settings'])
  const b = harness({ loadThrows: true })
  const rb = await b.run()
  assert.equal(rb.partial, true); assert.deepEqual(Object.keys(rb.screens), ['current'])
  assert.equal(b.destroyed(), 1); assert.equal(b.filter(), null)
  const c = harness({ visibleThrows: true, loadThrows: true })
  const rc = await c.run()
  assert.equal(rc.partial, true); assert.deepEqual(Object.keys(rc.screens), [])
})

test('the total deadline stops the walk', async () => {
  const h = harness({ jsHangs: /./ })
  const t0 = Date.now()
  const { screens, partial } = await h.run({ perScreenMs: 1000, totalMs: 60 })
  assert.ok(Date.now() - t0 < 600)
  assert.equal(partial, true); assert.deepEqual(Object.keys(screens), ['current'])
})
