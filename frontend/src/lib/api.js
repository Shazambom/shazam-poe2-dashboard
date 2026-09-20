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
// Blank = unset, for query strings AND POST bodies (an empty filter box holds '').
const set = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''))
const qs = (o) => { const s = new URLSearchParams(set(o)).toString(); return s ? `?${s}` : '' }
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
  routesStreamUrl: (f) => '/api/routes/stream' + qs(f),
  refreshTop: (filters, n) => post('/api/routes/refresh-top', { filters: set(filters), start: filters.start || null, n }),
  refreshRoute: (id, pairs, filters) => post('/api/routes/refresh', { id, pairs, filters: set(filters), start: filters.start || null }),
  leagues: () => fetch('/api/leagues').then(j),
  rateLimits: () => fetch('/api/ratelimits').then(j),
  hold: (window_h, category, numeraire, k) => fetch('/api/hold' + qs({ window_h, category, numeraire, k })).then(j),
  convert: (have, want, amount, max_steps) => fetch('/api/convert' + qs({ have, want, amount, max_steps })).then(j),
  movers: (window_h, n, dir) => fetch('/api/movers' + qs({ window_h, n, dir })).then(j),
  asset: (q, window_h, num) => fetch('/api/asset' + qs({ q, window_h, num })).then(j),
  inflation: (anchor, hours) => fetch('/api/inflation' + qs({ anchor, hours })).then(j),
  inflationCross: (item) => fetch('/api/inflation/cross' + qs({ item })).then(j),
  inflationMarketcap: () => fetch('/api/inflation/marketcap').then(j),
  workspace: () => fetch('/api/trading/workspace').then(j),
  sales: (league) => fetch('/api/sales' + qs({ league })).then(j),
  putWorkspace: (workspace) => put('/api/trading/workspace', { workspace }),
  board: (window_h, nums) => fetch('/api/board' + qs({ window_h, nums: nums || undefined })).then(j),
  boardRefresh: (window_h) => post('/api/board/refresh' + qs({ window_h })),
  edges: () => fetch('/api/market/edges').then(j),
  topMarkets: (by) => fetch('/api/market/top' + qs({ by })).then(j),
  history: (a, b, hours = 168) => fetch(`/api/market/history${qs({ a, b, hours })}`).then(j),
  session: () => fetch('/api/session').then(j),
  connectSession: (cookie) => post('/api/session', { cookie, label: 'pasted in dashboard' }),
  disconnectSession: () => fetch('/api/session', { method: 'DELETE' }).then(j),
  oauthStatus: () => fetch('/api/oauth/status').then(j),
  oauthStart: () => post('/api/oauth/start', {}),
  oauthLogout: () => post('/api/oauth/logout'),
  signals: () => fetch('/api/signals').then(j),
  ackSignals: (keys, all = false) => post('/api/signals/ack', { keys, all }),
  arc: (item, numeraire) => fetch('/api/arc' + qs({ item, numeraire })).then(j),
  leagueArc: (numeraire) => fetch('/api/leaguearc' + qs({ numeraire })).then(j),
  goldFees: () => fetch('/api/goldfees').then(j),
  refreshGoldFees: () => post('/api/goldfees/refresh'),
  syncDigest: () => post('/api/digest/sync'),
}
export const fmt = {
  n: (v, d = 0) => v == null ? '–' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }),
  pct: (v) => v == null ? '–' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`,
  rate: (v) => v == null ? '–' : v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(3),
  age: (s) => s == null ? '–' : s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`,
  // A duration given in HOURS (fill times, cash-out times): minutes below an hour, days past two.
  dur: (h) => h == null ? '–' : h < 1 / 60 ? '<1m' : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`,
  // Chart axis label for an epoch-seconds hour.
  hourLabel: (h) => new Date(h * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' }),
}
