// Wires the live-search engine to the renderer over IPC. Call registerTrade(getWin)
// once from app.whenReady. All trade traffic stays in main (Cloudflare/session); the
// renderer only sends intents and receives pings/state.
'use strict'
const { ignored } = require('../ignored.js')
const { ipcMain } = require('electron')
const { installCloudflareCookieFix } = require('./proxy.js')
const engine = require('./engine.js')

let _resetMerchantAccount = () => {}

// getBackendUrl: where the bundled backend (the rate-budget owner) lives — set once it has bound.
function registerTrade(getWin, getBackendUrl) {
  installCloudflareCookieFix()
  if (getBackendUrl) require('./budget.js').configure({ backendUrl: getBackendUrl })

  // Engine -> renderer: forward every engine event to the focused window's webContents.
  engine.setSink((channel, payload) => {
    try { getWin()?.webContents.send(channel, payload) } catch (e) { ignored('trade:send', e) }
  })

  ipcMain.handle('trade:start-search', (_e, { itemId, league, slug, type }) =>
    engine.startSearch(itemId, league, slug, type))
  ipcMain.handle('trade:stop-search', (_e, { itemId }) => { engine.stopSearch(itemId); return { ok: true } })
  // Trading → Mods → Search on trade: what the site calls a mod and an item kind (EE2's data, read once).
  ipcMain.handle('mods:lookup', (_e, p) => require('./modsearch.js').lookup(p || {}))
  // Sales tab (roadmap batch 6): Merchant History through the user's session under policy trade-history.
  const salesFetch = require('./sales.js').makeSalesFetcher({
    request: (r) => require('./proxy.js').poeRequest({ method: 'GET', path: r.path, referer: r.referer }),
    budget: require('./budget.js'), backendUrl: () => (getBackendUrl ? getBackendUrl() : 'http://127.0.0.1:8210'),
    log: (line) => { try { require('../telemetry.js').installLog('sales', line) } catch (e) { ignored('trade:log', e) } },
  })
  ipcMain.handle('sales:fetch', (_e, p) => salesFetch(p?.league).catch(e => ({ ok: false, error: String(e && e.message || e) })))
  // Stash → Merchant: active Instant Buyout shop listings + inline floor checks under spare: 0.5 headroom.
  const { makeMerchantFetcher, makeMerchantPricer } = require('./merchant.js')
  const merchantFetch = makeMerchantFetcher({
    request: (r) => require('./proxy.js').poeRequest(r),
    budget: require('./budget.js'),
    log: (line) => { try { require('../telemetry.js').installLog('merchant', line) } catch (e) { ignored('trade:log', e) } },
  })
  _resetMerchantAccount = () => merchantFetch.resetAccount()
  const merchantPriceCheck = makeMerchantPricer({
    request: (r) => require('./proxy.js').poeRequest(r),
    budget: require('./budget.js'),
    log: (line) => { try { require('../telemetry.js').installLog('merchant', line) } catch (e) { ignored('trade:log', e) } },
  })
  ipcMain.handle('merchant:fetch', (_e, p) => merchantFetch(p || {}).catch(e => ({ ok: false, error: String(e && e.message || e) })))
  ipcMain.handle('merchant:price-check', (_e, p) => merchantPriceCheck(p || {}).catch(e => ({ ok: false, error: String(e && e.message || e) })))
  ipcMain.handle('merchant:cancel', (_e, p) => {
    const scope = p?.scope || 'all'
    if (scope === 'all' || scope === 'fetch') merchantFetch.cancel()
    if (scope === 'all' || scope === 'price') merchantPriceCheck.cancel()
    return { ok: true }
  })
  ipcMain.handle('trade:uniques', () => require('./uniqueprice.js').uniques())
  // Strat Calculator: a search's cheapest listings (a unique's floor, a linked tablet or waystone search).
  const priceQuery = require('./uniqueprice.js').makeQueryPricer({
    request: (r) => require('./proxy.js').poeRequest(r),
    budget: require('./budget.js'),
    log: (line) => { try { require('../telemetry.js').installLog('query-price', line) } catch (e) { ignored('trade:log', e) } },
  })
  // Trading → Workspace reprice: a few listings of a search the page already ran (ids it returned), so one search
  // is enough to see which currencies sit deeper than the page has loaded (trade/listings.js).
  const fetchListings = require('./listings.js').makeListingFetcher({
    request: (r) => require('./proxy.js').poeRequest(r),
    budget: require('./budget.js'),
    log: (line) => { try { require('../telemetry.js').installLog('tap', line) } catch (e) { ignored('trade:log', e) } },
  })
  ipcMain.handle('trade:listings', (_e, p) => fetchListings(p || {}).catch(e => ({ ok: false, error: String(e && e.message || e) })))
  // "Find cheapest": the reprice check on demand (one budgeted search + two fetches; user-triggered only).
  const recheck = require('./listings.js').makeRechecker({
    request: (r) => require('./proxy.js').poeRequest(r),
    budget: require('./budget.js'),
    log: (line) => { try { require('../telemetry.js').installLog('tap', line) } catch (e) { ignored('trade:log', e) } },
  })
  ipcMain.handle('trade:recheck', (_e, p) => recheck(p || {}).catch(e => ({ ok: false, error: String(e && e.message || e) })))
  // "Close enough": relaxed rare search check on demand (1 budgeted search + 1 fetch of top 10; user-triggered only).
  const relax = require('./relax.js').makeRelaxChecker({
    request: (r) => require('./proxy.js').poeRequest(r),
    budget: require('./budget.js'),
    log: (line) => { try { require('../telemetry.js').installLog('tap', line) } catch (e) { ignored('trade:log', e) } },
  })
  ipcMain.handle('trade:relax', (_e, p) => relax(p || {}).catch(e => ({ ok: false, error: String(e && e.message || e) })))
  ipcMain.handle('trade:relax-cancel', () => { relax.cancel(); return { ok: true } })
  ipcMain.handle('trade:listings-cancel', () => { fetchListings.cancel(); recheck.cancel(); return { ok: true } })
  ipcMain.handle('trade:query-price', (_e, p) => priceQuery(p || {}).catch(e => ({ ok: false, error: String(e && e.message || e) })))
  ipcMain.handle('trade:teleport', async (_e, { token }) => {
    try { return await engine.teleport(token) }
    catch (e) { return { success: false, error: e.code || 'error', message: String(e.message || e), retryAfter: e.retryAfter } }
  })
}

function resetMerchantAccount() { _resetMerchantAccount() }

module.exports = { registerTrade, resetMerchantAccount, engine }
