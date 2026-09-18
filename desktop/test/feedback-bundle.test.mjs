// Pins desktop/src/feedback/bundle.js — the gzipped JSON a report carries — and installid.js.
import test from 'node:test'
import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { buildBundle, STATE_ENDPOINTS, MAX_BUNDLE } = await import('../src/feedback/bundle.js')
const { installId } = await import('../src/feedback/installid.js')

const SEED_SETTINGS = 'POESESSID=0123456789abcdef0123456789abcdef'
const SEED_LOG = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'

function inputs(over = {}) {
  const calls = []
  return {
    calls,
    meta: { id: 'u-u-i-d', ts: '2026-09-18T00:00:00Z', appVersion: '0.2.64', channel: 'beta', platform: 'darwin', arch: 'arm64',
            osRelease: '24.5.0', electron: '33.4.11', installId: 'ab'.repeat(16), theme: 'vault', tab: 'Board', sub: null },
    sources: { main: ['10:00:00 [ui] serving'], backend: 'GET /api/board 200', renderer: [SEED_LOG], updater: ['checking'] },
    get: async (p) => { calls.push(p); return p === '/api/settings' ? { league: 'L', reference: 'divine', poesessid: SEED_SETTINGS, session: { cookie: SEED_SETTINGS } } : { ok: true, path: p } },
    readJson: () => ({ betaChannel: true, focusHotkey: 'CommandOrControl+G', secretToken: 'zzz', unknown: 1 }),
    bounds: { width: 1440, height: 847 },
    screens: { current: Buffer.alloc(100, 1), board: Buffer.alloc(200, 2) },
    ...over,
  }
}
const unpack = (buf) => JSON.parse(gunzipSync(buf).toString())

test('the bundle is gzipped JSON with exactly the planned top-level keys and sections', async () => {
  const b = await buildBundle(inputs())
  const doc = unpack(b)
  assert.deepEqual(Object.keys(doc).sort(), ['logs', 'manifest', 'screens', 'state'])
  assert.deepEqual(Object.keys(doc.state).sort(), ['backfill', 'bounds', 'desktopSettings', 'diag', 'settings', 'status'])
  assert.deepEqual(Object.keys(doc.logs).sort(), ['backend', 'main', 'renderer', 'updater'])
  assert.equal(doc.manifest.v, 1)
  assert.equal(doc.manifest.screensPartial, false)
  assert.equal(doc.manifest.appVersion, '0.2.64')
  assert.equal(doc.screens.board, Buffer.alloc(200, 2).toString('base64'))
  assert.deepEqual(STATE_ENDPOINTS, ['/api/diag', '/api/status', '/api/backfill', '/api/settings'])
})

test('a poisoned settings response and a poisoned log line are absent from the gunzipped output', async () => {
  const b = await buildBundle(inputs())
  const s = gunzipSync(b).toString()
  assert.ok(!s.includes(SEED_SETTINGS.slice(-12)), 'settings seed leaked')
  assert.ok(!s.includes(SEED_LOG.slice(-12)), 'log seed leaked')
  assert.ok(!s.includes('secretToken') && !s.includes('unknown'), 'desktop settings not allow-listed')
  const doc = unpack(b)
  assert.equal(doc.state.settings.reference, 'divine')
  assert.deepEqual(doc.state.desktopSettings, { betaChannel: true, focusHotkey: 'CommandOrControl+G' })
})

test('get is called only for the four state endpoints — never /api/session or /api/oauth', async () => {
  const i = inputs()
  await buildBundle(i)
  assert.deepEqual(i.calls.sort(), [...STATE_ENDPOINTS].sort())
  assert.ok(!i.calls.some(p => /session|oauth/.test(p)))
})

test('a rejecting or hanging get still yields a bundle, with { error } in that slot', async () => {
  const i = inputs({ get: async (p) => { if (p === '/api/diag') throw new Error('down'); if (p === '/api/status') return new Promise(() => {}); return {} }, timeoutMs: 50 })
  const doc = unpack(await buildBundle(i))
  assert.match(doc.state.diag.error, /down/)
  assert.match(doc.state.status.error, /timeout/i)
})

test('oversize screens are dropped largest-first under the cap and screensPartial is set', async () => {
  const big = (n, fill) => Buffer.from(Array.from({ length: n }, () => Math.floor(Math.random() * 256)).map((x, i) => (x ^ fill)))   // incompressible
  const i = inputs({ screens: { current: big(2_000_000, 1), board: big(2_000_000, 2), settings: big(500_000, 3), 'strategy-hold': big(50_000, 4) } })
  const b = await buildBundle(i)
  assert.ok(b.length <= MAX_BUNDLE, `bundle ${b.length} > cap`)
  const doc = unpack(b)
  assert.equal(doc.manifest.screensPartial, true)
  assert.ok(!('current' in doc.screens) || !('board' in doc.screens), 'a 2 MB screen was dropped')
  assert.ok('strategy-hold' in doc.screens, 'the smallest screen survives')
})

test('installId is 32 hex, created once at 0600 and stable across reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-iid-'))
  const a = installId(dir)
  assert.match(a, /^[0-9a-f]{32}$/)
  assert.equal(installId(dir), a)
  assert.equal(statSync(join(dir, 'install-id')).mode & 0o777, 0o600)
  assert.equal(readFileSync(join(dir, 'install-id'), 'utf8').trim(), a)
})
