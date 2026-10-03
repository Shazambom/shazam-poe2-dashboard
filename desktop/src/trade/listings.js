// Trade listings: the one projection the trade tap and the reprice sample share ({id, amount, currency} only —
// no account, stash, token, whisper or item data), and the budgeted fetch behind "search once, click once"
// (owner, 2026-10-02): a search returns up to 100 listing ids but the page loads only the first 10, so the app
// fetches a few ids the search already returned — never a new search — through the user's session under the
// shared rate budget (policy trade-fetch). docs/reprice-design.md.
'use strict'
const { budgeted } = require('./budget.js')
const { TRADE_BASE, FETCH_MAX, INSTANT_BUYOUT } = require('./urls.js')

const FETCH_POLICY = 'trade-fetch'
const LISTING_ID = /^[0-9a-f]{16,128}$/
const SEARCH_ID = /^[A-Za-z0-9_-]{1,512}$/   // a gzip+base64url slug (~140 chars), or a short code

function projectRows(json) {
  return (Array.isArray(json?.result) ? json.result : [])
    .filter(x => typeof x?.id === 'string' && Number.isFinite(x.listing?.price?.amount) && typeof x.listing.price.currency === 'string')
    .map(x => ({ id: x.id, amount: x.listing.price.amount, currency: x.listing.price.currency }))
}

const WAIT_CAP_MS = 10_000
const defaultWait = (ms, signal) => new Promise(r => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true }) })
const SPARE = 0.5   // reprice is a nice-to-have: only with half of every rate window free (owner: "be aware of our headroom")
const CANCELLED = Object.freeze({ ok: false, error: 'cancelled' })

// One budgeted request, a budget "not yet" waited out once (capped, abortable), never sent once cancelled. The one
// wait policy both the listings fetcher and the rechecker use.
async function waitedBudgeted(deps, policy, req, signal, wait, opts) {
  if (signal.aborted) return CANCELLED
  let r = await budgeted(deps, policy, req, opts)
  if (!r.ok && r.error === 'rate' && r.status == null && !signal.aborted) {   // refused by the budget before any request
    await wait(Math.min(WAIT_CAP_MS, (Number(r.retryAfter) || 2) * 1000), signal)
    if (signal.aborted) return CANCELLED
    r = await budgeted(deps, policy, req, opts)
  }
  return signal.aborted && !r.ok ? CANCELLED : r
}

// wait(ms, signal): how a budget "not yet" is waited out — once, capped — so the caller awaits one answer, never
// polls. cancel() drops every fetch still waiting (the user switched rows, reloaded or left the tab): it resolves
// { ok:false, error:'cancelled' } and nothing is sent (owner: "aggressively drop searches that were triggered
// previously to make space for the new queries").
function makeListingFetcher({ request, budget, log = () => {}, wait = defaultWait }) {
  const deps = { request, budget }
  let drop = new AbortController()
  async function fetchListings({ league, searchId, ids } = {}) {
    const lg = String(league ?? '').trim()
    if (!lg || !SEARCH_ID.test(String(searchId)) || !Array.isArray(ids) || !ids.length || ids.length > FETCH_MAX || !ids.every(i => LISTING_ID.test(String(i)))) {
      return { ok: false, error: 'bad request' }
    }
    const signal = drop.signal
    const home = `${TRADE_BASE}/search/poe2/${encodeURIComponent(lg)}`
    const req = { method: 'GET', path: `/api/trade2/fetch/${ids.join(',')}?query=${searchId}&realm=poe2`, referer: `${home}/${searchId}` }
    const r = await waitedBudgeted(deps, FETCH_POLICY, req, signal, wait, { spare: SPARE })
    if (!r.ok) { log(`listings status=${r.status ?? r.error}`); return r }
    const rows = projectRows(r.data)
    log(`listings status=200 n=${ids.length} rows=${rows.length}`)
    return { ok: true, rows }
  }
  fetchListings.cancel = () => { drop.abort(); drop = new AbortController() }
  return fetchListings
}

const SEARCH_POLICY = 'trade-search'

// "Find cheapest" (owner, 2026-10-03): the reprice check on demand. The window passes the page's search without its
// currency filter; this runs it once in the background — one budgeted search (Instant Buyout, cheapest first), then
// the first ten listings and a sample across the rest (two fetches). User-triggered, so ordinary priority; a budget
// "not yet" is waited out once; cancel() drops it before anything is sent. Only ids and prices come back.
function makeRechecker({ request, budget, log = () => {}, wait = defaultWait }) {
  const deps = { request, budget }
  let drop = new AbortController()
  const inFlight = new Map()   // identical checks share one search (a double click must not spend two; QA 2026-10-03)
  const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v))
  const once = (policy, req, signal) => waitedBudgeted(deps, policy, req, signal, wait)
  async function recheck({ league, query } = {}) {
    const lg = String(league ?? '').trim()
    if (!lg || !query || typeof query !== 'object' || Array.isArray(query)) return { ok: false, error: 'bad request' }
    const key = `${lg}|${canon(query)}`
    if (inFlight.has(key)) return inFlight.get(key)
    const p = run(lg, query).finally(() => { if (inFlight.get(key) === p) inFlight.delete(key) })
    inFlight.set(key, p)
    return p
  }
  async function run(lg, query) {
    const signal = drop.signal
    const home = `${TRADE_BASE}/search/poe2/${encodeURIComponent(lg)}`
    const body = { query: { ...query, status: INSTANT_BUYOUT }, sort: { price: 'asc' } }
    const s = await once(SEARCH_POLICY, { method: 'POST', path: `/api/trade2/search/poe2/${encodeURIComponent(lg)}`, body, referer: home }, signal)
    if (!s.ok) { log(`recheck status=${s.status ?? s.error} step=search`); return s }
    const searchId = s.data?.id, ids = Array.isArray(s.data?.result) ? s.data.result.filter(i => LISTING_ID.test(String(i))) : [], total = Number(s.data?.total) || 0
    if (!searchId || !ids.length) { log('recheck status=200 total=0'); return { ok: true, searchId: searchId || '', ids: [], total, rows: [] } }
    const sample = []
    for (let r = FETCH_MAX; r < ids.length; r += FETCH_MAX) sample.push(ids[r])
    if (ids.length > FETCH_MAX && sample[sample.length - 1] !== ids[ids.length - 1]) sample.push(ids[ids.length - 1])
    const rows = []
    for (const batch of [ids.slice(0, FETCH_MAX), sample.slice(0, FETCH_MAX)].filter(b => b.length)) {
      const f = await once(FETCH_POLICY, { method: 'GET', path: `/api/trade2/fetch/${batch.join(',')}?query=${searchId}&realm=poe2`, referer: `${home}/${searchId}` }, signal)
      if (!f.ok) { log(`recheck status=${f.status ?? f.error} step=fetch`); return f }
      rows.push(...projectRows(f.data))
    }
    log(`recheck status=200 total=${total} rows=${rows.length}`)
    return { ok: true, searchId, ids, total, rows }
  }
  recheck.cancel = () => { drop.abort(); drop = new AbortController(); inFlight.clear() }   // a later click runs fresh
  return recheck
}

module.exports = { projectRows, makeListingFetcher, makeRechecker, FETCH_POLICY, SEARCH_POLICY }
