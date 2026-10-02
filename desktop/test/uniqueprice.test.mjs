// desktop/src/trade/uniqueprice.js: Strat Calculator's price floor for a unique (owner, 2026-10-01:
// "a search tab in the background that just searches for an uncorrupted version of that item and get
// the lowest price"). One search (Instant Buyout, uncorrupted, cheapest first) under the shared budget,
// then one fetch of the cheapest listings; the renderer turns them into divines.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const U = require('../src/trade/uniqueprice.js')

const SEARCH = { id: 'Ab12Cd', result: Array.from({ length: 25 }, (_, i) => `id${i}`), total: 25 }
const listing = (amount, currency) => ({ id: 'x', listing: { price: { type: '~price', amount, currency }, account: { name: 'SECRET' } }, item: { name: 'Mageblood', typeLine: 'Utility Belt' } })
const FETCH = { result: [listing(140, 'divine'), listing(150, 'divine'), listing(80000, 'exalted')] }

const UNIQUE_Q = { query: { status: { option: 'securable' }, name: 'Mageblood', type: 'Utility Belt' }, sort: { price: 'asc' } }

function harness({ search = { status: 200, body: JSON.stringify(SEARCH) }, fetch = { status: 200, body: JSON.stringify(FETCH) }, refuse = null } = {}) {
  const calls = { acquire: [], observe: [], requests: [] }, lines = []
  const price = U.makeQueryPricer({
    request: async (r) => { calls.requests.push(r); const x = r.method === 'POST' ? search : fetch; return { status: x.status, headers: { 'x-rate-limit-ip': '5:10:60', 'retry-after': '30' }, body: x.body } },
    budget: {
      acquire: async (p) => { calls.acquire.push(p); if (refuse === p) { const e = new Error('rl'); e.retryAfter = 7; throw e } },
      observe: (p, s) => calls.observe.push([p, s]),
    },
    log: (l) => lines.push(l),
  })
  return { price, calls, lines }
}

test('every priced query goes out Instant Buyout, cheapest first, whatever it asked for; its filters untouched', async () => {
  // the one place a priced query leaves the app (memory: every built query carries status securable)
  const { price, calls } = harness()
  const asked = { query: { status: { option: 'online' }, type: 'Breach Tablet', stats: [{ type: 'and', filters: [] }] }, sort: { 'stat.x': 'desc' } }
  await price({ query: asked, league: 'L' })
  assert.deepEqual(calls.requests[0].body, { query: { status: { option: 'securable' }, type: 'Breach Tablet', stats: [{ type: 'and', filters: [] }] }, sort: { price: 'asc' } })
  assert.deepEqual(asked.query.status, { option: 'online' }, 'the caller\'s object is not changed')
  assert.deepEqual(U.INSTANT_BUYOUT, { option: 'securable' })
})

test('one search, then one fetch of the cheapest listings, each under its own budget policy', async () => {
  const { price, calls } = harness()
  const r = await price({ query: UNIQUE_Q, league: 'Forbidden Rites' })
  assert.deepEqual(calls.acquire, [U.SEARCH_POLICY, U.FETCH_POLICY])
  assert.equal(U.SEARCH_POLICY, 'trade-search')
  assert.equal(U.FETCH_POLICY, 'trade-fetch')
  const [s, f] = calls.requests
  assert.equal(s.method, 'POST')
  assert.equal(s.path, '/api/trade2/search/poe2/Forbidden%20Rites')
  assert.deepEqual(s.body, UNIQUE_Q)
  assert.equal(f.method, 'GET')
  assert.equal(f.path, `/api/trade2/fetch/${SEARCH.result.slice(0, U.FETCH_N).join(',')}?query=Ab12Cd&realm=poe2`)
  assert.equal(U.FETCH_N, 10, 'one fetch: the trade site gives at most ten per call')
  assert.deepEqual(calls.observe, [[U.SEARCH_POLICY, 200], [U.FETCH_POLICY, 200]])
  assert.deepEqual(r, { ok: true, total: 25, listings: [{ amount: 140, currency: 'divine' }, { amount: 150, currency: 'divine' }, { amount: 80000, currency: 'exalted' }] })
  assert.ok(!JSON.stringify(r).includes('SECRET'), 'only prices cross to the renderer')
})

test('nothing listed is an answer, not an error, and costs no fetch', async () => {
  const { price, calls } = harness({ search: { status: 200, body: JSON.stringify({ id: 'z', result: [], total: 0 }) } })
  assert.deepEqual(await price({ query: UNIQUE_Q, league: 'L' }), { ok: true, total: 0, listings: [] })
  assert.equal(calls.requests.length, 1)
})

test('not logged in, rate-limited, refused by the budget: each says so and stops', async () => {
  const q = { query: UNIQUE_Q, league: 'L' }
  const auth = harness({ search: { status: 403, body: '' } })
  assert.deepEqual(await auth.price(q), { ok: false, error: 'auth', status: 403 })
  const rl = harness({ search: { status: 429, body: '' } })
  assert.deepEqual(await rl.price(q), { ok: false, error: 'rate', status: 429, retryAfter: 30 })
  const budget = harness({ refuse: 'trade-search' })
  assert.deepEqual(await budget.price(q), { ok: false, error: 'rate', retryAfter: 7 })
  assert.equal(budget.calls.requests.length, 0, 'a refused slot never reaches the site')
  const fetchRl = harness({ refuse: 'trade-fetch' })
  assert.deepEqual(await fetchRl.price(q), { ok: false, error: 'rate', retryAfter: 7 })
  assert.equal(fetchRl.calls.requests.length, 1)
})

