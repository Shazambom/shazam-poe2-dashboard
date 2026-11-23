// Feature 3: desktop budgeted relax checker (1 trade-search + 1 trade-fetch top 10 hard cap).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const R = require('../src/trade/relax.js')

const ID = (i) => i.toString(16).padStart(64, '0')
const fullListing = (id, amount, currency, extraItem = {}) => ({
  id,
  listing: {
    price: { type: '~b/o', amount, currency },
    account: { name: 'SECRET#999', online: { league: 'L' } },
    stash: { name: 'PrivateTab' },
    hideout_token: 'SECRET_TOKEN',
    whisper: '@SECRET hi',
  },
  item: {
    name: 'Doom Band',
    typeLine: 'Breach Ring',
    ilvl: 82,
    implicitMods: ['+12 to Life'],
    explicitMods: ['+80 to Life', '+35% Fire Res', '+30% Cold Res'],
    fracturedMods: ['+25% Lightning Res'],
    extended: { dps: 999 },
    ...extraItem,
  },
})

const RELAXED_Q = {
  status: { option: 'securable' },
  stats: [{ type: 'count', value: { min: 3 }, filters: [{ id: 's1', value: { min: 80 } }] }],
}

function harness({ searchRes = { id: 'RX1', result: Array.from({ length: 50 }, (_, i) => ID(i + 1)), total: 120 }, refuse = 0, status = 200 } = {}) {
  const calls = { acquire: [], observe: [], requests: [] }
  const lines = []
  const check = R.makeRelaxChecker({
    request: async (req) => {
      calls.requests.push(req)
      if (status !== 200) return { status, headers: { 'retry-after': '12' }, body: '{}' }
      if (req.method === 'POST') return { status: 200, headers: {}, body: JSON.stringify(searchRes) }
      const ids = req.path.split('/fetch/')[1].split('?')[0].split(',')
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ result: ids.map((id, k) => fullListing(id, 10 + k, k % 2 ? 'vaal' : 'chaos')) }),
      }
    },
    budget: {
      acquire: async (p, o) => {
        calls.acquire.push([p, o])
        if (refuse-- > 0) { const e = /** @type {Error & { retryAfter?: number }} */ (new Error('rl')); e.retryAfter = 3; throw e }
      },
      observe: (p, s) => calls.observe.push([p, s]),
    },
    log: (l) => lines.push(l),
    wait: async () => {},
  })
  return { check, calls, lines }
}

test('relax reuses listings.js projectRows ({id, amount, currency} only) and strips private/item fields', () => {
  const rows = R.projectRows({
    result: [
      fullListing(ID(1), 15, 'chaos'),
      null,
      { id: ID(2), listing: { price: null }, item: { name: 'Unpriced' } },
      fullListing(ID(3), 105, 'vaal'),
    ],
  })
  assert.deepEqual(rows, [
    { id: ID(1), amount: 15, currency: 'chaos' },
    { id: ID(3), amount: 105, currency: 'vaal' },
  ])
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|PrivateTab|whisper|hideout_token|extended|Doom Band/)
  assert.deepEqual(R.projectRows(null), [])
})

test('hard cap: at most 1 trade-search + 1 trade-fetch (top 10) even when 50+ ids return', async () => {
  const h = harness()
  const r = await h.check({ league: 'Dawn of the Hunt', query: { ...RELAXED_Q, status: { option: 'online' } } })
  assert.equal(r.ok, true)
  assert.equal(r.searchId, 'RX1')
  assert.equal(r.total, 120)
  assert.equal(r.rows.length, 10)
  assert.deepEqual(h.calls.acquire.map(([p]) => p), ['trade-search', 'trade-fetch'])
  assert.equal(h.calls.requests.length, 2)
  const [searchReq, fetchReq] = h.calls.requests
  assert.equal(searchReq.method, 'POST')
  assert.equal(searchReq.path, '/api/trade2/search/poe2/Dawn%20of%20the%20Hunt')
  assert.deepEqual(searchReq.body.query.status, { option: 'securable' })
  assert.deepEqual(searchReq.body.sort, { price: 'asc' })
  assert.equal(fetchReq.method, 'GET')
  assert.equal(fetchReq.path, `/api/trade2/fetch/${Array.from({ length: 10 }, (_, i) => ID(i + 1)).join(',')}?query=RX1&realm=poe2`)
  assert.doesNotMatch(JSON.stringify(r), /SECRET|PrivateTab|whisper|hideout_token/)
})

