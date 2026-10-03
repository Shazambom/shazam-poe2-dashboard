// The trade tap: Electron's debugger listening to an embedded trade window (owner, 2026-10-02), CDP
// Network domain only. It reads the responses the page already received — its search, its listings'
// prices, the site's price-filter options — and passes on a projection over `trade:tap`. No account,
// stash, token, whisper or item data ever leaves main. It sends nothing to the site and nothing to the
// page: only Network.enable and Network.getResponseBody (a Page.reload sent to a webview reloads the whole
// app). Any failure is silence; consumers show nothing. Attached to every trade webview from
// app.on('web-contents-created'); consumers filter by wcId, as the navigation events already are.
'use strict'
const { projectRows } = require('./listings.js')

const CHANNEL = 'trade:tap'
const ALLOWED = new Set(['Network.enable', 'Network.getResponseBody'])
const HOST = 'https://www.pathofexile.com/api/trade2/'
const SEARCH = /^search\/poe2\/([^/?#]+)$/
const FETCH = /^fetch\/[^?]+\?(.*)$/

let _options = null   // the site's price options, replayed to windows attached later (data/filters may be cached)

function _send(dbg, method, params) {
  if (!ALLOWED.has(method)) throw new Error(`${method} not allowed`)
  return dbg.sendCommand(method, params)
}

const parse = (s) => { try { return JSON.parse(s) } catch { return null } }

function kindOf(url) {
  if (!String(url).startsWith(HOST)) return null
  const rest = url.slice(HOST.length)
  const s = rest.match(SEARCH)
  if (s) { try { return { kind: 'search', league: decodeURIComponent(s[1]) } } catch { return null } }   // a malformed escape: ignored
  const f = rest.match(FETCH)
  if (f) return { kind: 'fetch', searchId: new URLSearchParams(f[1]).get('query') }
  if (rest === 'data/filters') return { kind: 'options' }
  return null
}

// The projections: only what the consumers need.
function project(k, req, res, wcId) {
  if (k.kind === 'search') {
    const body = parse(req.postData)
    if (!body?.query || typeof res?.id !== 'string' || !Array.isArray(res.result)) return null
    return { kind: 'search', wcId, league: k.league, id: res.id, body, ids: res.result, total: Number(res.total) || 0 }
  }
  if (k.kind === 'fetch') {
    if (!k.searchId || !Array.isArray(res?.result)) return null
    return { kind: 'fetch', wcId, searchId: k.searchId, rows: projectRows(res) }
  }
  const price = (res?.result || []).find(g => g?.id === 'trade_filters')?.filters?.find(f => f?.id === 'price')?.option?.options
  if (!Array.isArray(price)) return null
  _options = price.filter(o => typeof o?.id === 'string' && o.id).map(o => ({ id: o.id, text: String(o.text ?? o.id) }))
  return { kind: 'options', wcId, price: _options }
}

// contents: a webview's webContents. send(channel, payload) reaches the window; log(line) is beta telemetry.
// observe(policy, status, headers): the page's own search/fetch rate-limit headers, into the shared budget.
function attachTap(contents, send, log = () => {}, observe = () => {}) {
  const dbg = contents.debugger
  const wcId = contents.id
  const pending = new Map()   // requestId → { kind…, postData }
  const emit = (p) => { try { send(CHANNEL, p) } catch {} }

  const onMessage = (_e, method, p) => {
    if (method === 'Network.requestWillBeSent') {
      const k = kindOf(p?.request?.url)
      if (k) pending.set(p.requestId, { k, postData: p.request.postData })
    } else if (method === 'Network.responseReceived') {
      const r = pending.get(p?.requestId)
      const policy = r && { search: 'trade-search', fetch: 'trade-fetch' }[r.k.kind]
      // A cached response carries old X-Rate-Limit state: only what the site just answered is current.
      const cached = p.response?.fromDiskCache || p.response?.fromPrefetchCache || p.response?.fromServiceWorker
      if (policy && !cached) { try { observe(policy, p.response?.status, p.response?.headers || {}) } catch {} }
    } else if (method === 'Network.loadingFailed') {
      pending.delete(p?.requestId)
    } else if (method === 'Network.loadingFinished') {
      const r = pending.get(p?.requestId)
      if (!r) return
      pending.delete(p.requestId)
      _send(dbg, 'Network.getResponseBody', { requestId: p.requestId }).then((b) => {
        const text = b?.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b?.body
        const out = project(r.k, r, parse(text), wcId)
        if (out) emit(out)
      }, () => {})
    }
  }

  const attach = () => {
    try {
      dbg.attach('1.3')
      _send(dbg, 'Network.enable', { maxResourceBufferSize: 4e6, maxTotalBufferSize: 2e7 }).catch(() => {})
      log(`tap attach wc=${wcId}`)
      if (_options) emit({ kind: 'options', wcId, price: _options })
      return true
    } catch (e) { log(`tap attach-fail wc=${wcId} ${String(e?.message || e).slice(0, 80)}`); return false }
  }

  dbg.on('message', onMessage)
  dbg.on('detach', (_e, reason) => {
    pending.clear()
    log(`tap detach wc=${wcId} reason=${reason}`)
    if (reason === 'target closed') return     // a remount: the new window is attached on creation
    contents.once?.('devtools-closed', () => { if (!dbg.isAttached?.()) attach() })
  })
  attach()
}

module.exports = { attachTap, CHANNEL, _send, _resetForTests: () => { _options = null } }
