// The app's 12 distinct screens — ONE list feeding each section's sub-tabs, ⌘K, the feedback sweep and
// the opener's allow-list. The sections used to keep their own tab lists, so the Strat Calculator, Regex
// and Mods were never photographed for a report nor listed in ⌘K (found reading report FY0M4R, 2026-10-02).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DESTS, SUB_DESTS, SNAP_PARAM, subsOf } from '../src/lib/dests.js'

const IDS = ['board', 'stash', 'strategy-arbitrage', 'strategy-hold', 'strategy-calc', 'economy-inflation', 'economy-market',
  'trading-workspace', 'trading-live', 'trading-regex', 'trading-mods', 'settings']

test('twelve screens with unique slug ids: board, every sub-view, settings', () => {
  const ids = DESTS.map(d => d.id)
  assert.deepEqual(ids, IDS)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) assert.match(id, /^[a-z]+(-[a-z]+)?$/)
  for (const d of DESTS) assert.ok(d.section && d.label, d.id)
})

test('each section\'s sub-tabs are its slice of the list, in the order the tabs show', () => {
  assert.deepEqual(subsOf('Strategy'), [{ id: 'arbitrage', label: 'Arbitrage' }, { id: 'hold', label: 'Hold' }, { id: 'calc', label: 'Strat Calculator' }])
  assert.deepEqual(subsOf('Economy'), [{ id: 'inflation', label: 'Inflation' }, { id: 'market', label: 'Market' }])
  assert.deepEqual(subsOf('Trading').map(s => s.id), ['workspace', 'live', 'regex', 'mods'])
  assert.deepEqual(subsOf('Stash'), [], 'the Stash is a tab of its own, with no sub-views')
  for (const [file, section] of [['StrategyView', 'Strategy'], ['EconomyView', 'Economy'], ['TradingView', 'Trading']]) {
    const src = readFileSync(new URL(`../src/components/${file}.jsx`, import.meta.url), 'utf8')
    assert.match(src, new RegExp(`const SUBS = subsOf\\('${section}'\\)`), `${file} reads its tabs from the one list`)
    assert.doesNotMatch(src, /\{ id: '[a-z]+', label: /, `${file} keeps no tab list of its own`)
  }
})

test('SUB_DESTS (⌘K) is derived: every sub-view, in order', () => {
  assert.deepEqual(SUB_DESTS.map(d => `${d.section}/${d.sub}`), IDS.filter(i => i.includes('-')).map(i => {
    const [s, sub] = i.split('-'); return `${s[0].toUpperCase()}${s.slice(1)}/${sub}`
  }))
  assert.equal(SNAP_PARAM, 'snap')
})
