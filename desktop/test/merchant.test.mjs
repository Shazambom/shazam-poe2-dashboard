// desktop/src/trade/merchant.js: budgeted fetcher (price_desc | oldest, zero-search Load next 50,
// partial rate-limit preservation, spare: 0.5 headroom) and Merchant-scoped inline pricer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { projectShopRows, parseProfileAccount, makeMerchantFetcher, makeMerchantPricer, MAX_SHOP_ITEMS, CURSOR_TTL_MS } = require('../src/trade/merchant.js')

const ID = (i) => i.toString(16).padStart(64, '0')
const rawEntry = (id, {
  indexed = '2026-11-20T10:00:00Z',
  amount = 50,
  currency = 'exalted',
  name = 'Headhunter',
  typeLine = 'Heavy Belt',
  baseType = 'Heavy Belt',
  rarity = 'Unique',
  frameType = 3,
  icon = 'https://web.poecdn.com/hh.png',
  ilvl = 82,
  note = '~b/o 50 exalted',
  stashName = 'Shop 1',
} = {}) => ({
  id,
  listing: {
    indexed,
    price: { type: '~b/o', amount, currency },
    account: { name: 'SecretPlayer#9999', lastCharacterName: 'HeroChar', online: { league: 'Test' } },
    stash: { name: stashName, x: 1, y: 2 },
    whisper: '@HeroChar Hi, I would like to buy...',
    whisper_token: 'WHISPER_SECRET_TOKEN',
    hideout_token: 'HIDEOUT_SECRET_TOKEN',
  },
  item: {
    name,
    typeLine,
    baseType,
    rarity,
    frameType,
    icon,
    ilvl,
    note,
    corrupted: false,
    explicitMods: ['+50 to maximum Life'],
    secretExtraField: 'SHOULD_NOT_PASS',
  },
})

test('projectShopRows keeps only shop fields and strips whisper, tokens, and account block', async () => {
  const rows = await projectShopRows({
    result: [
      rawEntry(ID(1)),
      null,
      { id: ID(2), listing: { price: null }, item: { name: 'Unpriced' } },
      rawEntry(ID(3), { name: '', typeLine: 'Gold Ring', baseType: 'Gold Ring', rarity: 'Rare', frameType: 2, amount: 2, currency: 'divine' }),
    ],
  })
  assert.equal(rows.length, 2)
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    'amount', 'baseType', 'currency', 'icon', 'id', 'ilvl', 'indexed', 'item', 'name', 'note', 'rarity', 'stashName', 'typeLine',
  ])
  assert.equal(rows[0].id, ID(1))
  assert.equal(rows[0].stashName, 'Shop 1')
  assert.deepEqual(rows[0].item.explicitMods, ['+50 to maximum Life'])
  assert.doesNotMatch(JSON.stringify(rows), /SecretPlayer|HeroChar|WHISPER_SECRET|HIDEOUT_SECRET|whisper|SHOULD_NOT_PASS/)
  assert.deepEqual(await projectShopRows(null), [])
})

/**
 * @param {{ searchIds?: string[], total?: number | null, searchStatus?: number, fetchStatus?: number, refuse?: boolean,
 *   refuseOnFetchNum?: number | null, now?: () => number }} [o]
 */
function harness({ searchIds = [ID(1), ID(2)], total = null, searchStatus = 200, fetchStatus = 200, refuse = false, refuseOnFetchNum = null, now = () => 1700000000000 } = {}) {
  const calls = { acquire: [], observe: [], requests: [] }
  const lines = []
  const byId = new Map(searchIds.map((id, i) => [id, rawEntry(id, { amount: 10 + i })]))
  let fetchCount = 0
  const fetchShop = makeMerchantFetcher({
    request: async (req) => {
      calls.requests.push(req)
      if (req.method === 'POST') {
        return {
          status: searchStatus,
          headers: { 'x-rate-limit-ip': '12:4:10' },
          body: JSON.stringify({ id: 'SEARCH_SHOP_1', result: searchIds, total: total ?? searchIds.length }),
        }
      }
      const m = req.path.match(/\/api\/trade2\/fetch\/([^?]+)/)
      const ids = m ? m[1].split(',') : []
      return {
        status: fetchStatus,
        headers: { 'x-rate-limit-ip': '12:4:10' },
        body: JSON.stringify({ result: ids.map(id => byId.get(id)).filter(Boolean) }),
      }
    },
    budget: {
      acquire: async (policy, opts) => {
        calls.acquire.push([policy, opts])
        if (policy === 'trade-fetch') fetchCount++
        if (refuse || (refuseOnFetchNum != null && policy === 'trade-fetch' && fetchCount >= refuseOnFetchNum)) {
          const e = /** @type {Error & { retryAfter?: number }} */ (new Error('rl'))
          e.retryAfter = 2
          throw e
        }
      },
      observe: (policy, status) => calls.observe.push([policy, status]),
    },
    log: (l) => lines.push(l),
    wait: async () => {},
    now,
  })
  return { fetchShop, calls, lines }
}

