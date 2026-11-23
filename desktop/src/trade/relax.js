// Feature 3: budgeted relax checker for "Close-enough" fuzzy rare searches.
// User-triggered only; hard cap of 1 trade-search + 1 trade-fetch (top 10 listings) per click.
// Reuses listings.js's {id, amount, currency} projection — strips account, whisper, stash, and item data.
'use strict'
const {
  makeRechecker,
  projectRows,
  defaultWait,
  SEARCH_POLICY,
  FETCH_POLICY,
} = require('./listings.js')

/** @param {import('./listings.js').TradeDeps} deps */
function makeRelaxChecker({ request, budget, log = () => {}, wait = defaultWait }) {
  const recheck = makeRechecker({ request, budget, log, wait, sample: false, tag: 'relax' })
  async function check(req) {
    const r = await recheck(req)
    if (!r?.ok) return r
    return { ok: true, searchId: r.searchId, total: r.total, rows: r.rows }
  }
  check.cancel = () => recheck.cancel()
  return check
}

module.exports = { makeRelaxChecker, projectRows, SEARCH_POLICY, FETCH_POLICY }
