// prefsFromConfig: every Prefs field from a fixture config.json; defaults when the widget is missing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { prefsFromConfig, hostFor } = require('../src/ee2-history/prefs.js')

const cfg = { configVersion: 35, leagueId: 'Forbidden Rites', language: 'en', realm: 'pc-ggg', preferredTradeSite: 'default',
  widgets: [{ wmType: 'overlay' }, { wmType: 'price-check', searchStatRange: 20, defaultAllSelected: true, activateStockFilter: true, collapseListings: 'app', savedAugments: { a: [null] } }] }

test('reads every field from EE2 config and derives host/useEn', () => {
  const { prefs, source } = prefsFromConfig(cfg)
  assert.equal(source, 'ee2')
  assert.deepEqual(prefs, { leagueId: 'Forbidden Rites', language: 'en', realm: 'pc-ggg', preferredTradeSite: 'default', searchStatRange: 20, defaultAllSelected: true,
    activateStockFilter: true, collapseListings: 'app', savedAugments: { a: [null] }, host: 'www.pathofexile.com', useEn: false })
})

test('missing config / widget → EE2 defaults', () => {
  const { prefs, source } = prefsFromConfig(null)
  assert.equal(source, 'default')
  assert.deepEqual(prefs, { leagueId: 'Standard', language: 'en', realm: 'pc-ggg', preferredTradeSite: 'default', searchStatRange: 10, defaultAllSelected: false, activateStockFilter: false, collapseListings: 'api', savedAugments: {}, host: 'www.pathofexile.com', useEn: false })
  assert.equal(prefsFromConfig({ language: 'en', widgets: [] }).prefs.searchStatRange, 10)
})

test('host per language/realm branch; useEn for cmn-Hant on pc-ggg and for www', () => {
  assert.equal(hostFor({ language: 'cmn-Hant', realm: 'pc-garena' }), 'pathofexile.tw')
  assert.equal(hostFor({ language: 'cmn-Hant', realm: 'pc-ggg' }), 'www.pathofexile.com')
  assert.equal(hostFor({ language: 'ko' }), 'poe.kakaogames.com')
  assert.equal(hostFor({ language: 'de', preferredTradeSite: 'www' }), 'www.pathofexile.com')
  assert.equal(prefsFromConfig({ language: 'cmn-Hant', realm: 'pc-ggg' }).prefs.useEn, true)
  assert.equal(prefsFromConfig({ language: 'de', preferredTradeSite: 'www' }).prefs.useEn, true)
})
