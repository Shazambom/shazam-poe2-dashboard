// desktop/src/trade/sales.js: acquires before, observes after, 429 backs off, auth surfaces, rows reach the ledger.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { makeSalesFetcher, POLICY } = require('../src/trade/sales.js')

const ROW = { time: '2026-09-16T20:11:03Z', item_id: 'abc', item: { name: 'Hate Pelt', typeLine: 'Vaal Regalia', rarity: 'Rare' }, price: { amount: 3, currency: 'divine' }, account: { name: 'SECRET' } }
function harness({ status = 200, body = JSON.stringify({ result: [ROW] }), acquireFails = false } = {}) {
  const calls = { acquire: [], observe: [], requests: [], posts: [] }, lines = []
  globalThis.fetch = async (url, opts) => { calls.posts.push({ url, body: JSON.parse(opts.body) }); return { json: async () => ({ ok: true, new: 1, total: 7 }) } }
  const f = makeSalesFetcher({
    request: async (r) => { calls.requests.push(r); return { status, headers: { 'x-rate-limit-rules': 'ip', 'retry-after': '20' }, body } },
    budget: { acquire: async (p) => { calls.acquire.push(p); if (acquireFails) { const e = new Error('rl'); e.retryAfter = 9; throw e } }, observe: (p, s, h) => calls.observe.push([p, s, h]) },
    backendUrl: () => 'http://127.0.0.1:8210', log: (l) => lines.push(l),
  })
  return { f, calls, lines }
}

test('happy path: acquire → GET history → observe → POST ingest with only ledger fields', async () => {
  const { f, calls, lines } = harness()
  const r = await f('Forbidden Rites')
  assert.deepEqual(calls.acquire, [POLICY])
  assert.equal(calls.requests[0].path, '/api/trade2/history/poe2/Forbidden%20Rites')
  assert.equal(calls.observe[0][0], POLICY); assert.equal(calls.observe[0][1], 200)
  assert.equal(calls.posts[0].url, 'http://127.0.0.1:8210/api/sales/ingest')
  assert.deepEqual(calls.posts[0].body, { league: 'Forbidden Rites', result: [{ item_id: 'abc', time: ROW.time, item: ROW.item, price: ROW.price }] })
  assert.ok(!JSON.stringify(calls.posts[0].body).includes('SECRET'))
  assert.deepEqual(r, { ok: true, status: 200, fetched: 1, new: 1, total: 7 })
  assert.ok(lines.includes(`sales-fetch status=200 n=1 policy="${POLICY}"`) && lines.includes('sales-ingest new=1 total=7'))
})

test('429 is observed and backs off with the header; auth surfaces; budget refusal never hits the site', async () => {
  const a = harness({ status: 429, body: '' })
  const r = await a.f('L')
  assert.deepEqual(r, { ok: false, error: 'rate', status: 429, retryAfter: 20 }); assert.equal(a.calls.observe[0][1], 429); assert.equal(a.calls.posts.length, 0)
  const b = harness({ status: 403, body: '' })
  assert.equal((await b.f('L')).error, 'auth')
  const c = harness({ acquireFails: true })
  const rc = await c.f('L')
  assert.equal(rc.error, 'rate'); assert.equal(rc.retryAfter, 9); assert.equal(c.calls.requests.length, 0)
  assert.equal((await harness().f('')).error, 'no league')
})
