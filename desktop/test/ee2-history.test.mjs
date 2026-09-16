// Pure tests of the EE2 history consumer (desktop/src/ee2-history/index.js): the actions layer between the
// package's item-checked events and the renderer's ingest(). Worker + window + telemetry are injected.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createHistoryConsumer, NO_WINDOW_BUFFER, RESTART_MIN_MS } = require('../src/ee2-history/index.js')

const RAW = 'Item Class: Belts\nRarity: Unique\nHeadhunter\nHeavy Belt\n--------\n+41 to maximum Life\n'
function harness({ build, enabled = true, hasWindow = true, now } = {}) {
  const pkg = new EventEmitter()
  const sent = [], lines = [], spawns = []
  let t = 1_000_000
  const clock = now || (() => t)
  const worker = {
    spawn() { spawns.push(clock()); return { build: build || (async (raw, prefs) => ({ q: '{"query":{}}', name: 'Headhunter', item: { name: 'Headhunter', baseType: 'Heavy Belt', rarity: 'Unique', itemClass: 'Belts' }, host: 'www.pathofexile.com', buildMs: 5 })), kill() {} } },
  }
  const c = createHistoryConsumer({
    manager: pkg, worker, prefs: () => ({ prefs: { leagueId: 'Forbidden Rites', language: 'en' }, source: 'ee2' }),
    send: hasWindow ? (ch, p) => sent.push([ch, p]) : null, log: (l) => lines.push(l), now: clock,
  })
  c.setEnabled(enabled)
  return { pkg, sent, lines, spawns, c, tick: (ms) => { t += ms } }
}
const item = (origin = 'ee2', raw = RAW) => ({ name: 'Headhunter', baseType: 'Heavy Belt', rarity: 'Unique', itemClass: 'Belts', origin, raw, ts: 1 })

test('any origin is accepted; the intent carries no raw text; telemetry lines are emitted', async () => {
  const h = harness()
  h.pkg.emit('item-checked', item('clipboard'))
  h.pkg.emit('item-checked', item('ee2'))
  await new Promise(r => setTimeout(r, 10))
  assert.equal(h.sent.length, 2)
  const [ch, intent] = h.sent[0]
  assert.equal(ch, 'trade:ingest'); assert.equal(intent.source, 'ee2'); assert.equal(intent.origin, 'clipboard'); assert.equal(intent.folder, 'ee2-history')
  assert.equal(intent.q, '{"query":{}}'); assert.equal(intent.name, 'Headhunter'); assert.equal(intent.cfgLeague, 'Forbidden Rites')
  const s = JSON.stringify(intent)
  assert.ok(!('raw' in intent) && !s.includes('maximum Life') && !s.includes('Item Class'))
  assert.ok(h.lines.some(l => l.startsWith('history-build origin=clipboard rarity=Unique name="Headhunter"')))
})

test('currency is skipped without an intent; other errors produce a degraded intent', async () => {
  const h = harness({ build: async () => ({ error: { stage: 'currency', message: 'bulk' } }) })
  h.pkg.emit('item-checked', item()); await new Promise(r => setTimeout(r, 10))
  assert.equal(h.sent.length, 0); assert.ok(h.lines.some(l => l === 'history-skip reason=currency origin=ee2'))
  const h2 = harness({ build: async () => ({ error: { stage: 'parse', message: 'item.unknown' } }) })
  h2.pkg.emit('item-checked', item()); await new Promise(r => setTimeout(r, 10))
  assert.equal(h2.sent.length, 1); assert.equal(h2.sent[0][1].degraded, true); assert.equal(h2.sent[0][1].stage, 'parse'); assert.equal(h2.sent[0][1].q, null)
  assert.ok(h2.lines.some(l => l.startsWith('history-degraded stage=parse')))
})

test('disabled: never spawns the worker, logs a skip', async () => {
  const h = harness({ enabled: false })
  h.pkg.emit('item-checked', item()); await new Promise(r => setTimeout(r, 10))
  assert.equal(h.spawns.length, 0); assert.equal(h.sent.length, 0)
  assert.ok(h.lines.some(l => l === 'history-skip reason=disabled origin=ee2'))
})

test('no window: intents are held (≤ 20) and flushed when a window appears; overflow is dropped', async () => {
  const h = harness({ hasWindow: false })
  for (let i = 0; i < NO_WINDOW_BUFFER + 3; i++) { h.pkg.emit('item-checked', item()); await new Promise(r => setTimeout(r, 1)) }
  await new Promise(r => setTimeout(r, 10))
  assert.equal(h.lines.filter(l => l === 'ingest-drop reason=no-window').length, 3)
  const sent = []
  h.c.setSender((ch, p) => sent.push([ch, p]))
  assert.equal(sent.length, NO_WINDOW_BUFFER)
})

test('worker failure: in-flight item skipped, restart at most once per 5 minutes', async () => {
  let calls = 0
  const h = harness({ build: async () => { calls++; throw new Error('worker died') } })
  h.pkg.emit('item-checked', item()); await new Promise(r => setTimeout(r, 10))
  assert.ok(h.lines.some(l => l === 'history-skip reason=worker origin=ee2'))
  assert.equal(h.spawns.length, 1)
  h.pkg.emit('item-checked', item()); await new Promise(r => setTimeout(r, 10))
  assert.equal(h.spawns.length, 1, 'no restart within 5 min')
  h.tick(RESTART_MIN_MS + 1)
  h.pkg.emit('item-checked', item()); await new Promise(r => setTimeout(r, 10))
  assert.equal(h.spawns.length, 2, 'restarted after the window')
})

test('warm-if-running: warmed only when the package reports EE2 running', () => {
  const h = harness()
  h.pkg.emit('ee2-detected', { present: true, running: false }); assert.equal(h.spawns.length, 0)
  h.pkg.emit('ee2-detected', { present: true, running: true }); assert.equal(h.spawns.length, 1)
  assert.ok(h.lines.some(l => l.startsWith('history-attached cfg=ok')))
})