test('defaults to price desc sort, supports oldest sort, fetches under spare: 0.5, never logs account name', async () => {
  const h = harness({ searchIds: [ID(1), ID(2)], total: 2 })
  const res = await h.fetchShop({ league: 'Rise of the Abyssal', account: 'MyShop#1234' })
  assert.equal(res.ok, true)
  assert.equal(res.total, 2)
  assert.equal(res.truncated, false)
  assert.equal(res.remainingIds, 0)
  assert.equal(res.sort, 'price_desc')
  assert.equal(res.rows.length, 2)
  assert.equal(res.fetchedAt, 1700000000000)

  assert.equal(h.calls.requests.length, 2)
  assert.deepEqual(h.calls.requests[0].body, {
    query: {
      status: { option: 'securable' },
      filters: { trade_filters: { filters: { account: { input: 'MyShop#1234' } } } },
    },
    sort: { price: 'desc' },
  })
  assert.deepEqual(h.calls.acquire, [
    ['trade-search', { spare: 0.5 }],
    ['trade-fetch', { spare: 0.5 }],
  ])
  assert.doesNotMatch(h.lines.join('\n'), /MyShop#1234/)

  // Explicit oldest sort sends { indexed: 'asc' }
  const h2 = harness({ searchIds: [ID(1)], total: 1 })
  const r2 = await h2.fetchShop({ league: 'Standard', account: 'OldShop#1', sort: 'oldest' })
  assert.equal(r2.ok, true)
  assert.equal(r2.sort, 'oldest')
  assert.deepEqual(h2.calls.requests[0].body.sort, { indexed: 'asc' })
})

test('paginates 50 + 50 with zero extra search calls, reports apiCapReached at 100, and expires stale cursors', async () => {
  assert.equal(MAX_SHOP_ITEMS, 50)
  const ids = Array.from({ length: 100 }, (_, i) => ID(i + 1))
  let t = 1_700_000_000_000
  const h = harness({ searchIds: ids, total: 164, now: () => t })

  // Page 1: 1 search + 5 fetch batches = 6 requests
  const p1 = await h.fetchShop({ league: 'Standard', account: 'BigShop#0001', sort: 'price_desc' })
  assert.equal(p1.ok, true)
  assert.equal(p1.total, 164)
  assert.equal(p1.rows.length, 50)
  assert.equal(p1.truncated, true)
  assert.equal(p1.remainingIds, 50)
  assert.equal(p1.apiCapReached, false)
  assert.equal(h.calls.requests.length, 6)

  // cancel() preserves the pagination cursor so tab switching does not break Load next 50
  h.fetchShop.cancel()

  // Page 2 (more: true): 0 search calls + 5 fetch batches = 11 total requests
  const p2 = await h.fetchShop({ league: 'Standard', account: 'BigShop#0001', sort: 'price_desc', more: true })
  assert.equal(p2.ok, true)
  assert.equal(p2.rows.length, 50)
  assert.equal(p2.remainingIds, 0)
  assert.equal(p2.apiCapReached, true)
  assert.equal(p2.truncated, true)
  assert.equal(h.calls.requests.filter(r => r.method === 'POST').length, 1, 'more:true must not issue a second search')
  assert.equal(h.calls.requests.length, 11)
  assert.equal(p2.rows[0].id, ID(51))
  assert.equal(p2.rows[49].id, ID(100))

  // Expired cursor returns { ok: false, error: 'expired' } instead of silently re-searching page 1
  t += CURSOR_TTL_MS + 1000
  const expired = await h.fetchShop({ league: 'Standard', account: 'BigShop#0001', sort: 'price_desc', more: true })
  assert.deepEqual(expired, { ok: false, error: 'expired' })
  assert.equal(h.calls.requests.filter(r => r.method === 'POST').length, 1)
})

test('preserves already-fetched rows and advances cursor on mid-page rate limit', async () => {
  const ids = Array.from({ length: 30 }, (_, i) => ID(i + 1))
  // Refuse starting on the 3rd trade-fetch batch (after 20 rows fetched)
  const h = harness({ searchIds: ids, total: 30, refuseOnFetchNum: 3 })
  const res = await h.fetchShop({ league: 'Standard', account: 'RateShop#1' })
  assert.equal(res.ok, true)
  assert.equal(res.partial, true)
  assert.equal(res.rateLimited, true)
  assert.equal(res.rows.length, 20)
  assert.equal(res.remainingIds, 10)
})

test('rejects invalid league or overlong account before touching budget or network', async () => {
  const h = harness()
  for (const bad of [{}, { league: '', account: 'A#1' }, { league: 'Standard', account: 'x'.repeat(81) }]) {
    const r = await h.fetchShop(bad)
    assert.equal(r.ok, false)
  }
  assert.equal(h.calls.acquire.length, 0)
  assert.equal(h.calls.requests.length, 0)
})

test('auto-resolves logged-in PoE account directly from /my-account without hitting legacy get-account-name, caches it, and handles auth failure', async () => {
  assert.equal(parseProfileAccount('<a href="/account/view-profile/Dj-Reck1-9507">Dj-Reck1#9507</a>'), 'Dj-Reck1#9507')
  assert.equal(parseProfileAccount('no profile here'), '')

  let accountHits = 0
  const seenPaths = []
  const seenAccounts = []
  const fetcher1 = makeMerchantFetcher({
    request: async (req) => {
      seenPaths.push(req.path)
      if (req.path === '/my-account') {
        accountHits++
        return { status: 200, headers: {}, body: '<div><a href="/account/view-profile/SessionExile-4242">profile</a></div>' }
      }
      if (req.method === 'POST') {
        seenAccounts.push(req.body.query.filters.trade_filters.filters.account.input)
        return { status: 200, headers: {}, body: JSON.stringify({ id: 'S_AUTO', result: [ID(1)], total: 1 }) }
      }
      return { status: 200, headers: {}, body: JSON.stringify({ result: [rawEntry(ID(1))] }) }
    },
    budget: { acquire: async () => {}, observe: () => {} },
    wait: async () => {},
  })
  const r1 = await fetcher1({ league: 'Standard' })
  assert.equal(r1.ok, true)
  assert.equal(r1.account, 'SessionExile#4242')
  assert.equal(accountHits, 1)
  assert.deepEqual(seenAccounts, ['SessionExile#4242'])
  assert.ok(!seenPaths.includes('/character-window/get-account-name'), 'never probes dead PoE1 get-account-name endpoint')

  // Second fetch reuses cached session account without re-requesting /my-account
  const r2 = await fetcher1({ league: 'Standard', sort: 'oldest' })
  assert.equal(r2.ok, true)
  assert.equal(accountHits, 1)

  // resetAccount clears the cache so the next fetch re-resolves
  fetcher1.resetAccount()
  await fetcher1({ league: 'Standard' })
  assert.equal(accountHits, 2)

  // Unauthenticated session returns auth error cleanly
  const fetcher3 = makeMerchantFetcher({
    request: async () => ({ status: 401, headers: {}, body: '' }),
    budget: { acquire: async () => {}, observe: () => {} },
    wait: async () => {},
  })
  const r4 = await fetcher3({ league: 'Standard' })
  assert.deepEqual(r4, { ok: false, error: 'auth', status: 401 })
})

test('cancel() and resetAccount() during in-flight /my-account resolution never poison subsequent callers or cache stale accounts', async () => {
  // 1) cancel() during /my-account resolves caller 1 as cancelled while caller 2 succeeds cleanly
  /** @type {(value?: any) => void} */
  let releaseAcct
  const acctGate = new Promise(r => { releaseAcct = r })
  const fetcher1 = makeMerchantFetcher({
    request: async (req) => {
      if (req.path === '/my-account') {
        await acctGate
        return { status: 200, headers: {}, body: '<a href="/account/view-profile/Recovered-1234">profile</a>' }
      }
      if (req.method === 'POST') return { status: 200, headers: {}, body: JSON.stringify({ id: 'S_REC', result: [ID(1)], total: 1 }) }
      return { status: 200, headers: {}, body: JSON.stringify({ result: [rawEntry(ID(1))] }) }
    },
    budget: { acquire: async () => {}, observe: () => {} },
    wait: async () => {},
  })
  const p1 = fetcher1({ league: 'Standard' })
  fetcher1.cancel()
  const p2 = fetcher1({ league: 'Standard' })
  releaseAcct()
  const [res1, res2] = await Promise.all([p1, p2])
  assert.deepEqual(res1, { ok: false, error: 'cancelled' })
  assert.equal(res2.ok, true)
  assert.equal(res2.account, 'Recovered#1234')

  // 2) resetAccount() during pre-logout /my-account prevents stale Account A from poisoning Account B
  /** @type {(value?: any) => void} */
  let resolveOld
  /** @type {(value?: any) => void} */
  let resolveNew
  let acctCall = 0
  const fetcher2 = makeMerchantFetcher({
    request: async (req) => {
      if (req.path === '/my-account') {
        acctCall++
        if (acctCall === 1) return new Promise(r => { resolveOld = r })
        return new Promise(r => { resolveNew = r })
      }
      if (req.method === 'POST') {
        const acct = req.body.query.filters.trade_filters.filters.account.input
        return { status: 200, headers: {}, body: JSON.stringify({ id: `S_${acct.slice(0, 4)}`, result: [ID(1)], total: 1 }) }
      }
      return { status: 200, headers: {}, body: JSON.stringify({ result: [rawEntry(ID(1))] }) }
    },
    budget: { acquire: async () => {}, observe: () => {} },
    wait: async () => {},
  })
  const oldReq = fetcher2({ league: 'Standard' })
  fetcher2.resetAccount()
  const newReq = fetcher2({ league: 'Standard' })
  resolveOld({ status: 200, headers: {}, body: '<a href="/account/view-profile/OldUser-1111">old</a>' })
  resolveNew({ status: 200, headers: {}, body: '<a href="/account/view-profile/NewUser-2222">new</a>' })
  const [oldRes, newRes] = await Promise.all([oldReq, newReq])
  assert.deepEqual(oldRes, { ok: false, error: 'cancelled' })
  assert.equal(newRes.ok, true)
  assert.equal(newRes.account, 'NewUser#2222')
  // Subsequent call must use cached NewUser#2222, never OldUser#1111
  const followUp = await fetcher2({ league: 'Standard', sort: 'oldest' })
  assert.equal(followUp.ok, true)
  assert.equal(followUp.account, 'NewUser#2222')
  assert.equal(acctCall, 2)
})

test('deduplicates concurrent in-flight fetches for same league/account/sort without colliding across sorts', async () => {
  /** @type {(value?: any) => void} */
  let releaseSearch
  const gate = new Promise(r => { releaseSearch = r })
  let searchCalls = 0
  const fetchShop = makeMerchantFetcher({
    request: async (req) => {
      if (req.method === 'POST') {
        searchCalls++
        await gate
        return { status: 200, headers: {}, body: JSON.stringify({ id: 'S1', result: [ID(1)], total: 1 }) }
      }
      return { status: 200, headers: {}, body: JSON.stringify({ result: [rawEntry(ID(1))] }) }
    },
    budget: { acquire: async () => {}, observe: () => {} },
    wait: async () => {},
  })
  const p1 = fetchShop({ league: 'Standard', account: 'Player#1234', sort: 'price_desc' })
  const p2 = fetchShop({ league: 'Standard', account: 'player#1234', sort: 'price_desc' })
  const p3 = fetchShop({ league: 'Standard', account: 'player#1234', sort: 'oldest' })
  releaseSearch()
  const [r1, r2, r3] = await Promise.all([p1, p2, p3])
  assert.equal(searchCalls, 2, 'same sort coalesces, different sort runs separately')
  assert.deepEqual(r1, r2)
  assert.equal(r3.sort, 'oldest')
})

test('cancel() aborts an in-flight shop fetch and stops remaining batches', async () => {
  const ids = Array.from({ length: 25 }, (_, i) => ID(i + 1))
  /** @type {(value?: any) => void} */
  let releaseFirstBatch
  const batchGate = new Promise(r => { releaseFirstBatch = r })
  let fetchCalls = 0
  const fetchShop = makeMerchantFetcher({
    request: async (req) => {
      if (req.method === 'POST') {
        return { status: 200, headers: {}, body: JSON.stringify({ id: 'S1', result: ids, total: 25 }) }
      }
      fetchCalls++
      if (fetchCalls === 1) await batchGate
      return { status: 200, headers: {}, body: JSON.stringify({ result: [rawEntry(ID(1))] }) }
    },
    budget: { acquire: async () => {}, observe: () => {} },
    wait: async () => {},
  })
  const p = fetchShop({ league: 'Standard', account: 'Player#1234' })
  await new Promise(r => { setTimeout(r, 10) })
  fetchShop.cancel()
  releaseFirstBatch()
  const r = await p
  assert.deepEqual(r, { ok: false, error: 'cancelled' })
  assert.equal(fetchCalls, 1, 'remaining batches must not run after cancel')
})

test('makeMerchantPricer checks Instant Buyout floor with spare: 0.5 headroom, deduplicates in-flight, and cancels cleanly', async () => {
  const acquired = []
  const requests = []
  /** @type {(value?: any) => void} */
  let release
  const gate = new Promise(r => { release = r })
  const priceCheck = makeMerchantPricer({
    request: async (req) => {
      requests.push(req)
      if (req.method === 'POST') {
        await gate
        return { status: 200, headers: {}, body: JSON.stringify({ id: 'PSEARCH1', result: [ID(1), ID(2)], total: 14 }) }
      }
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          result: [
            { id: ID(1), listing: { price: { amount: 12, currency: 'divine' } } },
            { id: ID(2), listing: { price: { amount: 14, currency: 'divine' } } },
          ],
        }),
      }
    },
    budget: { acquire: async (policy, opts) => { acquired.push([policy, opts]) }, observe: () => {} },
    wait: async () => {},
  })

  const q1 = { query: { name: 'Svalinn', type: 'Crucible Tower Shield' } }
  const q2 = { query: { type: 'Crucible Tower Shield', name: 'Svalinn' } }
  const p1 = priceCheck({ league: 'Standard', query: q1 })
  const p2 = priceCheck({ league: 'Standard', query: q2 })
  release()
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1.ok, true)
  assert.equal(r1.total, 14)
  assert.deepEqual(r1.listings, [{ amount: 12, currency: 'divine' }, { amount: 14, currency: 'divine' }])
  assert.deepEqual(r1, r2)
  assert.equal(requests.length, 2, 'concurrent canonical-equal queries share one search + fetch')
  assert.deepEqual(acquired, [['trade-search', { spare: 0.5 }], ['trade-fetch', { spare: 0.5 }]])
  assert.deepEqual(requests[0].body.sort, { price: 'asc' })
  assert.deepEqual(requests[0].body.query.status, { option: 'securable' })

  const bad = await priceCheck({ league: '', query: null })
  assert.deepEqual(bad, { ok: false, error: 'bad request' })
})

