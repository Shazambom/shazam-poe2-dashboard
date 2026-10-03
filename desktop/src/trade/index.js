// Wires the live-search engine to the renderer over IPC. Call registerTrade(getWin)
// once from app.whenReady. All trade traffic stays in main (Cloudflare/session); the
// renderer only sends intents and receives pings/state.
const { ipcMain } = require('electron')
const { installCloudflareCookieFix } = require('./proxy.js')
const engine = require('./engine.js')

// getBackendUrl: where the bundled backend (the rate-budget owner) lives — set once it has bound.
function registerTrade(getWin, getBackendUrl) {
  installCloudflareCookieFix()
  if (getBackendUrl) require('./budget.js').configure({ backendUrl: getBackendUrl })

  // Engine -> renderer: forward every engine event to the focused window's webContents.
  engine.setSink((channel, payload) => {
    try { getWin()?.webContents.send(channel, payload) } catch {}
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
    log: (line) => { try { require('../telemetry.js').installLog('sales', line) } catch {} },
  })
  ipcMain.handle('sales:fetch', (_e, p) => salesFetch(p?.league).catch(e => ({ ok: false, error: String(e && e.message || e) })))
  ipcMain.handle('trade:uniques', () => require('./uniqueprice.js').uniques())
  // Strat Calculator: a search's cheapest listings (a unique's floor, a linked tablet or waystone search).
  const priceQuery = require('./uniqueprice.js').makeQueryPricer({
    request: (r) => require('./proxy.js').poeRequest(r),
    budget: require('./budget.js'),
    log: (line) => { try { require('../telemetry.js').installLog('query-price', line) } catch {} },
  })
  // Trading → Workspace reprice: a few listings of a search the page already ran (ids it returned), so one search
  // is enough to see which currencies sit deeper than the page has loaded (trade/listings.js).
  const fetchListings = require('./listings.js').makeListingFetcher({
    request: (r) => require('./proxy.js').poeRequest(r),
    budget: require('./budget.js'),
    log: (line) => { try { require('../telemetry.js').installLog('tap', line) } catch {} },
  })
  ipcMain.handle('trade:listings', (_e, p) => fetchListings(p || {}).catch(e => ({ ok: false, error: String(e && e.message || e) })))
  ipcMain.handle('trade:listings-cancel', () => { fetchListings.cancel(); return { ok: true } })
  ipcMain.handle('trade:query-price', (_e, p) => priceQuery(p || {}).catch(e => ({ ok: false, error: String(e && e.message || e) })))
  ipcMain.handle('trade:teleport', async (_e, { token }) => {
    try { return await engine.teleport(token) }
    catch (e) { return { success: false, error: e.code || 'error', message: String(e.message || e), retryAfter: e.retryAfter } }
  })
}

module.exports = { registerTrade, engine }
