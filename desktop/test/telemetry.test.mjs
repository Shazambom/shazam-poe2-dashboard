// Pins desktop/src/telemetry.js — the ONE sender for every diagnostic POST to shazam.
// Run:  node --test desktop/test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const { configure, installLog, SHAZAM } = await import('../src/telemetry.js')

function capture() {
  const calls = []
  globalThis.fetch = (url, opts) => { calls.push({ url, opts }); return Promise.resolve({ ok: true }) }
  return calls
}

test('installLog is silent unless the gate says on', () => {
  const calls = capture()
  configure({ enabled: () => false, version: () => '1.2.3' })
  installLog('update', 'checking')
  assert.equal(calls.length, 0)
})

test('installLog posts text to the installlog endpoint with the marker, version and platform', () => {
  const calls = capture()
  configure({ enabled: () => true, version: () => '1.2.3' })
  installLog('login', 'nav-start https://x')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${SHAZAM}/api/installlog?p=login`)
  assert.equal(calls[0].opts.method, 'POST')
  assert.equal(calls[0].opts.headers['Content-Type'], 'text/plain')
  assert.match(calls[0].opts.body, /^v1\.2\.3 \w+ nav-start https:\/\/x$/)
})

test('installLog caps the body and never throws when fetch is broken', () => {
  configure({ enabled: () => true, version: () => '1' })
  globalThis.fetch = () => { throw new Error('boom') }
  assert.doesNotThrow(() => installLog('backend', 'x'))
  globalThis.fetch = () => Promise.reject(new Error('net'))
  assert.doesNotThrow(() => installLog('backend', 'x'))
  const calls = capture()
  installLog('login', 'a'.repeat(50000), { max: 20000 })
  assert.ok(calls[0].opts.body.length <= 20000 + 40)
})

// Structural guards: one URL constant, no dead trade IPC surface.
const SRC = new URL('../src/', import.meta.url).pathname
const walk = (d) => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p] })
const files = walk(SRC).filter(f => f.endsWith('.js') && !f.includes('node_modules'))

test('the shazam host literal appears exactly once in desktop/src (telemetry.js)', () => {
  const hits = files.filter(f => readFileSync(f, 'utf8').includes('192.168.1.250'))
  assert.deepEqual(hits.map(f => f.replace(SRC, '')), ['telemetry.js'])
})

test('no sender bypasses the gate (no raw installlog fetch outside telemetry.js)', () => {
  const hits = files.filter(f => !f.endsWith('telemetry.js') && /api\/installlog/.test(readFileSync(f, 'utf8')))
  assert.deepEqual(hits, [])
})

test('dead trade IPC surface is gone', () => {
  const preload = readFileSync(join(SRC, 'preload.js'), 'utf8')
  for (const dead of ['newSearch', 'describe', 'engineState:', 'onRateState']) assert.ok(!preload.includes(dead), dead)
  for (const live of ['onSearchState', 'onEngineError', 'startSearch', 'stopSearch', 'teleport', 'onPing']) assert.ok(preload.includes(live), live)
  const index = readFileSync(join(SRC, 'trade', 'index.js'), 'utf8')
  for (const dead of ['selftest', '__testping', 'trade:new-search', 'trade:describe', 'trade:engine-state']) assert.ok(!index.includes(dead), dead)
})

// ---- Batch 1: the renderer's narrow diag bridge ----
const { makeDiagBridge, DIAG_MARKERS } = await import('../src/diag-bridge.js')

test('diag bridge: allow-listed markers only, 300-char clamp, 30 lines/min budget, gate honoured', () => {
  const sent = []
  let t = 0
  const log = makeDiagBridge({ installLog: (m, l) => sent.push([m, l]), now: () => t })
  assert.deepEqual(DIAG_MARKERS, ['ee2', 'ws', 'sales'])
  assert.equal(log('login', 'x'), false, 'unlisted marker dropped')
  assert.equal(log('ws', 42), false, 'non-string line dropped')
  assert.equal(log('ws', 'ws-load fail err="boom"'), true)
  assert.deepEqual(sent, [['ws', 'ws-load fail err="boom"']])
  log('ee2', 'y'.repeat(1000))
  assert.equal(sent[1][1].length, 300)
  for (let i = 0; i < 40; i++) log('ws', 'l' + i)
  assert.equal(sent.length, 30, '30 per minute, then dropped')
  t = 61_000
  assert.equal(log('ws', 'after'), true)
})
