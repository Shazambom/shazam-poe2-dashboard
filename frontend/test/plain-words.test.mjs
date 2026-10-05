// The learnability pass's words (docs/learnability-plan.md parts 2 and 3): labels in players' words, no narration of
// how the app works, and an empty screen offers the one action that helps. Each pair below is today → after.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = (f) => readFileSync(new URL(`../src/components/${f}.jsx`, import.meta.url), 'utf8')

test('the market tooltip says when, not a raw timestamp', () => {
  const s = src('SyncControls')
  assert.doesNotMatch(s, /`last hour \$\{/)
  assert.match(s, /Last market update \$\{fmt\.hourLabel\(status\.digest\.last_hour\)\}/)
})

test('Convert explains nothing about loops', () => {
  assert.doesNotMatch(src('ConvertView'), /an open path, not a loop/)
  assert.match(src('ConvertView'), /Cheapest way to turn one currency into another<\/span>/)
})

test('Hold: the numeraire switch shows the currency, and the last column says Confidence', () => {
  const s = src('HoldView')
  assert.doesNotMatch(s, />vs \{k\[0\]\.toUpperCase\(\) \+ k\.slice\(1\)\}</)
  assert.match(s, />vs <Cur name=\{name\} size=\{14\} \/><\/button>/)
  assert.doesNotMatch(s, />Conf\.</)
  assert.match(s, />Confidence<\/th>/)
  assert.doesNotMatch(s, /Hard-asset numeraire/)
})

test('Hold\'s first run shows loading rows, not a paragraph about poe2scout', () => {
  const s = src('HoldView')
  assert.doesNotMatch(s, /Building the asset history from poe2scout/)
  assert.match(s, /\{\(busy \|\| data\?\.building\) && rows\.length === 0 && <table>/, 'loading rows while the history builds')
  assert.doesNotMatch(s, /the backfill may still be running/)
})

test('Inflation: no theory on screen, a real start date, and no hour count', () => {
  const s = src('InflationView')
  for (const gone of ['soft currencies priced in a hard asset', 'Hard-asset anchor', 'Basket inflation', 'since data start',
    'rising = dump soft, hold hard', 'h of data']) assert.ok(!s.includes(gone), gone)
  assert.match(s, /Inflation vs \{data\.anchor_name\}/)
  assert.match(s, /since \{sinceLabel\}/)
  assert.match(s, />Anchor\n/)
})

test('an Inflation anchor with too few trades offers the Divine anchor', () => {
  const s = src('InflationView')
  assert.doesNotMatch(s, /Try the Divine anchor \(denser\), or let more hours accrue/)
  assert.match(s, /Not enough trades yet\./)
  assert.match(s, /onClick=\{\(\) => setAnchor\('divine'\)\}>Use Divine Orb<\/button>/)
})

test('Market: "All markets", and an empty pair says only that', () => {
  const s = src('MarketView')
  assert.doesNotMatch(s, /Edges in the current graph/)
  assert.match(s, />All markets</)
  assert.doesNotMatch(s, /The hourly digest fills in as it syncs/)
  assert.match(s, /No trades for this pair yet\./)
})

test('Live\'s empty states say what to do, and offer the Workspace', () => {
  const s = src('LiveView')
  assert.doesNotMatch(s, /Armed watches ping here\./)
  assert.match(s, /Press Go live on a search\./)
  assert.doesNotMatch(s, /No saved searches yet — add some in Workspace\./)
  assert.match(s, /No saved searches yet\./)
  assert.match(s, /onClick=\{\(\) => nav\.openTrading\('workspace'\)\}>Open Workspace<\/button>/)
})

test('Settings: no internals in the copy, and no account panel that only says "not configured"', () => {
  assert.doesNotMatch(src('NotificationsPanel'), /analytics sidecar/)
  assert.match(src('NotificationsPanel'), /a currency looks about to move/)
  assert.doesNotMatch(src('TradingSettings'), /the EE2 history folder never travels/)
  assert.match(src('TradingSettings'), /Exiled Exchange 2 history stays on this computer/)
  const acct = src('AccountsPanel')
  assert.doesNotMatch(acct, /See README → OAuth/)
  assert.match(acct, /\{oa\?\.configured && <>\s*\n\s*<h2 style=\{\{ marginTop: 24 \}\}>Path of Exile account/)
})
