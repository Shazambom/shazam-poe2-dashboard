// EE2's AppConfig() over an injected Prefs record. AppConfig() → the app-level config subset the
// vendored code reads (language, realm, preferredTradeSite, leagueId); AppConfig('price-check') →
// the widget subset. setPrefs() is called by index.js before every build. Defaults mirror
// EE2's own (Config.ts defaultConfig / PriceCheckWindow.vue initInstance).
'use strict'
const DEFAULT_PREFS = Object.freeze({
  leagueId: 'Standard', language: 'en', realm: 'pc-ggg', preferredTradeSite: 'default',
  searchStatRange: 10, defaultAllSelected: false, activateStockFilter: false, collapseListings: 'api',
  apiLatencySeconds: 2, savedAugments: {},
})
let prefs = { ...DEFAULT_PREFS }
let widget = null, config = null
function setPrefs(p) {
  prefs = { ...DEFAULT_PREFS, ...(p || {}) }
  config = { configVersion: 35, leagueId: prefs.leagueId, language: prefs.language, realm: prefs.realm, preferredTradeSite: prefs.preferredTradeSite, widgets: [] }
  widget = { wmId: 0, wmType: 'price-check', searchStatRange: prefs.searchStatRange, defaultAllSelected: prefs.defaultAllSelected,
    activateStockFilter: prefs.activateStockFilter, collapseListings: prefs.collapseListings, apiLatencySeconds: prefs.apiLatencySeconds,
    savedAugments: prefs.savedAugments || {}, coreCurrency: 'exalted', rememberCurrency: false, rememberListingType: false }
  config.widgets = [widget]
}
setPrefs()
function AppConfig(type) { return type ? (type === 'price-check' ? widget : undefined) : config }
// Config.ts:92-117, verbatim logic.
function poeWebApi() {
  const { realm, preferredTradeSite, language } = config
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
  }
}
const TipsFrequency = { Always: 1, MoreOften: 2, Normal: 3, Rarely: 4, VeryRarely: 5, Never: 6 }
module.exports = { AppConfig, poeWebApi, setPrefs, DEFAULT_PREFS, TipsFrequency, updateConfig: () => {}, saveConfig: () => {}, pushHostConfig: () => {}, initConfig: async () => {}, defaultConfig: () => config }
