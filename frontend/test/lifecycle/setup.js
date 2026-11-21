import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

if (typeof globalThis.localStorage?.getItem !== 'function') {
  const store = new Map()
  const storage = {
    get length() { return store.size },
    key(i) { return Array.from(store.keys())[i] ?? null },
    getItem(k) { return store.has(String(k)) ? store.get(String(k)) : null },
    setItem(k, v) { store.set(String(k), String(v)) },
    removeItem(k) { store.delete(String(k)) },
    clear() { store.clear() },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: true })
  }
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false },
  })
}

if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

if (typeof window !== 'undefined' && !window.poe2desktop) {
  const noopSub = () => vi.fn(() => () => {})
  window.poe2desktop = {
    connectSession: vi.fn(async () => ({ ok: true })),
    getVersion: async () => '0.3.17-beta.2',
    openLogin: vi.fn(async () => ({ ok: true })),
    setCookie: vi.fn(async () => ({ ok: true })),
    openTrade: vi.fn(async () => ({ ok: true })),
    notify: vi.fn(async () => ({ ok: true })),
    onNotifyClick: noopSub(),
    onUpdate: noopSub(),
    checkUpdate: vi.fn(async () => ({ ok: true })),
    installUpdate: vi.fn(async () => ({ ok: true })),
    getChannel: vi.fn(async () => ({ beta: true })),
    setChannel: vi.fn(async () => ({ ok: true })),
    setTheme: vi.fn(async () => ({ ok: true })),
    trade: {
      onWebviewNav: noopSub(),
      onTap: noopSub(),
      listings: vi.fn(async () => ({ ok: true, listings: [] })),
      recheck: vi.fn(async () => ({ ok: true, listings: [] })),
      listingsCancel: vi.fn(async () => ({ ok: true })),
      startSearch: vi.fn(async () => ({ ok: true })),
      stopSearch: vi.fn(async () => ({ ok: true })),
      modLookup: vi.fn(async () => null),
      modItem: vi.fn(async () => null),
      teleport: vi.fn(async () => ({ success: true })),
      uniques: vi.fn(async () => []),
      priceQuery: vi.fn(async () => ({ ok: true })),
      onPing: noopSub(),
      onEngineState: noopSub(),
      onSearchState: noopSub(),
      onEngineError: noopSub(),
      onFocusLive: noopSub(),
      onIngest: noopSub(),
      ingestAck: vi.fn(),
    },
    ws: {
      onFlush: noopSub(),
      flushed: vi.fn(),
      exportFile: vi.fn(async () => ({ ok: true })),
    },
    sales: {
      fetch: vi.fn(async () => ({ ok: true, rows: [] })),
    },
    ee2: {
      setEnabled: vi.fn(),
      setSearchPrefs: vi.fn(),
      status: vi.fn(async () => ({ enabled: false })),
    },
    diag: { log: vi.fn(async () => ({ ok: true })) },
    clipboard: { classify: vi.fn(async () => ({ kind: 'other' })) },
    feedback: {
      package: vi.fn(async () => ({ ok: true })),
      drag: vi.fn(async () => ({ ok: true })),
      reveal: vi.fn(async () => ({ ok: true })),
      discord: vi.fn(async () => ({ ok: true })),
    },
    hotkey: {
      get: vi.fn(async () => ({ combo: '' })),
      set: vi.fn(async () => ({ ok: true })),
    },
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllTimers()
  vi.restoreAllMocks()
  if (typeof globalThis.localStorage?.clear === 'function') globalThis.localStorage.clear()
  // Keep a silent fallback fetch stub so any stray unmount microtask never opens a real TCP socket
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ ok: true }))
})

export const DEFAULT_CURRENCIES = {
  loaded_at: 1795231021,
  currencies: [
    { id: 'exalted', name: 'Exalted Orb', text: 'Exalted Orb', category: 'currency', icon: 'https://web.poecdn.com/ex.png' },
    { id: 'divine', name: 'Divine Orb', text: 'Divine Orb', category: 'currency', icon: 'https://web.poecdn.com/div.png' },
    { id: 'chaos', name: 'Chaos Orb', text: 'Chaos Orb', category: 'currency', icon: 'https://web.poecdn.com/chaos.png' },
    { id: 'vaal', name: 'Vaal Orb', text: 'Vaal Orb', category: 'currency', icon: 'https://web.poecdn.com/vaal.png' },
    { id: 'mirror', name: 'Mirror of Kalandra', text: 'Mirror of Kalandra', category: 'currency', icon: 'https://web.poecdn.com/mirror.png' },
  ],
  groups: { exalted: 'currency', divine: 'currency', chaos: 'currency', vaal: 'currency', mirror: 'currency' },
}

export function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

/**
 * Install a stateful mock fetch for `/api/*` routes. Pass `overrides` mapping
 * `"METHOD /path"` or `"/path"` to either a JSON value or `(url, init) => value | Response`.
 */
