// The routes page must show the same loops whether the server streamed a fresh search or
// replayed a cached one. Owner (2026-09-23, 0.3.4-beta.2): "a bunch of results and then the
// number narrows after a while." A fresh stream delivers every loop that passed the filters
// (316 on the owner's machine), the cached replay two minutes later only the scored top 100;
// the page banded each population on its own mean and σ and showed 82 rows, then 20.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { finishRoutes } from '../src/lib/routesStream.js'

const loop = (id, score) => ({ id, score })

test('a finished stream keeps the authoritative top list, in its order, with its scores', () => {
  const streamed = [loop('a', 0.1), loop('b'), loop('c', 0.9), loop('d'), loop('e', 0.5)]   // b, d never scored
  const done = { order: ['c', 'e', 'a'], scores: { c: 0.95, e: 0.55, a: 0.15 } }
  const out = finishRoutes(streamed, done)
  assert.deepEqual(out.map(r => r.id), ['c', 'e', 'a'])
  assert.deepEqual(out.map(r => r.score), [0.95, 0.55, 0.15])
})

test('a cached replay (already the top list) comes through unchanged', () => {
  const replay = [loop('c', 0.95), loop('e', 0.55), loop('a', 0.15)]
  const done = { order: ['c', 'e', 'a'], scores: { c: 0.95, e: 0.55, a: 0.15 }, cached: true }
  assert.deepEqual(finishRoutes(replay, done), replay)
})

test('a done without an order keeps what streamed (older servers), scores applied', () => {
  const streamed = [loop('a', 0.1), loop('b', 0.2)]
  assert.deepEqual(finishRoutes(streamed, { scores: { b: 0.7 } }).map(r => r.score), [0.1, 0.7])
})

test('the page uses it on done', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/components/RoutesView.jsx', import.meta.url), 'utf8')
  assert.match(src, /finishRoutes\(accRef\.current, d\)/, 'RoutesView does not reduce the stream to the authoritative list on done')
})

// ---- the page never waits on a dead search (docs/learnability-plan.md part 5) -------------------------------
import { streamSearch, SEARCH_IDLE_MS } from '../src/lib/routesStream.js'

function fakes() {
  const timers = new Map(); let nextId = 1; let es
  class FakeES {
    constructor(url) { this.url = url; this.listeners = {}; this.closed = false; es = this }
    addEventListener(t, fn) { this.listeners[t] = fn }
    close() { this.closed = true }
    emit(t, data) { if (!this.closed) this.listeners[t]?.({ data: data === undefined ? undefined : JSON.stringify(data) }) }
  }
  const deps = {
    EventSource: FakeES,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id },
    clearTimeout: (id) => timers.delete(id),
  }
  const fire = () => { const t = [...timers.entries()]; timers.clear(); t.forEach(([, v]) => v.fn()) }
  return { deps, es: () => es, timers, fire }
}

const recorder = () => { const calls = []; const h = {}; for (const k of ['meta', 'routes', 'scores', 'done', 'fail']) h[k] = (x) => calls.push([k, x]); return { calls, h } }

test('a finished search reports done once and stops its watchdog', () => {
  const f = fakes(); const { calls, h } = recorder()
  streamSearch('/api/routes/stream', h, f.deps)
  f.es().emit('meta', { reference: 'exalted' })
  f.es().emit('routes', [{ id: 'a' }])
  f.es().emit('done', { order: ['a'] })
  assert.deepEqual(calls.map(c => c[0]), ['meta', 'routes', 'done'])
  assert.equal(f.es().closed, true)
  assert.equal(f.timers.size, 0, 'no watchdog left running')
})

test('a silent search is reported as timed out when the page asks, so it can search again', () => {
  const f = fakes(); const calls = []
  const h = { meta() {}, routes() {}, scores() {}, done() {}, fail: (m) => calls.push(['fail', m]), timeout: () => calls.push(['timeout']) }
  streamSearch('/x', h, f.deps)
  f.fire()
  assert.deepEqual(calls, [['timeout']])
  assert.equal(f.es().closed, true)
})

test('a progress event keeps a slow search alive (code review 2026-10-05)', () => {
  const f = fakes(); const calls = []
  const h = { meta() {}, routes() {}, scores() {}, done() {}, fail: (m) => calls.push(['fail', m]), timeout: () => calls.push(['timeout']) }
  streamSearch('/x', h, f.deps)
  const first = [...f.timers.keys()][0]
  f.es().emit('progress', {})
  assert.ok(!f.timers.has(first), 'the watchdog was re-armed by progress')
  assert.deepEqual(calls, [])
})

test('the routes page retries a timed-out search at most twice, then says so', () => {
  const src = readFileSync(new URL('../src/components/RoutesView.jsx', import.meta.url), 'utf8')
  assert.match(src, /timeout: \(\) => \{ if \(retries\.current < SEARCH_RETRIES\) \{ retries\.current \+= 1; load\(\) \} else \{ setErr\(/)
  assert.match(src, /const SEARCH_RETRIES = 2/)
  assert.match(src, /done: \(d\) => \{ retries\.current = 0;/, 'a finished search resets the count')
  assert.match(src, /!streaming && counts && routes\.length === 0 \?/, 'the "No loops yet" text needs a finished search')
})

test('a search that goes silent is closed and reported failed, so the page stops waiting', () => {
  const f = fakes(); const { calls, h } = recorder()
  streamSearch('/x', h, f.deps)
  f.es().emit('meta', {})
  assert.equal(f.timers.size, 1)
  assert.equal([...f.timers.values()][0].ms, SEARCH_IDLE_MS)
  f.fire()                                         // nothing arrived for SEARCH_IDLE_MS
  assert.equal(f.es().closed, true)
  assert.deepEqual(calls.at(-1), ['fail', null])
})

test('every event resets the watchdog: a long but live search is never cut off', () => {
  const f = fakes(); const { calls, h } = recorder()
  streamSearch('/x', h, f.deps)
  const first = [...f.timers.keys()][0]
  f.es().emit('routes', [{ id: 'a' }])
  assert.ok(!f.timers.has(first), 'the timer armed at the start was replaced by the event')
  for (let i = 0; i < 5; i++) f.es().emit('routes', [{ id: String(i) }])
  assert.equal(f.timers.size, 1, 'one timer, re-armed, not five')
  assert.ok(!calls.some(c => c[0] === 'fail'))
})

test('a server error is reported with its message and closes the stream', () => {
  const f = fakes(); const { calls, h } = recorder()
  streamSearch('/x', h, f.deps)
  f.es().emit('error', { error: 'boom' })
  assert.deepEqual(calls.at(-1), ['fail', 'boom'])
  assert.equal(f.es().closed, true)
  assert.equal(f.timers.size, 0)
})

test('a superseded search (closed by the page) never reports anything again', () => {
  const f = fakes(); const { calls, h } = recorder()
  const close = streamSearch('/x', h, f.deps)
  close()
  f.es().emit('done', { order: [] })
  f.fire()
  assert.deepEqual(calls, [])
  assert.equal(f.timers.size, 0)
})

test('the routes page searches through streamSearch and always leaves the searching state on failure', () => {
  const src = readFileSync(new URL('../src/components/RoutesView.jsx', import.meta.url), 'utf8')
  assert.match(src, /streamSearch\(api\.routesStreamUrl\(streamQuery\(f\)\)/)
  assert.match(src, /fail: \(msg\) => \{ if \(msg\) setErr\(msg\); setStreaming\(false\) \}/)
  assert.doesNotMatch(src, /new EventSource\(/, 'one search lifecycle, in the lib')
})
