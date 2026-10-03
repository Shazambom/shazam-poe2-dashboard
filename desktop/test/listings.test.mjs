// desktop/src/trade/listings.js: the listing projection the trade tap and the reprice sample share, and the
// budgeted fetch behind "search once, click once" (owner, 2026-10-02). A search returns up to 100 listing ids but
// the page loads only the first 10; to see which currencies sit deeper, the app fetches a few of the ids the
// search already returned — never a new search — under the shared rate budget (policy trade-fetch). Only
// {id, amount, currency} goes back: no account, stash, token, whisper or item data.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const L = require('../src/trade/listings.js')

const ID = (i) => i.toString(16).padStart(64, '0')
const listing = (id, amount, currency) => ({ id, listing: { price: { type: '~b/o', amount, currency }, account: { name: 'SECRET#1' }, stash: { name: 'S' }, hideout_token: 'TOKEN', whisper: 'w' }, item: { name: 'Hidden' } })

test('projectRows keeps id, amount and currency, drops gone or unpriced rows and every private field', () => {
  const rows = L.projectRows({ result: [listing(ID(1), 15, 'chaos'), null, { id: ID(2), listing: { price: null } }, listing(ID(3), 139, 'vaal')] })
  assert.deepEqual(rows, [{ id: ID(1), amount: 15, currency: 'chaos' }, { id: ID(3), amount: 139, currency: 'vaal' }])
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|TOKEN|stash|whisper|Hidden/)
  assert.deepEqual(L.projectRows(null), [])
})

function harness({ status = 200, body = { result: [listing(ID(1), 15, 'chaos')] }, refuse = false } = {}) {
  const calls = { acquire: [], observe: [], requests: [] }, lines = []
  const fetchListings = L.makeListingFetcher({
    request: async (r) => { calls.requests.push(r); return { status, headers: { 'x-rate-limit-ip': '12:4:10' }, body: JSON.stringify(body) } },
    budget: { acquire: async (p) => { calls.acquire.push(p); if (refuse) { const e = new Error('rl'); e.retryAfter = 3; throw e } }, observe: (p, s) => calls.observe.push([p, s]) },
    log: (l) => lines.push(l),
    wait: async () => {},
  })
  return { fetchListings, calls, lines }
}

test('one fetch of the given ids for the given search, under trade-fetch, through the user\'s session', async () => {
  const h = harness()
  const r = await h.fetchListings({ league: 'Forbidden Rites', searchId: 'Q1', ids: [ID(1), ID(2)] })
  assert.deepEqual(r, { ok: true, rows: [{ id: ID(1), amount: 15, currency: 'chaos' }] })
  assert.deepEqual(h.calls.acquire, ['trade-fetch'])
  assert.equal(h.calls.requests.length, 1)
  const req = h.calls.requests[0]
  assert.equal(req.method, 'GET')
  assert.equal(req.path, `/api/trade2/fetch/${ID(1)},${ID(2)}?query=Q1&realm=poe2`)
  assert.equal(req.referer, 'https://www.pathofexile.com/trade2/search/poe2/Forbidden%20Rites/Q1')
  assert.deepEqual(h.calls.observe, [['trade-fetch', 200]])
})

test('refused before any request: more than ten ids, malformed ids, a malformed search id, no league', async () => {
  const h = harness()
  for (const bad of [
    { league: 'L', searchId: 'Q1', ids: Array.from({ length: 11 }, (_, i) => ID(i)) },
    { league: 'L', searchId: 'Q1', ids: ['../../api/x'] },
    { league: 'L', searchId: 'Q1', ids: [] },
    { league: 'L', searchId: 'a/b', ids: [ID(1)] },
    { league: '', searchId: 'Q1', ids: [ID(1)] },
  ]) assert.equal((await h.fetchListings(bad)).ok, false, JSON.stringify(bad))
  assert.equal(h.calls.requests.length, 0)
  assert.equal(h.calls.acquire.length, 0)
})

test('a budget refusal or an HTTP error is passed back, never thrown', async () => {
  assert.deepEqual(await harness({ refuse: true }).fetchListings({ league: 'L', searchId: 'Q1', ids: [ID(1)] }), { ok: false, error: 'rate', retryAfter: 3 })
  const r = await harness({ status: 429 }).fetchListings({ league: 'L', searchId: 'Q1', ids: [ID(1)] })
  assert.equal(r.ok, false); assert.equal(r.error, 'rate')
})

