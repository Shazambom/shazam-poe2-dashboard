// Stash → Strat Calculator: a price from a trade search (a unique's floor, a linked tablet or
// waystone search; the renderer builds the query): one background search and one fetch of the
// cheapest listings, through the user's own logged-in session (proxy.js) under the shared rate budget
// (policy trade-search for the search, trade-fetch for the listings). Only the prices go back to the
// renderer, which turns them into divines with the app's one value table. Dependencies are injectable.
'use strict'
const fsp = require('node:fs').promises
const path = require('node:path')

const { budgeted } = require('./budget.js')
const { lazyAsync } = require('./lazy.js')
const { TRADE_BASE, FETCH_MAX, INSTANT_BUYOUT } = require('./urls.js')

const SEARCH_POLICY = 'trade-search'
const FETCH_POLICY = 'trade-fetch'
const KEEP_MS = 5 * 60_000   // a search whose fetch was refused is kept this long, so its retry only fetches

// Every unique the trade site knows, by name and base: its own item list (EE2's data, synced every
// release), read once. Callers that overlap share the one read. A read that fails throws to its callers
// and is forgotten, so the next call reads again.
const uniques = lazyAsync(loadUniques)

async function loadUniques() {
  /** @type {Array<{ name: string, type: string }>} */
  const list = []
  const file = path.join(__dirname, '..', 'vendor', 'ee2-query', 'data', 'trade', 'items.json')
  const seen = new Set()
  for (const g of JSON.parse(await fsp.readFile(file, 'utf8')).result) {
    for (const e of g.entries) {
      if (!e.flags?.unique || !e.name || !e.type) continue
      const key = `${e.name}|${e.type}`
      if (seen.has(key)) continue
      seen.add(key)
      list.push({ name: e.name, type: e.type })
    }
  }
  return list
}

const clean = (s) => String(s ?? '').trim()

// What a search leaves to fetch: its id, its first FETCH_MAX listing ids, its total, when it ran.
function searchKept(data) {
  return { id: data?.id, ids: Array.isArray(data?.result) ? data.result.slice(0, FETCH_MAX) : [], total: Number(data?.total) || 0, at: Date.now() }
}

// The priced listings of a fetch: positive finite amounts with a currency, nothing else.
function listingPrices(data) {
  return (data?.result || [])
    .map(x => x?.listing?.price)
    .filter(p => p && Number.isFinite(p.amount) && p.amount > 0 && typeof p.currency === 'string')
    .map(p => ({ amount: p.amount, currency: p.currency }))
}

// Any search (a unique's floor, a linked tablet or waystone search): one search under the shared
// budget, then one fetch of its cheapest listings. Only the prices go back. This is where a priced
// query leaves the app, so it goes out Instant Buyout, cheapest first, whatever it asked for.
/** @param {import('./listings.js').TradeDeps & { tag?: string }} deps */
function makeQueryPricer({ request, budget, log = () => {}, tag = 'query-price' }) {
  // request({ method, path, body, referer }) → { status, headers, body }   budget: { acquire, observe }
  const deps = { request, budget }
  const kept = new Map()   // league + query → { id, ids, total, at }: searched, not yet fetched
  function fetchFailed(fetched, key, s) {
    if (fetched.error === 'rate') kept.set(key, s)   // the search stays good: the retry only fetches
    else kept.delete(key)
    log(`${tag} status=${fetched.status ?? fetched.error} step=fetch`)
    return fetched
  }
  /**
   * @param {{ query?: Record<string, any>, league?: string }} [q]
   * @returns {Promise<import('./budget.js').Budgeted & { total?: number, listings?: Array<{ amount: number, currency: string }> }>}
   */
  return async function priceQuery({ query, league } = {}) {
    const lg = clean(league)
    if (!query?.query || typeof query.query !== 'object' || !lg) return { ok: false, error: 'a search needs its query and the league' }
    const home = `${TRADE_BASE}/search/poe2/${encodeURIComponent(lg)}`
    const key = `${lg}|${JSON.stringify(query)}`
    let s = kept.get(key)
    if (!s || Date.now() - s.at > KEEP_MS) {
      const body = { query: { ...query.query, status: INSTANT_BUYOUT }, sort: { price: 'asc' } }
      const search = await budgeted(deps, SEARCH_POLICY, { method: 'POST', path: `/api/trade2/search/poe2/${encodeURIComponent(lg)}`, body, referer: home })
      if (!search.ok) { log(`${tag} status=${search.status ?? search.error} step=search`); return search }
      s = searchKept(search.data)
    }
    const { id, ids, total } = s
    if (!ids.length || !id) { kept.delete(key); log(`${tag} status=200 total=0`); return { ok: true, total, listings: [] } }
    const fetched = await budgeted(deps, FETCH_POLICY, { method: 'GET', path: `/api/trade2/fetch/${ids.join(',')}?query=${id}&realm=poe2`, referer: `${home}/${id}` })
    if (!fetched.ok) return fetchFailed(fetched, key, s)
    kept.delete(key)
    const listings = listingPrices(fetched.data)
    log(`${tag} status=200 total=${total} listings=${listings.length}`)
    return { ok: true, total, listings }
  }
}

module.exports = { makeQueryPricer, uniques, INSTANT_BUYOUT, SEARCH_POLICY, FETCH_POLICY, FETCH_N: FETCH_MAX }