test('zero results or malformed searchId sends 0 fetches; bad requests send 0 network/budget calls', async () => {
  const empty = harness({ searchRes: { id: 'RX0', result: [], total: 0 } })
  assert.deepEqual(await empty.check({ league: 'L', query: RELAXED_Q }), { ok: true, searchId: 'RX0', total: 0, rows: [] })
  assert.equal(empty.calls.requests.length, 1)

  const badId = harness({ searchRes: { id: '../../evil?x=1', result: [ID(1)], total: 1 } })
  assert.deepEqual(await badId.check({ league: 'L', query: RELAXED_Q }), { ok: true, searchId: '', total: 1, rows: [] })
  assert.equal(badId.calls.requests.length, 1)

  const bad = harness()
  for (const req of [{ league: '', query: RELAXED_Q }, { league: 'L', query: null }, { league: 'L', query: [] }, {}]) {
    assert.deepEqual(await bad.check(req), { ok: false, error: 'bad request' })
  }
  assert.equal(bad.calls.requests.length, 0)
  assert.equal(bad.calls.acquire.length, 0)
})

test('in-flight dedup shares one search regardless of key order; subsequent call runs fresh', async () => {
  const h = harness()
  const qA = { status: { option: 'securable' }, type: 'Breach Ring', stats: [{ type: 'count', value: { min: 2 }, filters: [] }] }
  const qB = { stats: [{ filters: [], value: { min: 2 }, type: 'count' }], type: 'Breach Ring', status: { option: 'securable' } }
  const [r1, r2] = await Promise.all([h.check({ league: 'L', query: qA }), h.check({ league: 'L', query: qB })])
  assert.equal(h.calls.requests.filter(r => r.method === 'POST').length, 1)
  assert.deepEqual(r1, r2)

  await h.check({ league: 'L', query: qA })
  assert.equal(h.calls.requests.filter(r => r.method === 'POST').length, 2)
})

test('budget wait-once retries once; cancel aborts waiting or in-flight search without fetching', async () => {
  const waits = []
  let refusals = 1
  const waitOnce = R.makeRelaxChecker({
    request: async (req) => req.method === 'POST'
      ? { status: 200, headers: {}, body: JSON.stringify({ id: 'W1', result: [ID(1)], total: 1 }) }
      : { status: 200, headers: {}, body: JSON.stringify({ result: [fullListing(ID(1), 5, 'chaos')] }) },
    budget: { acquire: async () => { if (refusals-- > 0) { const e = /** @type {Error & { retryAfter?: number }} */ (new Error('rl')); e.retryAfter = 3; throw e } }, observe: () => {} },
    wait: async (ms) => { waits.push(ms) },
  })
  assert.equal((await waitOnce({ league: 'L', query: RELAXED_Q })).ok, true)
  assert.deepEqual(waits, [3000])

  // Cancel while search is in flight -> no fetch sent, returns cancelled.
  const sent = []
  const c = R.makeRelaxChecker({
    request: async (req) => {
      sent.push(req.method)
      if (req.method === 'POST') {
        c.cancel()
        return { status: 200, headers: {}, body: JSON.stringify({ id: 'C1', result: [ID(1)], total: 1 }) }
      }
      return { status: 200, headers: {}, body: JSON.stringify({ result: [fullListing(ID(1), 5, 'chaos')] }) }
    },
    budget: { acquire: async () => {}, observe: () => {} },
    wait: async () => {},
  })
  assert.deepEqual(await c({ league: 'L', query: RELAXED_Q }), { ok: false, error: 'cancelled' })
  assert.deepEqual(sent, ['POST'])

  // Later click after cancel runs fresh.
  const fresh = R.makeRelaxChecker({
    request: async (req) => req.method === 'POST'
      ? { status: 200, headers: {}, body: JSON.stringify({ id: 'C2', result: [ID(1)], total: 1 }) }
      : { status: 200, headers: {}, body: JSON.stringify({ result: [fullListing(ID(1), 5, 'chaos')] }) },
    budget: { acquire: async () => {}, observe: () => {} },
    wait: async () => {},
  })
  const p1 = fresh({ league: 'L', query: RELAXED_Q })
  fresh.cancel()
  const p2 = fresh({ league: 'L', query: RELAXED_Q })
  assert.notEqual(p1, p2)
  assert.equal((await p2).ok, true)
})

test('IPC registration, preload exposure, and dedicated trade:relax-cancel separation', () => {
  const idx = readFileSync(new URL('../src/trade/index.js', import.meta.url), 'utf8')
  assert.match(idx, /ipcMain\.handle\('trade:relax'/)
  assert.match(idx, /ipcMain\.handle\('trade:relax-cancel', \(\) => \{ relax\.cancel\(\)/)
  assert.doesNotMatch(idx, /trade:listings-cancel[^\n]*relax\.cancel/)
  const pre = readFileSync(new URL('../src/preload.js', import.meta.url), 'utf8')
  assert.match(pre, /relax: \(p\) => ipcRenderer\.invoke\('trade:relax', p\)/)
  assert.match(pre, /relaxCancel: \(\) => ipcRenderer\.invoke\('trade:relax-cancel'\)/)
})
