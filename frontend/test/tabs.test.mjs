// Owner, 2026-10-08: "strategy should be renamed stash and the stash tab should come first for it then arbitrage, hold,
// and strat calculator"; tabs "board, stash, trading, economy, settings". One tab list drives the bar, ⌘1–5 and ⌘K.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DESTS, subsOf } from '../src/lib/dests.js'

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')

test('the tabs are Board · Stash · Trading · Economy · Settings', () => {
  const app = src('App.jsx')
  assert.match(app, /const TABS = \['Board', 'Stash', 'Trading', 'Economy', 'Settings'\]/)
  assert.match(app, /e\.key >= '1' && e\.key <= '5'/, '⌘1–5 reach every tab')
  assert.match(app, /\{tab === 'Stash' && <StashTab /)
  assert.doesNotMatch(app, /StrategyView|'Strategy'/)
  assert.doesNotMatch(src('components/TradingView.jsx'), /StashView|'sales'/, 'the Stash no longer lives under Trading')
})

test('the Stash section opens on the stash, then Arbitrage, Strat Calculator; Economy is Hold, Inflation, Top movers, Market', () => {
  assert.deepEqual(subsOf('Stash'), [{ id: 'stash', label: 'Stash' }, { id: 'arbitrage', label: 'Arbitrage' }, { id: 'calc', label: 'Strat Calculator' }])
  // owner: "hold and positive movers should be broken out and put under economy. Hold should be first then inflation
  // then top movers then market"
  assert.deepEqual(subsOf('Economy'), [{ id: 'hold', label: 'Hold' }, { id: 'inflation', label: 'Inflation' }, { id: 'movers', label: 'Top movers' }, { id: 'market', label: 'Market' }])
  const eco = src('components/EconomyView.jsx')
  assert.match(eco, /useState\('hold'\)/, 'Economy opens on Hold')
  assert.match(eco, /sub === 'hold' && <HoldView /)
  assert.match(eco, /sub === 'movers' && <MoversView /)
  const hold = src('components/HoldView.jsx')
  assert.doesNotMatch(hold, /Positive movers|isMovers|api\.movers/, 'Hold is one board; the movers have their own')
  assert.match(src('components/MoversView.jsx'), /api\.movers\(hours, MOVERS_N, 'up'\)/)
  assert.doesNotMatch(src('components/StashTab.jsx'), /HoldView/)
  assert.deepEqual(DESTS.slice(0, 2).map(d => d.id), ['board', 'stash'])
  assert.ok(!DESTS.some(d => d.section === 'Strategy'))
  const tab = src('components/StashTab.jsx')
  assert.match(tab, /useState\('stash'\)/, 'opens on the stash')
  assert.match(tab, /sub === 'stash' && <StashView /)
  assert.deepEqual(subsOf('Trading').map(s => s.id), ['workspace', 'live', 'regex', 'mods'])
})

test('every road to the Stash goes to its tab and sub-view', () => {
  for (const f of ['App.jsx', 'components/RoutesView.jsx']) {
    const s = src(f)
    assert.doesNotMatch(s, /goTrading\('sales'\)/, f)
    assert.match(s, /nav\.goStash\(\)/, f)
  }
  assert.match(src('App.jsx'), /if \(e\.type === 'goStash'\) \{ setTab\('Stash'\); setTimeout\(\(\) => nav\.openSub\('Stash', 'stash'\), 0\) \}/)
})
