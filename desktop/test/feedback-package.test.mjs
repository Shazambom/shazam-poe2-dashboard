// Pins desktop/src/feedback/index.js — feedback:package writes one sealed file per report — with
// the sweep, bundler and sealer stubbed and everything Electron injected.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { registerFeedback, shortId, KEEP_REPORTS, THROTTLE_MS } = await import('../src/feedback/index.js')

function harness(over = {}) {
  const handlers = {}, calls = []
  const win = { webContents: { id: 1, startDrag: (o) => calls.push(['drag', o]), capturePage: async () => ({}) }, getBounds: () => ({ width: 1440, height: 847 }) }
  const userData = mkdtempSync(join(tmpdir(), 'arb-fb-'))
  let t = 1_000_000
  const deps = {
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn } },
    BrowserWindow: class {}, session: {}, win, uiUrl: 'http://127.0.0.1:1', backendUrl: 'http://127.0.0.1:2', userData,
    version: '0.2.64', channel: 'beta', theme: () => 'vault',
    sources: () => ({ main: ['m'], backend: 'b', updater: ['u'] }),
    shell: { showItemInFolder: (f) => calls.push(['reveal', f]), openExternal: (u) => calls.push(['open', u]) },
    icon: 'ICON',
    sweep: async () => ({ screens: { current: Buffer.from('jpg') }, partial: false }),
    bundle: async (i) => { calls.push(['bundle', i]); return Buffer.from('BUNDLE') },
    sealFn: (b) => Buffer.concat([Buffer.from('ARB1'), b]),
    get: async () => ({}),
    now: () => t,
    ...over,
  }
  registerFeedback(deps)
  const from = (id = 1) => ({ sender: { id } })
  return { handlers, calls, userData, win, from, tick: (ms) => { t += ms } }
}
const reports = (dir) => readdirSync(join(dir, 'reports')).sort()

test('shortId: 6 chars of Crockford base32 — no vowels, no ambiguous letters', () => {
  for (let i = 0; i < 200; i++) assert.match(shortId(), /^[0-9A-HJ-NP-Z]{6}$/)
  assert.notEqual(shortId(), shortId())
})

test('feedback:package writes <userData>/reports/arbiter-report-<ID>.arb at 0600 and returns the id + path', async () => {
  const h = harness()
  const r = await h.handlers['feedback:package'](h.from())
  assert.match(r.shortId, /^[0-9A-HJ-NP-Z]{6}$/)
  assert.equal(r.screensPartial, false)
  assert.equal(r.file, join(h.userData, 'reports', `arbiter-report-${r.shortId}.arb`))
  assert.equal(statSync(r.file).mode & 0o777, 0o600)
  assert.equal(readFileSync(r.file).toString(), 'ARB1BUNDLE')
  // The bundler saw the manifest, the log sources, the renderer ring request and the bounds.
  const [, input] = h.calls.find(c => c[0] === 'bundle')
  assert.equal(input.meta.appVersion, '0.2.64'); assert.equal(input.meta.channel, 'beta'); assert.equal(input.meta.theme, 'vault')
  assert.match(input.meta.installId, /^[0-9a-f]{32}$/); assert.match(input.meta.id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(input.sources.main, ['m']); assert.deepEqual(input.bounds, { width: 1440, height: 847 })
})

test('a second request inside the throttle window returns { throttled } and writes nothing', async () => {
  const h = harness()
  const a = await h.handlers['feedback:package'](h.from())
  const b = await h.handlers['feedback:package'](h.from())
  assert.deepEqual(b, { throttled: true, shortId: a.shortId, file: a.file })
  assert.equal(reports(h.userData).length, 1)
  h.tick(THROTTLE_MS + 1)
  const c = await h.handlers['feedback:package'](h.from())
  assert.notEqual(c.shortId, a.shortId)
  assert.equal(reports(h.userData).length, 2)
})

test('the reports folder keeps the last KEEP_REPORTS files', async () => {
  const h = harness()
  for (let i = 0; i < KEEP_REPORTS + 3; i++) { await h.handlers['feedback:package'](h.from()); h.tick(THROTTLE_MS + 1) }
  assert.equal(reports(h.userData).length, KEEP_REPORTS)
})

test('a sweep that throws still yields a file, with screensPartial; a bundler that throws yields { error }, never a throw', async () => {
  const h = harness({ sweep: async () => { throw new Error('no screens') } })
  const r = await h.handlers['feedback:package'](h.from())
  assert.equal(r.screensPartial, true); assert.ok(r.file)
  const g = harness({ bundle: async () => { throw new Error('bundle broke') } })
  const rg = await g.handlers['feedback:package'](g.from())
  assert.match(rg.error, /bundle broke/)
  assert.ok(!existsSync(join(g.userData, 'reports')) || readdirSync(join(g.userData, 'reports')).length === 0)
})

test('drag, reveal and discord act only on a file this session produced, and only for the app window', async () => {
  const h = harness()
  const r = await h.handlers['feedback:package'](h.from())
  await h.handlers['feedback:drag'](h.from(), { shortId: r.shortId })
  assert.deepEqual(h.calls.find(c => c[0] === 'drag')[1], { file: r.file, icon: 'ICON' })
  await h.handlers['feedback:reveal'](h.from(), { shortId: r.shortId })
  assert.deepEqual(h.calls.find(c => c[0] === 'reveal'), ['reveal', r.file])
  await h.handlers['feedback:discord'](h.from())
  assert.match(h.calls.find(c => c[0] === 'open')[1], /^https:\/\/discord\.(gg|com)\//)
  // Unknown ids and other senders do nothing.
  const before = h.calls.length
  await h.handlers['feedback:drag'](h.from(), { shortId: '../../etc' })
  await h.handlers['feedback:reveal'](h.from(), { shortId: 'ZZZZZZ' })
  await h.handlers['feedback:drag'](h.from(99), { shortId: r.shortId })
  assert.equal(await h.handlers['feedback:package'](h.from(99)), undefined)
  assert.equal(h.calls.length, before)
})
