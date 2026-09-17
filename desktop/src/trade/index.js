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
  // Sales tab (roadmap batch 6): Merchant History through the user's session under policy trade-history.
  const salesFetch = require('./sales.js').makeSalesFetcher({
    request: (r) => require('./proxy.js').poeRequest({ method: 'GET', path: r.path, referer: r.referer }),
    budget: require('./budget.js'), backendUrl: () => (getBackendUrl ? getBackendUrl() : 'http://127.0.0.1:8210'),
    log: (line) => { try { require('../telemetry.js').installLog('sales', line) } catch {} },
  })
  ipcMain.handle('sales:fetch', (_e, p) => salesFetch(p?.league).catch(e => ({ ok: false, error: String(e && e.message || e) })))
  ipcMain.handle('trade:teleport', async (_e, { token }) => {
    try { return await engine.teleport(token) }
    catch (e) { return { success: false, error: e.code || 'error', message: String(e.message || e), retryAfter: e.retryAfter } }
  })
}

module.exports = { registerTrade, engine }