test('the uniques come from the trade site\'s own item list (EE2 data), name and base', () => {
  const list = U.uniques()
  assert.ok(list.length > 500)
  assert.ok(list.some(u => u.name === 'Headhunter' && u.type === 'Heavy Belt'))
  assert.ok(list.every(u => u.name && u.type))
  const keys = list.map(u => `${u.name}|${u.type}`)
  assert.equal(new Set(keys).size, keys.length, 'one entry per unique and base')
})

test('repro (review #5): a refused fetch keeps its search, so the retry spends no second search', async () => {
  let refuseFetch = true
  const calls = { acquire: [], requests: [] }
  const price = U.makeQueryPricer({
    request: async (r) => { calls.requests.push(r.method); return { status: 200, headers: {}, body: JSON.stringify(r.method === 'POST' ? SEARCH : FETCH) } },
    budget: {
      acquire: async (p) => { calls.acquire.push(p); if (p === 'trade-fetch' && refuseFetch) { const e = new Error('rl'); e.retryAfter = 30; throw e } },
      observe: () => {},
    },
  })
  const q = { query: UNIQUE_Q, league: 'L' }
  assert.deepEqual(await price(q), { ok: false, error: 'rate', retryAfter: 30 })
  refuseFetch = false
  const r = await price(q)
  assert.equal(r.ok, true)
  assert.deepEqual(calls.requests, ['POST', 'GET'], 'one search in all: the retry only fetched')
  assert.deepEqual(calls.acquire, ['trade-search', 'trade-fetch', 'trade-fetch'])
  await price(q)
  assert.deepEqual(calls.requests, ['POST', 'GET', 'POST', 'GET'], 'once fetched, the kept search is used up: the next ask searches afresh')
})

// ---------------------------------------------------------------- any search (tablets, waystones)
// owner, 2026-10-01: "create a search page for the tablets and waystones to auto calculate the cost".
// The same engine prices whatever search the user linked (the renderer has already held a tablet
// search to full uses); the unique floor is this engine with the unique's own query.
function queryHarness({ search = { status: 200, body: JSON.stringify(SEARCH) }, fetch = { status: 200, body: JSON.stringify(FETCH) } } = {}) {
  const calls = { acquire: [], requests: [] }
  const price = U.makeQueryPricer({
    request: async (r) => { calls.requests.push(r); const x = r.method === 'POST' ? search : fetch; return { status: x.status, headers: {}, body: x.body } },
    budget: { acquire: async (p) => { calls.acquire.push(p) }, observe: () => {} },
  })
  return { price, calls }
}
const TABLETS = { query: { status: { option: 'securable' }, type: 'Breach Tablet', stats: [{ type: 'and', filters: [{ id: 'pseudo.pseudo_number_of_uses_remaining', value: { min: 10 } }] }] }, sort: { price: 'asc' } }

test('a linked search is sent as it is; its cheapest ten listings come back', async () => {
  const { price, calls } = queryHarness()
  const r = await price({ query: TABLETS, league: 'Forbidden Rites' })
  assert.deepEqual(calls.acquire, ['trade-search', 'trade-fetch'])
  assert.deepEqual(calls.requests[0].body, TABLETS)
  assert.equal(calls.requests[0].path, '/api/trade2/search/poe2/Forbidden%20Rites')
  assert.equal(r.ok, true)
  assert.equal(r.listings.length, 3)
})

test('a search without a query or a league is refused before anything is spent', async () => {
  const { price, calls } = queryHarness()
  for (const bad of [{}, { query: TABLETS }, { query: null, league: 'L' }, { query: { sort: {} }, league: 'L' }]) assert.equal((await price(bad)).ok, false)
  assert.equal(calls.acquire.length, 0)
})

test('one pricer: no unique-only engine or channel (a unique is a query like any other)', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync(new URL('../src/trade/uniqueprice.js', import.meta.url), 'utf8')
  assert.equal((src.match(/budgeted\(/g) || []).length, 2, 'one search and one fetch call site')
  assert.ok(!src.includes('makeUniquePricer') && !src.includes('uniqueQuery'))
  const idx = fs.readFileSync(new URL('../src/trade/index.js', import.meta.url), 'utf8')
  const pre = fs.readFileSync(new URL('../src/preload.js', import.meta.url), 'utf8')
  assert.ok(!idx.includes('trade:unique-price') && !pre.includes('priceUnique'))
  assert.ok(idx.includes("ipcMain.handle('trade:uniques'") && pre.includes("uniques: () => ipcRenderer.invoke('trade:uniques')"))
})

test('the renderer prices a search over IPC', () => {
  const fs = require('node:fs')
  const idx = fs.readFileSync(new URL('../src/trade/index.js', import.meta.url), 'utf8')
  assert.ok(idx.includes("ipcMain.handle('trade:query-price'"))
  const pre = fs.readFileSync(new URL('../src/preload.js', import.meta.url), 'utf8')
  assert.ok(pre.includes("priceQuery: (p) => ipcRenderer.invoke('trade:query-price', p)"))
})
