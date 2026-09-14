// Live-search engine (Electron main). For each enabled watch: open GGG's live-search
// WebSocket, and on each ping fetch the listing details and emit an enriched ping to the
// renderer. Read-only discovery + the manual teleport POST — strictly human-triggered, no
// auto-buy. See docs/trading-rework-plan.md.
const WebSocket = require('ws')
const { POE, poeRequest, poeJson, cookieHeader, userAgent } = require('./proxy.js')
const rateGate = require('./rateGate.js')

const MAX_SOCKETS = 20          // GGG closes excess live searches with code 1013
const FETCH_CHUNK = 10          // /fetch takes at most 10 ids per call
const BACKOFF_BASE = 2000
const BACKOFF_MAX = 60000

const sockets = new Map()       // itemId -> { ws, slug, league, searchId, attempts, stopped }
let _sink = () => {}            // set by index.js: (channel, payload) => webContents.send

function setSink(fn) { _sink = fn }
function activeCount() { return sockets.size }

function emitState(extra = {}) {
  _sink('trade:engine-state', { active: sockets.size, budgetMax: MAX_SOCKETS, rate: rateGate.snapshot(), ...extra })
}

async function startSearch(itemId, league, slug, type = 'search') {
  if (sockets.has(itemId)) return { ok: true, already: true }
  if (sockets.size >= MAX_SOCKETS) {
    _sink('trade:engine-error', { itemId, reason: 'budget', message: `Live-search cap reached (${MAX_SOCKETS}/${MAX_SOCKETS}). Stop one first.` })
    return { ok: false, reason: 'budget' }
  }
  const rec = { ws: null, slug, league, type, searchId: slug, attempts: 0, stopped: false }
  sockets.set(itemId, rec)
  await _connect(itemId)
  emitState()
  return { ok: true }
}

async function _connect(itemId) {
  const rec = sockets.get(itemId)
  if (!rec || rec.stopped) return
  const url = `wss://www.pathofexile.com/api/trade2/live/poe2/${encodeURIComponent(rec.league)}/${rec.searchId}`
  const referer = `${POE}/trade2/search/poe2/${encodeURIComponent(rec.league)}/${rec.searchId}`
  let ws
  try {
    ws = new WebSocket(url, {
      headers: {
        'Cookie': await cookieHeader(),
        'User-Agent': userAgent(),
        'Origin': POE,
        'Referer': referer,
      },
      handshakeTimeout: 15000,
    })
  } catch (e) {
    _scheduleReconnect(itemId, `connect failed: ${e.message}`)
    return
  }
  rec.ws = ws

  ws.on('open', () => {
    rec.attempts = 0
    _sink('trade:search-state', { itemId, state: 'live' })
    emitState()
  })
  ws.on('message', (buf) => {
    let msg
    try { msg = JSON.parse(buf.toString()) } catch { return }
    const ids = Array.isArray(msg.new) ? msg.new : (msg.result ? [msg.result] : [])
    if (ids.length) _onPingIds(itemId, ids).catch(e => console.log('[trade] fetch error:', String(e)))
  })
  ws.on('unexpected-response', (_req, res) => {
    const code = res.statusCode
    if (code === 401 || code === 403) _sink('trade:search-state', { itemId, state: 'auth', message: 'Reconnect your PoE session' })
    else _sink('trade:search-state', { itemId, state: 'error', message: `HTTP ${code}` })
    try { ws.terminate() } catch {}
  })
  ws.on('close', (code) => {
    rec.ws = null
    if (rec.stopped) return
    if (code === 1013) { _sink('trade:search-state', { itemId, state: 'error', message: 'Too many live searches' }); _scheduleReconnect(itemId, '1013', 30000); return }
    _scheduleReconnect(itemId, `closed ${code}`)
  })
  ws.on('error', (e) => { _sink('trade:search-state', { itemId, state: 'error', message: String(e.message || e) }) })
}

function _scheduleReconnect(itemId, why, minDelay = 0) {
  const rec = sockets.get(itemId)
  if (!rec || rec.stopped) return
  rec.attempts += 1
  const delay = Math.max(minDelay, Math.min(BACKOFF_BASE * 2 ** (rec.attempts - 1), BACKOFF_MAX))
  _sink('trade:search-state', { itemId, state: 'reconnecting', message: why, inMs: delay })
  rec.timer = setTimeout(() => _connect(itemId), delay)
}

