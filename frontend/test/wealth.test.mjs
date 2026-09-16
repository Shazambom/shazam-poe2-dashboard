// The ONE wealth-display rule: values are kept in the reference currency (ex) under the hood;
// the display layer re-denominates large amounts into chaos / divine per WEALTH_TIERS.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { wealthUnit, wealthText, WEALTH_TIERS } = await import('../src/lib/wealth.js')
const P = { exalted: 1, chaos: 47.3, divine: 454.2, mirror: 1_736_944 }

test('tiers are one ordered table (unit, min reference amount)', () => {
  assert.deepEqual(WEALTH_TIERS, [['mirror', 1_000_000], ['divine', 1000], ['chaos', 100]])
})

test('small amounts stay in the reference', () => {
  assert.deepEqual(wealthUnit(50, 'exalted', P), { value: 50, unit: 'exalted' })
  assert.deepEqual(wealthUnit(99.9, 'exalted', P), { value: 99.9, unit: 'exalted' })
})

test('amounts past a tier re-denominate into that tier currency', () => {
  const c = wealthUnit(300, 'exalted', P)
  assert.equal(c.unit, 'chaos'); assert.ok(Math.abs(c.value - 300 / 47.3) < 1e-9)
  const d = wealthUnit(5000, 'exalted', P)
  assert.equal(d.unit, 'divine'); assert.ok(Math.abs(d.value - 5000 / 454.2) < 1e-9)
  const m = wealthUnit(2_000_000_000, 'exalted', P)
  assert.equal(m.unit, 'mirror'); assert.ok(Math.abs(m.value - 2e9 / 1_736_944) < 1e-6)
  assert.equal(wealthUnit(2_000_000_000, 'exalted', { exalted: 1, divine: 454.2 }).unit, 'divine')   // no mirror price → next tier
})

test('falls back gracefully: no price for the tier unit, null, negative, the tier IS the reference', () => {
  assert.deepEqual(wealthUnit(5000, 'exalted', { exalted: 1 }), { value: 5000, unit: 'exalted' })
  assert.equal(wealthUnit(null, 'exalted', P), null)
  const neg = wealthUnit(-5000, 'exalted', P)
  assert.equal(neg.unit, 'divine'); assert.ok(neg.value < 0)
  assert.deepEqual(wealthUnit(5000, 'divine', { divine: 1, exalted: 1 / 454.2 }), { value: 5000, unit: 'divine' })
})

test('wealthText is the tooltip form: display + the raw reference amount', () => {
  assert.equal(wealthText(5000, 'exalted', P), '11 divine (5,000 exalted)')
  assert.equal(wealthText(300, 'exalted', P), '6.3 chaos (300 exalted)')
  assert.equal(wealthText(50, 'exalted', P), '50 exalted')
})

// Every place the UI shows an amount of wealth goes through <Wealth> (or wealthText for titles).
test('wealth display sites use the shared component', () => {
  const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8')
  for (const [f, needle] of [
    ['App.jsx', 'capital <b>'], ['components/CapitalCard.jsx', 'Total <b>'], ['components/CardDetail.jsx', 'realizable'],
    ['components/RouteSteps.jsx', 'value through loop'], ['components/RoutesView.jsx', 'margin_ref'],
    ['components/MarketView.jsx', 'value_ex'], ['components/HoldView.jsx', 'medvol'],
  ]) {
    const s = src(f)
    assert.ok(s.includes('<Wealth'), `${f} (${needle}) should render <Wealth>`)
    assert.ok(!/fmt\.n\([^)]*(value_ref|total_ref|realizable_ref|realizable_total_ref|margin_ref|liquidity_ref|volume_ref_per_h|value_ex|medvol)/.test(s), `${f} still formats wealth by hand`)
  }
})
