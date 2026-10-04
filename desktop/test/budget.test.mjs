// Pins desktop/src/trade/budget.js — the engine's client for the backend-owned rate budget.
// Run:  node --test desktop/test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const budget = await import('../src/trade/budget.js')

function stub(handler) {
  const calls = []
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts: opts || {} }); return handler(url, opts) }
  return calls
}
const jsonRes = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })

test('acquire posts the policy to the local backend and resolves when a slot is granted', async () => {
  const calls = stub(() => jsonRes({ ok: true }))
  budget.configure({ backendUrl: () => 'http://127.0.0.1:8210' })
  await budget.acquire('trade-fetch')
  assert.equal(calls[0].url, 'http://127.0.0.1:8210/api/ratelimits/acquire')
  assert.equal(calls[0].opts.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].opts.body), { policy: 'trade-fetch' })
})

test('acquire throws RateLimitError with retryAfter when refused', async () => {
  stub(() => jsonRes({ ok: false, retry_after_s: 12.4 }))
  await assert.rejects(budget.acquire('trade-whisper'), (e) => e instanceof budget.RateLimitError && e.code === 'RATE_LIMITED' && e.retryAfter === 13)
})

test('acquire fails open when the backend is unreachable', async () => {
  stub(() => { throw new Error('ECONNREFUSED') })
  await budget.acquire('trade-fetch')
})

test('observe reports status + rate-limit headers, fire-and-forget, never throws', async () => {
  const calls = stub(() => jsonRes({ ok: true }))
  budget.observe('trade-fetch', 429, { 'x-rate-limit-ip': ['12:6:60'], 'retry-after': '20', 'content-type': 'json' })
  await new Promise(r => setTimeout(r, 0))
  const body = JSON.parse(calls[0].opts.body)
  assert.equal(calls[0].url, 'http://127.0.0.1:8210/api/ratelimits/observe')
  assert.equal(body.policy, 'trade-fetch')
  assert.equal(body.status, 429)
  assert.deepEqual(body.headers, { 'x-rate-limit-ip': '12:6:60', 'retry-after': '20' })
  stub(() => { throw new Error('down') })
  assert.doesNotThrow(() => budget.observe('trade-fetch', 200, {}))
})

test('the hand-ported rateGate is gone and the engine uses the budget client', () => {
  assert.ok(!existsSync(new URL('../src/trade/rateGate.js', import.meta.url)))
  const engine = readFileSync(new URL('../src/trade/engine.js', import.meta.url), 'utf8')
  assert.ok(!engine.includes('rateGate'))
  assert.ok(engine.includes("budget.acquire('trade-fetch')") && engine.includes("budget.acquire('trade-whisper')"))
})

// One budgeted trade request (simplify pass, 2026-10-01): reserve → request → observe → classify, shared
// by the sales fetcher and the unique pricer so "rate"/"auth"/"HTTP n" mean the same everywhere.
test('budgeted: reserves, requests, observes and parses; a refusal is classified the same for every caller', async () => {
  const { budgeted } = budget
  const calls = []
  const deps = (status, body = '{"result":[1]}', refuse = false) => ({
    request: async (r) => { calls.push(['req', r.path]); return { status, headers: { 'retry-after': '20' }, body } },
    budget: { acquire: async (p) => { calls.push(['acq', p]); if (refuse) { const e = new Error('rl'); e.retryAfter = 9; throw e } }, observe: (p, s) => calls.push(['obs', p, s]) },
  })
  assert.deepEqual(await budgeted(deps(200), 'trade-search', { path: '/x' }), { ok: true, status: 200, data: { result: [1] } })
  assert.deepEqual(calls, [['acq', 'trade-search'], ['req', '/x'], ['obs', 'trade-search', 200]])
  assert.deepEqual(await budgeted(deps(429), 'p', { path: '/x' }), { ok: false, error: 'rate', status: 429, retryAfter: 20 })
  assert.deepEqual(await budgeted(deps(403), 'p', { path: '/x' }), { ok: false, error: 'auth', status: 403 })
  assert.deepEqual(await budgeted(deps(500), 'p', { path: '/x' }), { ok: false, error: 'HTTP 500', status: 500 })
  calls.length = 0
  assert.deepEqual(await budgeted(deps(200, '', true), 'p', { path: '/x' }), { ok: false, error: 'rate', retryAfter: 9 })
  assert.deepEqual(calls, [['acq', 'p']], 'a refused slot never reaches the site')
  assert.deepEqual(await budgeted(deps(200, 'not json'), 'p', { path: '/x' }), { ok: true, status: 200, data: null })
  const boom = { request: async () => { throw new Error('offline') }, budget: { acquire: async () => {}, observe: () => {} } }
  assert.deepEqual(await budgeted(boom, 'p', { path: '/x' }), { ok: false, error: 'offline' })
})

// Headroom (owner, 2026-10-03): a low-priority request asks for spare capacity; ordinary requests send nothing new.
test('acquire sends `spare` only when asked; budgeted passes its options through', async () => {
  const calls = stub(() => jsonRes({ ok: true }))
  await budget.acquire('trade-fetch', { spare: 0.5 })
  assert.deepEqual(JSON.parse(calls[0].opts.body), { policy: 'trade-fetch', spare: 0.5 })
  await budget.acquire('trade-fetch')
  assert.deepEqual(JSON.parse(calls[1].opts.body), { policy: 'trade-fetch' }, 'unchanged for every existing caller')
  const seen = []
  await budget.budgeted({ request: async () => ({ status: 200, headers: {}, body: '{}' }), budget: { acquire: async (p, o) => seen.push([p, o]), observe: () => {} } }, 'trade-fetch', { path: '/x' }, { spare: 0.5 })
  assert.deepEqual(seen, [['trade-fetch', { spare: 0.5 }]])
})

// Sales compares sale times with the user's last count: the site's own clock (its Date header) lets the
// backend correct for a PC clock that runs fast or slow (backend/tests/test_sales_credit.py).
test("budgeted: passes on the site's clock time when it answers with one", async () => {
  const { budgeted } = budget
  const deps = (headers) => ({ request: async () => ({ status: 200, headers, body: '{}' }), budget: { acquire: async () => {}, observe: () => {} } })
  assert.deepEqual(await budgeted(deps({ date: 'Sun, 04 Oct 2026 02:00:00 GMT' }), 'p', { path: '/x' }),
    { ok: true, status: 200, data: {}, date: 'Sun, 04 Oct 2026 02:00:00 GMT' })
  assert.deepEqual(await budgeted(deps({}), 'p', { path: '/x' }), { ok: true, status: 200, data: {} })
})
