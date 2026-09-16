// Prefs the vendored EE2 code consumes (roadmap §5), read from EE2's own config.json via the
// integration package's loadConfig(); anything missing falls back to EE2's defaults (mirrored in
// the config shim). `host` and `useEn` are derived exactly as EE2 derives them.
'use strict'
const { DEFAULT_PREFS } = require('../vendor/ee2-query/shims/config.js')

function hostFor({ language, realm, preferredTradeSite }) {
  if (preferredTradeSite === 'www') return 'www.pathofexile.com'
  switch (language) {
    case 'en': return 'www.pathofexile.com'
    case 'ru': return 'ru.pathofexile.com'
    case 'cmn-Hant': return realm === 'pc-garena' ? 'pathofexile.tw' : 'www.pathofexile.com'
    case 'ko': return 'poe.kakaogames.com'
    case 'ja': return 'jp.pathofexile.com'
    case 'de': return 'de.pathofexile.com'
    case 'es': return 'es.pathofexile.com'
    case 'pt': return 'br.pathofexile.com'
    case 'fr': return 'fr.pathofexile.com'
    default: return 'www.pathofexile.com'
  }
}

// cfg = the parsed EE2 config.json (or null). Returns { prefs, source: 'ee2' | 'default' }.
function prefsFromConfig(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : null
  const w = c && Array.isArray(c.widgets) ? c.widgets.find(x => x && x.wmType === 'price-check') : null
  const pick = (obj, key) => (obj && obj[key] !== undefined && obj[key] !== null ? obj[key] : DEFAULT_PREFS[key])
  const prefs = {
    leagueId: pick(c, 'leagueId'), language: pick(c, 'language'), realm: pick(c, 'realm'), preferredTradeSite: pick(c, 'preferredTradeSite'),
    searchStatRange: Number(pick(w, 'searchStatRange')) || DEFAULT_PREFS.searchStatRange,
    defaultAllSelected: !!pick(w, 'defaultAllSelected'), activateStockFilter: !!pick(w, 'activateStockFilter'),
    collapseListings: pick(w, 'collapseListings') === 'app' ? 'app' : 'api',
    savedAugments: (w && w.savedAugments && typeof w.savedAugments === 'object') ? w.savedAugments : {},
  }
  prefs.host = hostFor(prefs)
  prefs.useEn = (prefs.language === 'cmn-Hant' && prefs.realm === 'pc-ggg') || prefs.preferredTradeSite === 'www'
  return { prefs, source: c ? 'ee2' : 'default' }
}

function readPrefs() {
  let cfg = null
  try { cfg = require('../integrations/exiled-exchange/ee2-config.js').loadConfig() } catch { cfg = null }
  return prefsFromConfig(cfg)
}

module.exports = { prefsFromConfig, readPrefs, hostFor }