export function installApiMock(overrides = {}) {
  const calls = []
  const nowH = Math.floor(Date.now() / 3600000) * 3600
  const directConvertRoute = {
    id: 'r1',
    start: 'chaos',
    start_name: 'Chaos Orb',
    start_amount: 1000,
    end_amount: 50,
    out: 50,
    path: ['chaos', 'divine'],
    path_names: ['Chaos Orb', 'Divine Orb'],
    kinds: ['digest'],
    steps: [{ from: 'chaos', from_name: 'Chaos Orb', to: 'divine', to_name: 'Divine Orb', in: 1000, out: 50, rate: 0.05, kind: 'digest', gold: 100, vol_h: 500 }],
    gain_cross_pct: 0.5,
  }
  const altConvertRoute = {
    id: 'r2',
    start: 'chaos',
    start_name: 'Chaos Orb',
    start_amount: 1000,
    end_amount: 49,
    out: 49,
    path: ['chaos', 'exalted', 'divine'],
    path_names: ['Chaos Orb', 'Exalted Orb', 'Divine Orb'],
    kinds: ['digest', 'digest'],
    steps: [
      { from: 'chaos', from_name: 'Chaos Orb', to: 'exalted', to_name: 'Exalted Orb', in: 1000, out: 5000, rate: 5, kind: 'digest', gold: 80, vol_h: 900 },
      { from: 'exalted', from_name: 'Exalted Orb', to: 'divine', to_name: 'Divine Orb', in: 5000, out: 49, rate: 0.0098, kind: 'digest', gold: 120, vol_h: 700 },
    ],
    gain_cross_pct: -1.5,
  }
  const defaults = {
    '/api/health': { ok: true },
    '/api/status': {
      league: 'Test League',
      reference: 'exalted',
      wealth_prices: { exalted: 1, divine: 100, chaos: 5, mirror: 50000 },
      digest_age_s: 120,
      live_pairs: 12,
      session: { connected: false },
    },
    '/api/backfill': { active: false, done: true, pct: 100 },
    '/api/diag': { ok: true },
    '/api/leagues': [{ id: 'Test League', text: 'Test League' }],
    '/api/currencies': DEFAULT_CURRENCIES,
    '/api/settings': {
      league: 'Test League',
      reference: 'exalted',
      stash_unit: 'divine',
      stash_counted: {},
      allow_digest_edges: true,
      allow_recipe_edges: true,
      live_max_age_s: 1800,
      min_edge_depth: 2,
      gold_model: { per_unit: { divine: 100 }, base: 0 },
      live_top_n: 5,
      live_min_age_s: 300,
      min_refetch_s: 300,
      background_sweep: false,
      batch_pad: false,
      batch_max_have: 10,
      notifications: {},
    },
    '/api/capital': {
      reference: 'exalted',
      total_ref: 1500,
      counted_by_default: ['divine', 'exalted'],
      rows: [
        { currency: 'divine', name: 'Divine Orb', qty: 10, value_ref: 1000, unit_ref: 100, group: 'currency', liquid: true },
        { currency: 'exalted', name: 'Exalted Orb', qty: 500, value_ref: 500, unit_ref: 1, group: 'currency', liquid: true },
      ],
    },
    '/api/board': {
      reference: 'exalted',
      league: 'Test League',
      prices: { exalted: 1, divine: 100, chaos: 5, mirror: 50000 },
      session: false,
      rows: [
        { id: 'divine', name: 'Divine Orb', mid: 100, source: 'digest', age_s: 60, change_pct: 2.5, pref_num: 'exalted', hub: true, trend_num: 'exalted', trend: [{ t: nowH - 3600, v: 97.5 }, { t: nowH, v: 100 }] },
        { id: 'chaos', name: 'Chaos Orb', mid: 5, source: 'digest', age_s: 60, change_pct: -1.1, pref_num: 'exalted', hub: true, trend_num: 'exalted', trend: [{ t: nowH - 3600, v: 5.06 }, { t: nowH, v: 5 }] },
      ],
    },
    '/api/asset': {
      reference: 'exalted',
      prices: { exalted: 1, divine: 100, chaos: 5 },
      row: { id: 'divine', name: 'Divine Orb', mid: 100, source: 'digest', age_s: 60, change_pct: 2.5, pref_num: 'exalted', hub: true, trend_num: 'exalted', trend: [{ t: nowH - 3600, v: 97.5 }, { t: nowH, v: 100 }] },
    },
    '/api/leaguearc': { league: 'Test League', day: 20, phase: 'mid', resembles: 'Past League', weighted: [] },
    '/api/arc': { item: 'Divine Orb', league: 'Test League', series: [], past: [] },
    '/api/signals': { signals: [], unseen: 0, league: 'Test League' },
    '/api/arbitrage/presets': [{ id: 'balanced', name: 'Balanced', values: { filters: { max_hops: 3 } } }],
    '/api/recipes': [],
    '/api/goldfees': { updated_at: null, fees: {} },
    '/api/sales': { rows: [], league: 'Test League' },
    '/api/trading/workspace': { workspace: { version: 2, tree: [], layout: null, openTabs: [] } },
    '/api/strategy/calc': { calc: null, prices: { divine: 1, exalted: 0.01, chaos: 0.05 }, uses: [] },
    '/api/hold': {
      league: 'Test League',
      horizon: '3d',
      delta_days: 3,
      numeraire_name: 'Divine',
      numeraires: [{ id: 'divine', name: 'Divine Orb' }],
      categories: ['all', 'currency'],
      pred_shown: true,
      assets: [
        { id: 'divine', name: 'Divine Orb', category: 'currency', price: 100, price_cur: 'exalted', ret_pct: 4.5, mdd_pct: -3.2, hold: 82, pred_arrows: 1, confidence: 0.9 },
      ],
    },
    '/api/movers': {
      league: 'Test League',
      assets: [
        { id: 'divine', name: 'Divine Orb', category: 'currency', change_pct: 8.4, medvol: 50000, num: 'exalted' },
      ],
    },
    '/api/market/top': [{ a: 'divine', b: 'exalted', vol_a: 1000, vol_b: 100000, value_ref: 100000, hours: 24, rate: 100 }],
    '/api/market/edges': [{ from: 'divine', to: 'exalted', rate: 100, vol: 1000, source: 'digest' }],
    '/api/market/history': { digest: [{ hour: nowH - 3600, rate: 98, vol_a: 500, vol_b: 49000 }, { hour: nowH, rate: 100, vol_a: 600, vol_b: 60000 }], live: [] },
    '/api/inflation': { anchor: 'divine', series: [{ t: nowH - 3600, v: 98 }, { t: nowH, v: 100 }], rates: {} },
    '/api/inflation/cross': {
      item: 291,
      item_name: 'Divine',
      items: [{ id: 291, name: 'Divine Orb' }],
      leagues: [{ league: 'Test League', points: [{ age: 0, index: 100 }, { age: 10, index: 115 }] }],
    },
    '/api/inflation/marketcap': { leagues: [{ league: 'Test League', total_mirrors: 500, days: 10, points: [{ age: 0, mirrors: 40 }, { age: 10, mirrors: 60 }] }] },
    '/api/mods/pools': { pools: [{ id: 'ring', name: 'Ring', class: 'Ring', domain: 'item', keywords: ['ring'] }], currencies: [{ id: 'exalted', name: 'Exalted Orb', floor: 1, cap: null }] },
    '/api/mods/pool/ring': {
      id: 'ring',
      name: 'Ring',
      class: 'Ring',
      domain: 'item',
      tags: [{ id: 'life', label: 'Life' }, { id: 'fire', label: 'Fire' }],
      sections: [{
        id: 'explicit',
        title: 'Explicit',
        floored: true,
        prefix: [{ id: 'life', text: '+# to maximum Life', tags: ['life'], tiers: [{ ilvl: 1, text: '+10 to maximum Life', name: 'Hale' }] }],
        suffix: [{ id: 'res', text: '+#% to Fire Resistance', tags: ['fire'], tiers: [{ ilvl: 1, text: '+10% to Fire Resistance', name: 'of the Whelpling' }] }],
      }],
      grants: { essences: [], alloys: [], augments: [] },
    },
    '/api/mods/pool/ring/prices': { prices: { exalted: 1 }, currencies: {} },
    '/api/session': { connected: false },
    '/api/oauth/status': { connected: false },
    '/api/convert': {
      have: 'chaos', want: 'divine', amount: 1000, reference: 'exalted',
      best: directConvertRoute,
      direct: directConvertRoute,
      alternatives: [altConvertRoute],
      min_amount: null,
    },
  }

  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const rawUrl = typeof input === 'string' ? input : input.url
    const method = (init.method || 'GET').toUpperCase()
    const path = rawUrl.split('?')[0]
    let parsedBody = null
    if (init.body && typeof init.body === 'string') {
      try { parsedBody = JSON.parse(init.body) } catch { parsedBody = init.body }
    }
    calls.push({ method, url: rawUrl, path, body: parsedBody })

    const keyWithMethod = `${method} ${path}`
    const handler = overrides[keyWithMethod] ?? overrides[path] ?? defaults[path]
    if (typeof handler === 'function') {
      const res = await handler(rawUrl, init, parsedBody)
      if (res && typeof res.json === 'function') return res
      return jsonResponse(res)
    }
    if (handler !== undefined) {
      if (method === 'PUT' && path === '/api/settings' && parsedBody?.patch) {
        return jsonResponse({ ...defaults['/api/settings'], ...parsedBody.patch })
      }
      if (method === 'PUT' && path === '/api/capital') {
        return jsonResponse({ ok: true, ...defaults['/api/capital'] })
      }
      if (method === 'PUT' && path === '/api/strategy/calc') {
        return jsonResponse({ calc: parsedBody?.calc })
      }
      if (method === 'PUT' && path === '/api/trading/workspace') {
        return jsonResponse({ workspace: parsedBody?.workspace })
      }
      return jsonResponse(handler)
    }
    return jsonResponse({ ok: true })
  })

  return { calls, spy }
}
