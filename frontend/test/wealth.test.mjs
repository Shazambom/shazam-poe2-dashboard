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
    ['App.jsx', 'net worth <b>'], ['components/StashView.jsx', 'Net worth'], ['components/CardDetail.jsx', 'realizable'],
    ['components/RouteSteps.jsx', 'value through loop'], ['components/RoutesView.jsx', 'margin_ref'],
    ['components/MarketView.jsx', 'value_ex'], ['components/HoldView.jsx', 'medvol'],
  ]) {
    const s = src(f)
    assert.ok(s.includes('<Wealth'), `${f} (${needle}) should render <Wealth>`)
    assert.ok(!/fmt\.n\([^)]*(value_ref|total_ref|realizable_ref|realizable_total_ref|margin_ref|liquidity_ref|volume_ref_per_h|value_ex|medvol)/.test(s), `${f} still formats wealth by hand`)
  }
})

// The volume rule (CLAUDE.md): an amount native to a currency shows in that currency, precisely;
// only a native number too large to read falls back to the wealth rule, as an approximation.
test('nativeAmount keeps a native price and approximates only an unreadable one', async () => {
  const { nativeAmount, NATIVE_MAX } = await import('../src/lib/wealth.js')
  assert.equal(NATIVE_MAX, 1000)
  assert.deepEqual(nativeAmount(2.1, 'divine', 953.8, 'exalted', P), { value: 2.1, unit: 'divine', approx: false })
  assert.deepEqual(nativeAmount(0.31, 'exalted', 0.31, 'exalted', P), { value: 0.31, unit: 'exalted', approx: false })
  assert.deepEqual(nativeAmount(999, 'chaos', 47_252, 'exalted', P), { value: 999, unit: 'chaos', approx: false })
  const big = nativeAmount(1005, 'exalted', 1005, 'exalted', P)          // a rune whose market is exalted
  assert.equal(big.unit, 'divine'); assert.equal(big.approx, true); assert.ok(Math.abs(big.value - 1005 / 454.2) < 1e-9)
  assert.deepEqual(nativeAmount(1005, 'exalted', null, 'exalted', P), { value: 1005, unit: 'exalted', approx: false }, 'no reference value: the native number, not a guess')
  assert.equal(nativeAmount(null, 'exalted', 1, 'exalted', P), null)
})

test('the Mods cost renders the native price, not the reference value', () => {
  const s = readFileSync(new URL('../src/components/ModSection.jsx', import.meta.url), 'utf8')
  assert.ok(s.includes('<Native'), 'ModSection renders <Native>')
  assert.ok(!/fmt\.rate\(value\)/.test(s) && !s.includes('<Wealth'), 'no reference-only or converted price')
})

// Two figures shown side by side (net worth · liquid) keep one scale (CLAUDE.md: "Comparisons keep a common
// scale"): both in the unit the larger one would take, so 0.4 mirror never sits next to 1,459 divine.
test('wealthAs shows an amount in a given unit; the side-by-side figures share the larger one\'s unit', async () => {
  const { wealthAs, wealthUnit: wu } = await import('../src/lib/wealth.js')
  const prices = { mirror: 3_700_000, divine: 700, chaos: 65 }
  const total = 1_450_000, liquid = 990_000
  const unit = wu(Math.max(total, liquid), 'exalted', prices).unit
  assert.equal(unit, 'mirror')
  assert.deepEqual(wealthAs(liquid, 'exalted', prices, unit), { value: liquid / 3_700_000, unit: 'mirror' })
  assert.deepEqual(wealthAs(50, 'exalted', prices, 'exalted'), { value: 50, unit: 'exalted' })
  assert.deepEqual(wealthAs(50, 'exalted', {}, 'divine'), wu(50, 'exalted', {}), 'no price for the unit: the usual rule')
})

test('the paired figures (top bar, Stash) render in one unit', () => {
  const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8')
  assert.match(src('App.jsx'), /unit=\{pairUnit\}[\s\S]*unit=\{pairUnit\}/)
  assert.match(src('components/StashView.jsx'), /unit=\{pairUnit\}[\s\S]*unit=\{pairUnit\}/)
  assert.match(src('components/Wealth.jsx'), /unit = null/)
})
