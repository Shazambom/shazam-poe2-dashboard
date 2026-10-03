// Trade listings: the one projection the trade tap and the reprice sample share ({id, amount, currency} only —
// no account, stash, token, whisper or item data), and the budgeted fetch behind "search once, click once"
// (owner, 2026-10-02): a search returns up to 100 listing ids but the page loads only the first 10, so the app
// fetches a few ids the search already returned — never a new search — through the user's session under the
// shared rate budget (policy trade-fetch). docs/reprice-design.md.
'use strict'
const { budgeted } = require('./budget.js')
const { TRADE_BASE, FETCH_MAX } = require('./urls.js')

const FETCH_POLICY = 'trade-fetch'
const LISTING_ID = /^[0-9a-f]{16,128}$/
const SEARCH_ID = /^[A-Za-z0-9_-]{1,512}$/   // a gzip+base64url slug (~140 chars), or a short code

function projectRows(json) {
  return (Array.isArray(json?.result) ? json.result : [])
    .filter(x => typeof x?.id === 'string' && Number.isFinite(x.listing?.price?.amount) && typeof x.listing.price.currency === 'string')
    .map(x => ({ id: x.id, amount: x.listing.price.amount, currency: x.listing.price.currency }))
}

const WAIT_CAP_MS = 10_000
const SPARE = 0.5   // reprice is a nice-to-have: only with half of every rate window free (owner: "be aware of our headroom")

// wait(ms, signal): how a budget "not yet" is waited out — once, capped — so the caller awaits one answer, never
// polls. cancel() drops every fetch still waiting (the user switched rows, reloaded or left the tab): it resolves
// { ok:false, error:'cancelled' } and nothing is sent (owner: "aggressively drop searches that were triggered
// previously to make space for the new queries").
function makeListingFetcher({ request, budget, log = () => {}, wait = (ms, signal) => new Promise(r => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true }) }) }) {
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
    let r = await budgeted(deps, FETCH_POLICY, req, { spare: SPARE })
    if (!r.ok && r.error === 'rate' && r.status == null && !signal.aborted) {   // refused by the budget before any request
      await wait(Math.min(WAIT_CAP_MS, (Number(r.retryAfter) || 2) * 1000), signal)
      if (signal.aborted) return { ok: false, error: 'cancelled' }
      r = await budgeted(deps, FETCH_POLICY, req, { spare: SPARE })
    }
    if (signal.aborted && !r.ok) return { ok: false, error: 'cancelled' }
    if (!r.ok) { log(`listings status=${r.status ?? r.error}`); return r }
    const rows = projectRows(r.data)
    log(`listings status=200 n=${ids.length} rows=${rows.length}`)
    return { ok: true, rows }
  }
  fetchListings.cancel = () => { drop.abort(); drop = new AbortController() }
  return fetchListings
}

module.exports = { projectRows, makeListingFetcher, FETCH_POLICY }
