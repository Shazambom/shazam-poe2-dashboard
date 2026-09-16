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
