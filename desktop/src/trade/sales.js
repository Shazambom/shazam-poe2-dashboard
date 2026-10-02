// Trading → Sales (roadmap batch 6): fetch the trade site's Merchant History through the user's own
// logged-in session (proxy.js) under the shared rate budget (policy trade-history), then hand the rows
// to the bundled backend's ledger (POST /api/sales/ingest on loopback). Nothing is written to the
// trade site. Dependencies are injectable for tests.
'use strict'
const { budgeted } = require('./budget.js')

const POLICY = 'trade-history'

function makeSalesFetcher({ request, budget, backendUrl, log = () => {} }) {
  // request({ path, referer }) → { status, headers, body }   budget: { acquire, observe }   backendUrl(): string
  return async function fetchSales(league) {
    const lg = String(league || '').trim()
    if (!lg) return { ok: false, error: 'no league' }
    const res = await budgeted({ request, budget }, POLICY, { path: `/api/trade2/history/poe2/${encodeURIComponent(lg)}`, referer: `https://www.pathofexile.com/trade2/history` })
    if (!res.ok && res.status == null) {   // refused by the budget, or the request never got an answer
      log(`sales-fetch status=${res.error === 'rate' ? 'budget' : 'error'} n=0 policy="${POLICY}"${res.error === 'rate' ? ` retry=${res.retryAfter || '?'}` : ''}`)
      return res.error === 'rate' ? { ok: false, error: 'rate', retryAfter: res.retryAfter } : { ok: false, error: res.error }
    }
    const rows = res.ok && Array.isArray(res.data?.result) ? res.data.result : []
    log(`sales-fetch status=${res.status} n=${rows.length} policy="${POLICY}"`)
    if (!res.ok) return res
    // Only the fields the ledger stores cross to the backend (never the account block).
    const result = rows.filter(r => r && r.item_id && r.time).map(r => ({ item_id: String(r.item_id), time: String(r.time), item: r.item || {}, price: r.price ? { amount: r.price.amount, currency: r.price.currency } : null }))
    let ingest = { new: 0, total: 0 }
    try {
      const r = await fetch(`${backendUrl()}/api/sales/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ league: lg, result }), signal: AbortSignal.timeout(5000) })
      ingest = await r.json()
    } catch (e) { return { ok: false, error: 'backend: ' + String(e && e.message || e), fetched: result.length } }
    log(`sales-ingest new=${ingest.new} total=${ingest.total}`)
    return { ok: true, status: 200, fetched: result.length, new: ingest.new, total: ingest.total }
  }
}

module.exports = { makeSalesFetcher, POLICY }
