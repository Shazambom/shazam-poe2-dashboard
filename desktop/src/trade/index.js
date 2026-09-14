// Wires the live-search engine to the renderer over IPC. Call registerTrade(getWin)
// once from app.whenReady. All trade traffic stays in main (Cloudflare/session); the
// renderer only sends intents and receives pings/state.
const { ipcMain } = require('electron')
const { installCloudflareCookieFix, poeRequest } = require('./proxy.js')
const engine = require('./engine.js')

// One-shot diagnostic: POST a trivial search to prove the main-process proxy passes
// Cloudflare with the user's session (200 = path works; 401/403 = login/CF needed).
async function selfTest(league = 'Forbidden Rites') {
  try {
    const resp = await poeRequest({
      method: 'POST', path: `/api/trade2/search/poe2/${encodeURIComponent(league)}`,
      body: { query: { status: { option: 'online' } }, sort: { price: 'asc' } },
      referer: `https://www.pathofexile.com/trade2/search/poe2/${encodeURIComponent(league)}`,
    })
    let id = null
    try { id = JSON.parse(resp.body)?.id } catch {}
    console.log(`[trade] selftest search(${league}) -> HTTP ${resp.status}${id ? ` id=${id}` : ''}`)
    if (id) await _testLiveWs(league, id)
  } catch (e) { console.log('[trade] selftest failed:', String(e.message || e)) }
}

// Validate the live-search WebSocket handshake passes Cloudflare too (uses the same
// session cookies + UA). Opens, logs open/error, then closes.
async function _testLiveWs(league, searchId) {
  const WebSocket = require('ws')
  const { POE, cookieHeader, userAgent } = require('./proxy.js')
  try {
    const ws = new WebSocket(`wss://www.pathofexile.com/api/trade2/live/poe2/${encodeURIComponent(league)}/${searchId}`, {
      headers: { Cookie: await cookieHeader(), 'User-Agent': userAgent(), Origin: POE,
        Referer: `${POE}/trade2/search/poe2/${encodeURIComponent(league)}/${searchId}` },
      handshakeTimeout: 12000,
    })
    let got = false
    ws.on('open', () => { console.log('[trade] selftest live WS -> OPEN (handshake passed Cloudflare); listening 15s for a ping…'); setTimeout(() => { try { ws.close() } catch {} }, 15000) })
    ws.on('message', async (buf) => {
      if (got) return
      let msg; try { msg = JSON.parse(buf.toString()) } catch { return }
      const ids = Array.isArray(msg.new) ? msg.new : (msg.result ? [msg.result] : [])
      if (!ids.length) return
      got = true
      console.log(`[trade] selftest PING received: ${ids.length} id(s) — fetching…`)
      const { poeRequest } = require('./proxy.js')
      const r = await poeRequest({ path: `/api/trade2/fetch/${ids.slice(0, 1).join(',')}?query=${searchId}&realm=poe2` })
      let name = '?', price = '?'
      try { const d = JSON.parse(r.body).result?.[0]; name = d?.item?.name || d?.item?.typeLine || '?'; price = d?.listing?.price ? `${d.listing.price.amount} ${d.listing.price.currency}` : 'unpriced' } catch {}
      console.log(`[trade] selftest FETCH ok (HTTP ${r.status}): "${name}" @ ${price} — full ping pipeline verified`)
      try { ws.close() } catch {}
    })
    ws.on('unexpected-response', (_r, res) => { console.log(`[trade] selftest live WS -> HTTP ${res.statusCode}`); try { ws.terminate() } catch {} })
    ws.on('error', (e) => console.log('[trade] selftest live WS error:', String(e.message || e)))
  } catch (e) { console.log('[trade] selftest live WS threw:', String(e.message || e)) }
}

function registerTrade(getWin) {
  installCloudflareCookieFix()
  ipcMain.handle('trade:selftest', (_e, league) => selfTest(league))

  // Engine -> renderer: forward every engine event to the focused window's webContents.
  engine.setSink((channel, payload) => {
    try { getWin()?.webContents.send(channel, payload) } catch {}
  })

  ipcMain.handle('trade:start-search', (_e, { itemId, league, slug, type }) =>
    engine.startSearch(itemId, league, slug, type))
  ipcMain.handle('trade:stop-search', (_e, { itemId }) => { engine.stopSearch(itemId); return { ok: true } })
  ipcMain.handle('trade:engine-state', () => { engine.emitState(); return { active: engine.activeCount() } })
  // Create a fresh search defaulted to INSTANT BUYOUT (priced listings, cheapest first) and
  // return its slug, so the embedded trade window opens in buyout mode — which is also what
  // travel-to-hideout requires. Falls back (null) to a blank search page on any error.
  ipcMain.handle('trade:new-search', async (_e, { league }) => {
    try {
      const { POE, poeRequest } = require('./proxy.js')
      const resp = await poeRequest({
        method: 'POST', path: `/api/trade2/search/poe2/${encodeURIComponent(league)}`,
        body: { query: { status: { option: 'online' }, filters: { trade_filters: { filters: { sale_type: { option: 'priced' } } } } }, sort: { price: 'asc' } },
        referer: `${POE}/trade2/search/poe2/${encodeURIComponent(league)}`,
      })
      let id = null; try { id = JSON.parse(resp.body)?.id } catch {}
      return { slug: id }
    } catch { return { slug: null } }
  })

  // Derive a friendly name for a captured search (item name, or base type + ilvl + rarity)
  // by fetching the saved search's query. Returns null if it can't (caller keeps default).
  ipcMain.handle('trade:describe', async (_e, { league, slug }) => {
    try {
      const { POE, poeRequest } = require('./proxy.js')
      const resp = await poeRequest({
        path: `/api/trade2/search/poe2/${encodeURIComponent(league)}/${slug}`,
        referer: `${POE}/trade2/search/poe2/${encodeURIComponent(league)}/${slug}`,
      })
      let d = null; try { d = JSON.parse(resp.body) } catch {}
      const q = d?.query?.query || d?.query || d?.search?.query || {}
      const tf = q?.filters?.type_filters?.filters || {}
      const name = q.name || q.type || q.term
      const rarity = tf.rarity?.option
      const ilvl = tf.ilvl?.min
      const cat = tf.category?.option
      let label = name || (cat ? cat[0].toUpperCase() + cat.slice(1) : null)
      if (!label) return null
      const bits = []
      if (rarity && !q.name) bits.push(rarity)
      if (ilvl) bits.push('i' + ilvl)
      return bits.length ? `${label} · ${bits.join(' ')}` : label
    } catch { return null }
  })

  ipcMain.handle('trade:teleport', async (_e, { token }) => {
    try { return await engine.teleport(token) }
    catch (e) { return { success: false, error: e.code || 'error', message: String(e.message || e), retryAfter: e.retryAfter } }
  })

  // DEV diagnostics (gated; never auto-fires in a shipped build):
  //   TRADE_SELFTEST=1 → proxy/Cloudflare/WS/fetch smoke test on launch.
  //   UI_SMOKE=1       → emit a synthetic ping so the alert UI can be captured.
  if (process.env.TRADE_SELFTEST) setTimeout(() => selfTest(), 5000)
  ipcMain.handle('trade:__testping', () => { engine.emitTestPing(); return { ok: true } })
}

module.exports = { registerTrade, engine }
