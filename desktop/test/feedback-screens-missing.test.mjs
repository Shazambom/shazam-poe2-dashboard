// A report says which screens it could not take and why (reading report XWZGZ0, 2026-10-03: the Board
// and Hold screens never reached the inbox, the manifest said "not partial", and the sealed original is
// gone once opened — so where they were lost could not be told). The sweep returns `missing`
// {screenId: reason}; the report's manifest carries it as `screensMissing`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { sweepScreens } = await import('../src/feedback/snap.js')
const { registerFeedback } = await import('../src/feedback/index.js')

const DESTS = [{ id: 'board', section: 'Board', sub: null }, { id: 'strategy-hold', section: 'Strategy', sub: 'hold' },
  { id: 'settings', section: 'Settings', sub: null }]
const img = { resize: () => ({ toJPEG: () => Buffer.from('jpg') }) }

function sweep({ hang = null, throws = null, perScreenMs = 50, totalMs = 2000 } = {}) {
  class BW {
    constructor() {
      this.webContents = {
        id: 9, loadURL: async () => {}, capturePage: async () => img,
        executeJavaScript: (js) => (hang?.test(js) ? new Promise(() => {}) : throws?.test(js) ? Promise.reject(new Error('boom')) : Promise.resolve(true)),
      }
      this.loadURL = this.webContents.loadURL
    }
    isDestroyed() { return false }
    destroy() {}
  }
  return sweepScreens({ uiUrl: 'http://127.0.0.1:1', bounds: { width: 1000, height: 800 }, dests: DESTS, BrowserWindow: BW,
    session: { webRequest: { onBeforeRequest: () => {} } }, visibleWin: { webContents: { capturePage: async () => img } }, perScreenMs, totalMs })
}

test('every screen taken: nothing missing', async () => {
  const r = await sweep()
  assert.deepEqual(r.missing, {})
})

test('a screen that hangs or throws is missing, with the reason', async () => {
  const r = await sweep({ hang: /"sub":"hold"/, throws: /"section":"Board"/ })
  assert.deepEqual(r.missing, { board: 'error: boom', 'strategy-hold': 'timeout' })
  assert.deepEqual(Object.keys(r.screens), ['current', 'settings'])
})

test('screens the sweep had no time left for are missing as such', async () => {
  const r = await sweep({ hang: /"section":"Board"/, perScreenMs: 60, totalMs: 60 })
  assert.equal(r.missing.board, 'timeout')
  assert.equal(r.missing['strategy-hold'], 'no time left')
  assert.equal(r.missing.settings, 'no time left')
})

test('the report manifest carries what the sweep missed', async () => {
  const handlers = {}, calls = []
  registerFeedback({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn } }, BrowserWindow: class {}, session: {},
    win: { webContents: { id: 1 }, getBounds: () => ({ width: 1, height: 1 }) }, uiUrl: 'u', backendUrl: 'b',
    userData: mkdtempSync(join(tmpdir(), 'arb-fbm-')), version: '0', channel: 'stable', theme: () => 'vault', sources: () => ({}),
    shell: {}, icon: '', sealFn: (b) => b, get: async () => ({}), now: () => 1,
    sweep: async () => ({ screens: {}, partial: true, missing: { board: 'timeout' } }),
    bundle: async (i) => { calls.push(i); return Buffer.from('x') },
  })
  await handlers['feedback:package']({ sender: { id: 1 } })
  assert.deepEqual(calls[0].meta.screensMissing, { board: 'timeout' })
})
