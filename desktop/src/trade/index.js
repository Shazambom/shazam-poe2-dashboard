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
  ipcMain.handle('trade:teleport', async (_e, { token }) => {
    try { return await engine.teleport(token) }
    catch (e) { return { success: false, error: e.code || 'error', message: String(e.message || e), retryAfter: e.retryAfter } }
  })
}

module.exports = { registerTrade, engine }