test('makeMerchantPricer keeps search ids on fetch rate-limit so retry skips trade-search', async () => {
  let searchCount = 0
  let fetchCount = 0
  let failFetch = true
  const priceCheck = makeMerchantPricer({
    request: async (req) => {
      if (req.method === 'POST') {
        searchCount++
        return { status: 200, headers: {}, body: JSON.stringify({ id: 'KEPT_SEARCH', result: [ID(1)], total: 5 }) }
      }
      fetchCount++
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ result: [{ id: ID(1), listing: { price: { amount: 9, currency: 'divine' } } }] }),
      }
    },
    budget: {
      acquire: async (policy) => {
        if (policy === 'trade-fetch' && failFetch) {
          const e = /** @type {Error & { retryAfter?: number }} */ (new Error('rl'))
          e.retryAfter = 1
          throw e
        }
      },
      observe: () => {},
    },
    wait: async () => {},
  })

  const first = await priceCheck({ league: 'Standard', query: { query: { name: 'Headhunter' } } })
  assert.equal(first.ok, false)
  assert.equal(first.error, 'rate')
  assert.equal(searchCount, 1)
  assert.equal(fetchCount, 0)

  failFetch = false
  const retry = await priceCheck({ league: 'Standard', query: { query: { name: 'Headhunter' } } })
  assert.equal(retry.ok, true)
  assert.equal(searchCount, 1, 'retry must reuse kept searchId without re-spending trade-search')
  assert.equal(fetchCount, 1)
  assert.deepEqual(retry.listings, [{ amount: 9, currency: 'divine' }])
})