test('the tap and the fetcher share one projection; the IPC is registered and exposed', async () => {
  const { readFileSync } = await import('node:fs')
  const tap = readFileSync(new URL('../src/trade/tap.js', import.meta.url), 'utf8')
  assert.match(tap, /require\('\.\/listings\.js'\)/)
  const idx = readFileSync(new URL('../src/trade/index.js', import.meta.url), 'utf8')
  assert.match(idx, /ipcMain\.handle\('trade:listings'/)
  const pre = readFileSync(new URL('../src/preload.js', import.meta.url), 'utf8')
  assert.match(pre, /listings: \(p\) => ipcRenderer\.invoke\('trade:listings', p\)/)
})

// Found driving the packaged app (2026-10-02): a PoE2 search id is the gzip+base64url form of its query, ~140
// characters with '-' and '_' — not a short code. A real one, from the Wombgift search:
const REAL_SEARCH_ID = 'H4sIAAAAAAAAAzWLSwqAIBBArxKz7gQeo02LcDHWGII5omMg4t2zoO37NMiCUjKoBhzFcQAFmfaS0HiCPoPUSIMtdJNH4VSnlS9zOiswf_N4t_ZnGI6BrfNC6RW66_4A7d92SWQAAAA'
test('a real search id (gzip slug form) is accepted and goes into the fetch untouched', async () => {
  const h = harness()
  const r = await h.fetchListings({ league: 'Forbidden Rites', searchId: REAL_SEARCH_ID, ids: [ID(1)] })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(h.calls.requests[0].path, `/api/trade2/fetch/${ID(1)}?query=${REAL_SEARCH_ID}&realm=poe2`)
})

// The budget can refuse for now with a delay. The fetcher waits that delay (capped at 10 s) and tries once more,
// so the window awaits one answer instead of polling (owner, 2026-10-03: "wait patterns are better than polling").
test('a budget "wait" is waited out once, then the fetch goes through; a second refusal is passed back', async () => {
  const waits = [], requests = []
  let refusals = 1
  const fetchListings = L.makeListingFetcher({
    request: async (r) => { requests.push(r); return { status: 200, headers: {}, body: JSON.stringify({ result: [listing(ID(1), 15, 'chaos')] }) } },
    budget: { acquire: async () => { if (refusals-- > 0) { const e = new Error('rl'); e.retryAfter = 3; throw e } }, observe: () => {} },
    wait: async (ms) => { waits.push(ms) },
  })
  assert.deepEqual(await fetchListings({ league: 'L', searchId: 'Q1', ids: [ID(1)] }), { ok: true, rows: [{ id: ID(1), amount: 15, currency: 'chaos' }] })
  assert.deepEqual(waits, [3000]); assert.equal(requests.length, 1)
  refusals = 5
  const again = await fetchListings({ league: 'L', searchId: 'Q1', ids: [ID(1)] })
  assert.equal(again.ok, false); assert.equal(again.error, 'rate')
  assert.deepEqual(waits, [3000, 3000], 'one wait per call, no loop')
  refusals = 1
  const long = L.makeListingFetcher({ request: async () => ({ status: 200, headers: {}, body: '{"result":[]}' }), budget: { acquire: async () => { if (refusals-- > 0) { const e = new Error('rl'); e.retryAfter = 600; throw e } }, observe: () => {} }, wait: async (ms) => waits.push(ms) })
  await long({ league: 'L', searchId: 'Q1', ids: [ID(1)] })
  assert.equal(waits.at(-1), 10000, 'capped at 10 s')
})

// Headroom (owner, 2026-10-03): reprice's listings are a nice-to-have, so they only take spare capacity — the
// budget refuses them unless half of every window the site reports is free.
test('reprice listings ask the budget for spare capacity (half of every window)', async () => {
  const seen = []
  const f = L.makeListingFetcher({ request: async () => ({ status: 200, headers: {}, body: '{"result":[]}' }), budget: { acquire: async (p, o) => seen.push([p, o]), observe: () => {} }, wait: async () => {} })
  await f({ league: 'L', searchId: 'Q1', ids: [ID(1)] })
  assert.deepEqual(seen, [['trade-fetch', { spare: 0.5 }]])
})

// Owner, 2026-10-03: "if the user has changed tabs or moved to a different trade window we need to aggressively
// drop searches that were triggered previously to make space for the new queries."
test('cancel() drops a fetch that is still waiting on the budget — nothing is sent — and later fetches go through', async () => {
  const requests = []
  let release
  let refuse = true
  const f = L.makeListingFetcher({
    request: async (r) => { requests.push(r); return { status: 200, headers: {}, body: '{"result":[]}' } },
    budget: { acquire: async () => { if (refuse) { refuse = false; const e = new Error('rl'); e.retryAfter = 5; throw e } }, observe: () => {} },
    wait: (ms, signal) => new Promise(res => { release = res; signal?.addEventListener('abort', () => res(), { once: true }) }),
  })
  const pending = f({ league: 'L', searchId: 'Q1', ids: [ID(1)] })
  await new Promise(r => setImmediate(r))
  f.cancel()
  assert.deepEqual(await pending, { ok: false, error: 'cancelled' })
  assert.equal(requests.length, 0, 'the dropped fetch never reached the site')
  assert.equal((await f({ league: 'L', searchId: 'Q2', ids: [ID(2)] })).ok, true, 'a new search is not affected')
  assert.equal(requests.length, 1)
  void release
})

test('cancel is exposed to the window over IPC', async () => {
  const { readFileSync } = await import('node:fs')
  const idx = readFileSync(new URL('../src/trade/index.js', import.meta.url), 'utf8')
  assert.match(idx, /ipcMain\.handle\('trade:listings-cancel', \(\) => \{ fetchListings\.cancel\(\); return \{ ok: true \} \}\)/)
  const pre = readFileSync(new URL('../src/preload.js', import.meta.url), 'utf8')
  assert.match(pre, /listingsCancel: \(\) => ipcRenderer\.invoke\('trade:listings-cancel'\)/)
})
