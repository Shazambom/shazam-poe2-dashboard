// ⌘K knows every priced currency and the words players type (first-contact audit, 2026-10-08). Only the index
// widens: the matching is lib/search.js as shipped (owner: "it needs to have no regressions"), so the pinned
// queries below hold today's first results as well as the new ones.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPaletteItems } from '../src/lib/palette.js'
import { SUB_DESTS, SCREEN_COMMANDS } from '../src/lib/dests.js'

const TABS = ['Board', 'Strategy', 'Economy', 'Trading', 'Settings']
const withRuns = () => Object.fromEntries(Object.entries(SCREEN_COMMANDS).map(([s, cs]) => [s, cs.map(c => ({ ...c, run: () => {} }))]))
const CURRENCIES = [['exalted', 'Exalted Orb'], ['perfect-exalted-orb', 'Perfect Exalted Orb'], ['divine', 'Divine Orb'],
  ['chaos', 'Chaos Orb'], ['mirror', 'Mirror of Kalandra'], ['hinekoras-lock', "Hinekora's Lock"], ['seraphs-heart', "Seraph's Heart"]]
  .map(([id, name]) => ({ id, name }))
const WINDOWS = [['24h', 24], ['3d', 72], ['7d', 168], ['14d', 336]].map(([k, h]) =>
  ({ id: `window-${h}`, label: `Time window · ${k}`, hint: 'Picker', aka: [k, 'window', 'range', 'horizon'], run: () => {} }))
const items = (q, screen = 'economy-market') => buildPaletteItems({ tabs: TABS, subDests: SUB_DESTS, screen, screenCommands: withRuns(),
  commands: WINDOWS, rows: [{ id: 'divine', name: 'Divine Orb' }, { id: 'perfect-exalted-orb', name: 'Perfect Exalted Orb' }],
  currencies: CURRENCIES, leagues: [{ id: 'Standard', text: 'Standard' }], tree: [], q })
const first = (q, screen) => items(q, screen)[0]?.label

test('a currency off the board is found, and the plain name beats the longer one', () => {
  assert.equal(first('exalt'), 'Exalted Orb')
  assert.equal(first('exalted orb'), 'Exalted Orb')
  assert.equal(first('seraph'), "Seraph's Heart")
  assert.equal(first('hinekora'), "Hinekora's Lock")
  assert.equal(first('mirror'), 'Mirror of Kalandra')
})

test('a board currency is listed once, not twice', () => {
  const divine = items('divine').filter(i => i.kind === 'cur' && i.id === 'divine')
  assert.equal(divine.length, 1)
})

test('the words players type reach the screen that does the job', () => {
  assert.equal(first('movers'), 'Hold')
  assert.equal(first('rising'), 'Hold')
  assert.equal(first('bulk'), 'Regex')
  assert.equal(first('connect'), 'Settings')
  assert.equal(first('7d'), 'Time window · 7d')
  assert.match(first('window'), /^Time window · /)
})

test('pinned: what already worked keeps its first result', () => {
  assert.equal(first('board'), 'Board')
  assert.equal(first('stash'), 'Stash')
  assert.equal(first('regex'), 'Regex')
  assert.equal(first('mods'), 'Mods')
  assert.equal(first('standard'), 'Standard')
  assert.equal(first('flip'), 'Arbitrage')
  assert.equal(first('', 'board'), 'Add a currency')
})

test('a currency row says whether it is on the board, so Enter can open it either way', () => {
  const rows = items('exalt').filter(i => i.kind === 'cur')
  assert.equal(rows.find(i => i.id === 'exalted').onBoard, false)
  assert.equal(items('perfect').find(i => i.kind === 'cur' && i.id === 'perfect-exalted-orb').onBoard, true)
})