test('projectShopRows resolves Rare mods via shared modsearch catalogue without altering Unique row keys', async () => {
  const rows = await projectShopRows({
    result: [
      rawEntry(ID(10), {
        name: 'Bramble Finger',
        typeLine: 'Gold Ring',
        baseType: 'Gold Ring',
        rarity: 'Rare',
        frameType: 2,
      }),
    ],
  })
  assert.equal(rows.length, 1)
  assert.ok(rows[0].matchedMods, 'Rare item gets matchedMods from EE2 stat catalogue')
  assert.equal(rows[0].matchedMods.category, 'accessory.ring')
  assert.ok(rows[0].matchedMods.mods.length >= 1)
  assert.equal(rows[0].matchedMods.mods[0].value, 50)
})

test('makeMerchantPricer delegates to makeRechecker and samples deeper ranks past page 1', async () => {
  const allIds = Array.from({ length: 25 }, (_, i) => ID(i + 1))
  const fetchBatches = []
  const priceCheck = makeMerchantPricer({
    request: async (req) => {
      if (req.method === 'POST') {
        return { status: 200, headers: {}, body: JSON.stringify({ id: 'DEEP_S', result: allIds, total: 25 }) }
      }
      const ids = req.path.match(/\/api\/trade2\/fetch\/([^?]+)/)[1].split(',')
      fetchBatches.push(ids)
      const result = ids.map(id => ({
        id,
        listing: {
          price: id === ID(21) ? { amount: 50, currency: 'chaos' } : { amount: 200, currency: 'exalted' },
        },
      }))
      return { status: 200, headers: {}, body: JSON.stringify({ result }) }
    },
    budget: { acquire: async () => {}, observe: () => {} },
    wait: async () => {},
  })

  const res = await priceCheck({ league: 'Standard', query: { query: { name: 'Headhunter' } } })
  assert.equal(res.ok, true)
  assert.equal(fetchBatches.length, 2, 'samples first 10 plus deeper ranks via makeRechecker')
  assert.ok(res.listings.some(l => l.currency === 'chaos' && l.amount === 50))
})