async function _onPingIds(itemId, ids) {
  const rec = sockets.get(itemId)
  if (!rec) return
  for (let i = 0; i < ids.length; i += FETCH_CHUNK) {
    const chunk = ids.slice(i, i + FETCH_CHUNK)
    try { rateGate.check('fetch') } catch (e) { _sink('trade:engine-error', { itemId, reason: 'rate', message: e.message }); return }
    const path = `/api/trade2/fetch/${chunk.join(',')}?query=${rec.searchId}&realm=poe2`
    const resp = await poeRequest({ path, referer: `${POE}/trade2/search/poe2/${encodeURIComponent(rec.league)}/${rec.searchId}` })
    if (resp.status === 429) { rateGate.observe429('fetch', resp.headers); _sink('trade:engine-error', { itemId, reason: 'rate', message: 'fetch 429' }); return }
    rateGate.observe('fetch', resp.headers)
    const data = poeJson(resp)
    for (const r of (data?.result || [])) {
      const ping = _normalize(itemId, rec, r)
      if (ping) _sink('trade:ping', ping)
    }
  }
}

// Shape the fetch result into the renderer Ping (see docs/trading-rework-plan.md).
function _normalize(itemId, rec, r) {
  if (!r || !r.listing) return null
  const L = r.listing
  const price = L.price ? { amount: L.price.amount, currency: L.price.currency } : null
  const acct = L.account || {}
  const online = acct.online ? (acct.online.status === 'afk' ? 'afk' : 'online') : 'offline'
  const item = r.item || {}
  let tokenExp = 0
  const token = L.hideout_token || L.whisper_token || null
  try { if (token) tokenExp = (JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).exp || 0) * 1000 } catch {}
  return {
    pingId: `p_${itemId}_${r.id}`,
    itemId, searchId: rec.searchId, listingId: r.id,
    item: { name: item.name || '', typeLine: item.typeLine || item.baseType || '', icon: item.icon || '' },
    price,
    account: acct.name || acct.lastCharacterName || '',
    online,
    indexedAt: L.indexed ? Date.parse(L.indexed) : Date.now(),
    receivedAt: Date.now(),
    token, tokenExp,
    flags: { gone: !!r.gone, inDemand: !!L.in_demand },
  }
}

function stopSearch(itemId) {
  const rec = sockets.get(itemId)
  if (!rec) return
  rec.stopped = true
  clearTimeout(rec.timer)
  try { rec.ws?.close() } catch {}
  sockets.delete(itemId)
  emitState()
}

function stopAll() { for (const id of [...sockets.keys()]) stopSearch(id) }

// The manual teleport (PR6 wires the button). One call per human click; POST the
// hideout_token to travel to the seller's hideout. Returns { success } or throws.
async function teleport(token) {
  rateGate.check('whisper')
  const resp = await poeRequest({
    method: 'POST', path: '/api/trade2/whisper',
    body: { token }, referer: `${POE}/trade2`,
  })
  if (resp.status === 429) { rateGate.observe429('whisper', resp.headers); throw new rateGate.RateLimitError(30) }
  rateGate.observe('whisper', resp.headers)
  const data = poeJson(resp) || {}
  _sink('trade:rate-state', rateGate.snapshot())
  return { success: !!data.success, status: resp.status }
}

// DEV: emit a synthetic ping so the renderer alert UI (orb/banner/sound/button) can be
// exercised + screenshotted without waiting on a real listing. No network, no token.
function emitTestPing() {
  _sink('trade:ping', {
    pingId: `p_test_${Date.now()}`, itemId: 'test', searchId: 'test', listingId: `test_${Date.now()}`,
    item: { name: 'Divine Orb', typeLine: 'Divine Orb', icon: '' },
    price: { amount: 3, currency: 'chaos' },
    account: 'TestSeller', online: 'online',
    indexedAt: Date.now(), receivedAt: Date.now(),
    token: null, tokenExp: Date.now() + 5 * 60 * 1000,
    flags: { gone: false, inDemand: true },
  })
}

module.exports = { setSink, startSearch, stopSearch, stopAll, teleport, activeCount, emitState, emitTestPing }
