// Owner, 2026-10-08: "I want stash to be its own tab at the top ... right after board, then strategy then trading then
// economy and then settings". One tab list drives the bar, the ⌘1–6 keys and ⌘K's tabs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DESTS, subsOf } from '../src/lib/dests.js'

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')

test('the tabs are Board · Stash · Strategy · Trading · Economy · Settings', () => {
  const app = src('App.jsx')
  assert.match(app, /const TABS = \['Board', 'Stash', 'Strategy', 'Trading', 'Economy', 'Settings'\]/)
  assert.match(app, /e\.key >= '1' && e\.key <= '6'/, '⌘1–6 reach every tab')
  assert.match(app, /\{tab === 'Stash' && <div className="section"><StashView league=\{league\} \/><\/div>\}/)
  assert.doesNotMatch(src('components/TradingView.jsx'), /StashView|'sales'/, 'the Stash no longer lives under Trading')
})

test('the Stash is the screen right after the Board; Trading keeps Workspace, Live, Regex, Mods', () => {
  assert.deepEqual(DESTS.slice(0, 2).map(d => [d.id, d.section, d.sub, d.label]), [['board', 'Board', null, 'Board'], ['stash', 'Stash', null, 'Stash']])
  assert.deepEqual(subsOf('Trading').map(s => s.id), ['workspace', 'live', 'regex', 'mods'])
  assert.deepEqual(subsOf('Stash'), [])
})

test('every road to the Stash goes to the tab, not to Trading', () => {
  for (const f of ['App.jsx', 'components/RoutesView.jsx']) {
    const s = src(f)
    assert.doesNotMatch(s, /goTrading\('sales'\)/, f)
    assert.match(s, /nav\.goStash\(\)/, f)
  }
  assert.doesNotMatch(src('App.jsx'), /Trading › Stash/)
})