test('IPC handlers merchant:fetch, merchant:price-check, and scoped merchant:cancel are registered and exposed in preload, and every main.js session-change path resets cached merchant account', () => {
  const idx = readFileSync(new URL('../src/trade/index.js', import.meta.url), 'utf8')
  assert.match(idx, /ipcMain\.handle\('merchant:fetch'/)
  assert.match(idx, /ipcMain\.handle\('merchant:price-check'/)
  assert.match(idx, /ipcMain\.handle\('merchant:cancel',[\s\S]*scope/)
  const pre = readFileSync(new URL('../src/preload.js', import.meta.url), 'utf8')
  assert.match(pre, /merchant:\s*\{[\s\S]*merchant:fetch[\s\S]*merchant:price-check[\s\S]*cancel:\s*\(opts\)\s*=>\s*ipcRenderer\.invoke\('merchant:cancel',\s*opts\)/)
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  assert.match(main, /async function connectPoeSession\([\s\S]*?resetMerchantAccount\(\)[\s\S]*?win\?\.webContents\.reload\(\)/)
  assert.match(main, /ipcMain\.handle\('poe-connect'[\s\S]*?resetMerchantAccount\(\)/)
  assert.match(main, /ipcMain\.handle\('poe-set-cookie'[\s\S]*?resetMerchantAccount\(\)/)
  assert.match(main, /Log out of pathofexile\.com[\s\S]*?resetMerchantAccount\(\)/)
})
