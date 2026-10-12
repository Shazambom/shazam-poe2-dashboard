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
    ['components/MarketView.jsx', 'value_ex'], ['components/MoversView.jsx', 'medvol'],
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
  assert.ok(s.includes('<Rate value={value.price} num={value.cur}'), 'ModSection renders the price in its market through <Rate> (the readable side)')
  assert.ok(!/fmt\.rate\(value\)/.test(s) && !s.includes('<Wealth'), 'no reference-only or converted price')
})

// Two figures shown side by side (net worth · liquid) keep one scale (CLAUDE.md: "Comparisons keep a common
// scale"): both in the unit the larger one would take, so 0.4 mirror never sits next to 1,459 divine.
test('wealthAs shows an amount in a given unit; the side-by-side figures share the larger one\'s unit', async () => {
  const { wealthAs, wealthUnit: wu } = await import('../src/lib/wealth.js')
  const prices = { mirror: 3_700_000, divine: 700, chaos: 65 }
  const total = 4_450_000, liquid = 990_000   // worth more than one mirror; the smaller figure follows it
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

// Owner, 2026-10-12: net worth "should remain in divine until the number of divines exceed a mirror's value".
test('an amount moves up a tier only once it is worth at least one of that currency', () => {
  const below = wealthUnit(1_200_000, 'exalted', P)            // past the 1M line, but 0.69 of a mirror
  assert.equal(below.unit, 'divine'); assert.ok(Math.abs(below.value - 1_200_000 / 454.2) < 1e-9)
  assert.equal(wealthUnit(1_736_943, 'exalted', P).unit, 'divine')
  assert.equal(wealthUnit(1_736_944, 'exalted', P).unit, 'mirror')
  assert.equal(wealthUnit(-1_200_000, 'exalted', P).unit, 'divine')
  // a divine dearer than the 1000 line: 1500 ex is not yet one divine
  assert.equal(wealthUnit(1500, 'exalted', { exalted: 1, chaos: 47.3, divine: 2000 }).unit, 'chaos')
})

// Owner, 2026-10-12: "a User should be able to override what they value their stash in, be it exalted,
// chaos, divine, hinekoras lock, or mirror".
test('the stash is valued in the currency the user chose, else by the wealth rule', async () => {
  const { stashUnit, STASH_UNITS, wealthAs } = await import('../src/lib/wealth.js')
  const Q = { ...P, 'hinekoras-lock': 90_000 }
  assert.deepEqual(STASH_UNITS, ['exalted', 'chaos', 'divine', 'hinekoras-lock', 'mirror'])
  assert.equal(stashUnit(5000, 'exalted', Q, null), 'divine')
  assert.equal(stashUnit(5000, 'exalted', Q, undefined), 'divine')
  for (const u of STASH_UNITS) assert.equal(stashUnit(5000, 'exalted', Q, u), u)
  assert.ok(Math.abs(wealthAs(5000, 'exalted', Q, 'mirror').value - 5000 / 1_736_944) < 1e-12, 'a small stash in mirrors is a fraction, as asked')
  assert.ok(Math.abs(wealthAs(180_000, 'exalted', Q, 'hinekoras-lock').value - 2) < 1e-9)
  assert.equal(stashUnit(5000, 'exalted', P, 'hinekoras-lock'), 'divine', 'no price for the choice yet: the rule')
  assert.equal(stashUnit(5000, 'exalted', Q, 'vaal'), 'divine', 'not a choice on offer: the rule')
})

test('both net worth sites read the one choice', () => {
  const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8')
  for (const f of ['App.jsx', 'components/StashView.jsx']) assert.ok(/stashUnit\([^)]*stash_unit|stashUnit\([^)]*unitChoice/.test(src(f)), `${f} should take its unit from stashUnit`)
  assert.ok(src('components/StashView.jsx').includes("saveSettings({ stash_unit:"), 'the Stash saves the choice')
})

// Owner, 2026-10-12: the stash's net worth on Auto "should still auto change … when it gets to over 300ex to
// chaos then when it gets to over 5div in value it starts displaying networth in div", and to mirror past one mirror.
test('the stash on Auto: exalted to 300, then chaos, divine from 5 divines, mirror from one mirror', async () => {
  const { stashUnit, STASH_TIERS, wealthUnit: wu } = await import('../src/lib/wealth.js')
  const Q = { exalted: 1, chaos: 40, divine: 700, mirror: 4_000_000 }
  assert.deepEqual(STASH_TIERS, [['mirror', 0, 1], ['divine', 0, 5], ['chaos', 300, 1]])
  const auto = (v) => stashUnit(v, 'exalted', Q, null)
  assert.equal(auto(299), 'exalted')
  assert.equal(auto(300), 'chaos')
  assert.equal(auto(3499), 'chaos', '4.99 divines is still chaos')
  assert.equal(auto(3500), 'divine')
  assert.equal(auto(3_999_999), 'divine')
  assert.equal(auto(4_000_000), 'mirror')
  assert.equal(stashUnit(3500, 'exalted', { exalted: 1, chaos: 40 }, null), 'chaos', 'no divine price: the next tier')
  // the app-wide rule for other amounts keeps its own lines
  assert.equal(wu(150, 'exalted', Q).unit, 'chaos')
  assert.equal(wu(1400, 'exalted', Q).unit, 'divine')
})

// QA 2026-10-12: with a chosen unit the hover named the Auto unit, 0.5 of a mirror hid half the stash's
// worth in rounding, and the top bar printed "liquid 0 ref" before the holdings loaded.
test('a chosen unit reads the same on hover, a fraction keeps two decimals, nothing is drawn before holdings load', async () => {
  const { wealthText: wt, wealthDigits } = await import('../src/lib/wealth.js')
  const Q = { exalted: 1, chaos: 40, divine: 700, mirror: 4_000_000 }
  assert.equal(wt(2_100_000, 'exalted', Q, 'mirror'), '0.525 mirror (2,100,000 exalted)')
  assert.equal(wt(5000, 'exalted', Q, 'mirror'), '0.00125 mirror (5,000 exalted)', 'a small stash in mirrors is never "0"')
  assert.equal(wt(2_100_000, 'exalted', Q, 'exalted'), '2,100,000 exalted')
  assert.equal(wt(2_100_000, 'exalted', Q), '3,000 divine (2,100,000 exalted)')
  assert.equal(wealthDigits(1.7), 1); assert.equal(wealthDigits(2815), 0)
  const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8')
  assert.match(src('components/Wealth.jsx'), /wealthText\(v, ref, status\?\.wealth_prices, unit\)/)
  assert.match(src('components/Wealth.jsx'), /wealthNumber\(w\.value/)
  assert.match(src('App.jsx'), /liquidTop = !capital \|\| capital\?\.syncing \? null/)
})

// Code review 2026-10-12: the lines are exalted amounts whatever the reference, and a tier that IS the
// reference is a tier, never skipped (a 500 divine stash on a divine reference once fell to chaos).
test('the tiers hold on a reference other than exalted', async () => {
  const { stashUnit, wealthUnit: wu } = await import('../src/lib/wealth.js')
  const D = { divine: 1, exalted: 1 / 700, chaos: 40 / 700, mirror: 4_000_000 / 700 }
  const auto = (ex) => stashUnit(ex / 700, 'divine', D, null)
  assert.equal(auto(301), 'chaos'); assert.equal(auto(3400), 'chaos')
  assert.equal(auto(3600), 'divine'); assert.equal(auto(350_000), 'divine'); assert.equal(auto(4_100_000), 'mirror')
  assert.equal(wu(500, 'divine', D).unit, 'divine')
})
