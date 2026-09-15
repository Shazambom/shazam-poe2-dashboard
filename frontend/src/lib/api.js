// Tiny pub/sub for toasts. Anything can emit { text, ok }; App renders them.
const listeners = new Set()
export const bus = {
  on(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  emit(t) { listeners.forEach(fn => fn(t)) },
}
export const toast = (text, ok = true) => bus.emit({ text, ok })

export const cleanErr = (e) => String(e?.message || e).replace(/^\d+ /, '')

const j = async (r) => {
  if (!r.ok) {
    let text = await r.text()
    try {
      const d = JSON.parse(text)
      text = typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail ?? d)
    } catch {}
    const err = new Error(text || `HTTP ${r.status}`)
    err.status = r.status
    throw err
  }
  return r.json()
}
// Wrap a promise so failures always surface as a toast instead of dying silently.
export const surface = (p, okText) => p
  .then(r => { if (okText) toast(okText); return r })
  .catch(e => { toast(cleanErr(e), false); throw e })
const qs = (o) => { const p = new URLSearchParams(); Object.entries(o).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v) }); const s = p.toString(); return s ? `?${s}` : '' }
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then(j)
const put = (url, body) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(j)
export const api = {
  status: () => fetch('/api/status').then(j),
  diag: () => fetch('/api/diag').then(j),
  backfill: () => fetch('/api/backfill').then(j),
  currencies: () => fetch('/api/currencies').then(j),
  mapCurrency: (metadata_id, trade_id) => post('/api/currencies/map', { metadata_id, trade_id }),
  capital: () => fetch('/api/capital').then(j),
  putCapital: (entries) => put('/api/capital', { entries }),
  settings: () => fetch('/api/settings').then(j),
  putSettings: (patch) => put('/api/settings', { patch }),
  recipes: () => fetch('/api/recipes').then(j),
  putRecipes: (recipes) => put('/api/recipes', { recipes }),
  routes: (f) => fetch('/api/routes' + qs(f)).then(j),
  routesStreamUrl: (f) => '/api/routes/stream' + qs(f),
  refreshTop: (filters, n) => post('/api/routes/refresh-top', { filters, start: filters.start || null, n }),
  refreshRoute: (id, pairs, filters) => post('/api/routes/refresh', { id, pairs, filters, start: filters.start || null }),
  leagues: () => fetch('/api/leagues').then(j),
  rateLimits: () => fetch('/api/ratelimits').then(j),
  hold: (horizon, category, numeraire) => fetch('/api/hold' + qs({ horizon, category, numeraire })).then(j),
  movers: (window_h, n) => fetch('/api/movers' + qs({ window_h, n })).then(j),
  asset: (q, window_h) => fetch('/api/asset' + qs({ q, window_h })).then(j),
  inflation: (anchor, hours) => fetch('/api/inflation' + qs({ anchor, hours })).then(j),
  inflationCross: (item) => fetch('/api/inflation/cross' + qs({ item })).then(j),
  inflationMarketcap: () => fetch('/api/inflation/marketcap').then(j),
  watches: () => fetch('/api/watches').then(j),
  putWatches: (folders) => put('/api/watches', { folders }),
  workspace: () => fetch('/api/trading/workspace').then(j),
  putWorkspace: (workspace) => put('/api/trading/workspace', { workspace }),
  board: (window_h) => fetch('/api/board' + qs({ window_h })).then(j),
  boardRefresh: (window_h) => post('/api/board/refresh' + qs({ window_h })),
  edges: () => fetch('/api/market/edges').then(j),
  topMarkets: () => fetch('/api/market/top').then(j),
  history: (a, b, hours = 168) => fetch(`/api/market/history${qs({ a, b, hours })}`).then(j),
  refreshBook: () => post('/api/market/refresh'),
  session: () => fetch('/api/session').then(j),
  connectSession: (cookie) => post('/api/session', { cookie, label: 'pasted in dashboard' }),
  disconnectSession: () => fetch('/api/session', { method: 'DELETE' }).then(j),
  oauthStatus: () => fetch('/api/oauth/status').then(j),
  oauthStart: () => post('/api/oauth/start', {}),
  oauthLogout: () => post('/api/oauth/logout'),
  goldFees: () => fetch('/api/goldfees').then(j),
  refreshGoldFees: () => post('/api/goldfees/refresh'),
  syncDigest: () => post('/api/digest/sync'),
}
export const fmt = {
  n: (v, d = 0) => v == null ? '–' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }),
  pct: (v) => v == null ? '–' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`,
  rate: (v) => v == null ? '–' : v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(3),
  age: (s) => s == null ? '–' : s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`,
}
