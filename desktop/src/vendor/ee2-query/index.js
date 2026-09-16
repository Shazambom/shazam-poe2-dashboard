// The vendored EE2 query port — buildQuery(rawItemText, prefs) is the only export (roadmap §8).
// Item clipboard text → the exact `q` EE2's price check would put after `?q=` on a cold start,
// offline, in Node. Runs inside the utilityProcess worker or the --stdin CLI, never in main.
//
//   init(dataDir?)  → { ms, items, stats }   loads EE2's data files + the GGG snapshot once
//   buildQuery(raw, prefs) → { q, name, item:{name, baseType, rarity, itemClass}, host }
//                          | { error: { stage: 'parse'|'lang'|'currency'|'presets'|'request', message } }
'use strict'
const path = require('path')
const { makeFetch } = require('./shims/fetch.js')
const config = require('./shims/config.js')
const tradedata = require('./shims/tradedata.js')
const clientstrings = require('./shims/clientstrings.js')

const DATA_DIR = path.join(__dirname, 'data')

require('./polyfills.js')   // ES2023+ built-ins EE2 relies on, guarded (Electron has them; Node 18 tests don't)
let ee2 = null, ready = null, counts = { items: 0, stats: 0 }

function init(dataDir = DATA_DIR) {
  if (ready) return ready
  ready = (async () => {
    const t0 = Date.now()
    globalThis.fetch = makeFetch(dataDir)   // this process only; refuses anything but ee2data://
    tradedata.setDataDir(dataDir); clientstrings.setDataDir(dataDir)
    config.setPrefs({})
    ee2 = require('./vendor/bundle.cjs')
    await ee2.init('en')
    const td = tradedata.useTradeData()
    counts = { items: td.tradeItemData.value.size, stats: td.tradeStatDataSet.value.size }
    return { ms: Date.now() - t0, ...counts }
  })()
  return ready
}

// CheckedItem.vue:159-179 on a cold start: no previous popup → currency/listingType undefined.
function presetOpts(prefs) {
  const p = { ...config.DEFAULT_PREFS, ...(prefs || {}) }
  return {
    league: p.leagueId, currency: undefined, listingType: undefined,
    collapseListings: p.collapseListings, activateStockFilter: p.activateStockFilter, searchStatRange: p.searchStatRange,
    useEn: (p.language === 'cmn-Hant' && p.realm === 'pc-ggg') || p.preferredTradeSite === 'www',
    defaultAllSelected: p.defaultAllSelected,
  }
}

function displayName(item) {
  const R = ee2.ItemRarity
  const base = item.info?.name || ''
  const name = item.rarity === R.Unique ? (base || item.name || item.info?.refName || '')
    : (item.name && item.name !== base ? `${item.name} ${base}`.trim() : (item.name || base))
  return String(name).slice(0, 60)
}

function buildQuery(raw, prefs) {
  if (!ee2) throw new Error('ee2-query: call init() first')
  const p = { ...config.DEFAULT_PREFS, ...(prefs || {}) }
  config.setPrefs(p)
  if (p.language !== 'en') return { error: { stage: 'lang', message: `language ${p.language} is not supported (en-only data)` } }
  const parsed = ee2.parseClipboard(String(raw || ''))
  if (!parsed.isOk()) return { error: { stage: 'parse', message: String(parsed.error) } }
  const item = parsed.value
  let presets
  try { presets = ee2.createPresets(item, presetOpts(p)) } catch (e) { return { error: { stage: 'presets', message: String(e && e.message || e) } } }
  const active = presets.presets.find(x => x.id === presets.active) || presets.presets[0]
  if (!active) return { error: { stage: 'presets', message: 'no preset' } }
  if (ee2.apiToSatisfySearch(item, active.stats, active.filters) === 'bulk') return { error: { stage: 'currency', message: 'currency / stackable — bulk exchange, not history material' } }
  let q
  try { q = JSON.stringify(ee2.createTradeRequest(active.filters, active.stats, item)) } catch (e) { return { error: { stage: 'request', message: String(e && e.message || e) } } }
  return {
    q, name: displayName(item), host: config.poeWebApi(),
    item: { name: item.name || item.info?.name || '', baseType: item.info?.name || '', rarity: item.rarity || '', itemClass: item.category || '' },
  }
}

module.exports = { init, buildQuery, presetOpts, DATA_DIR }
