// A card shows the rate of the market that prices it. That is no longer a special case: the
// backend sends ONE price table (Graph.values — every currency through its deepest markets), so
// the ratio of two of its prices IS that market's rate, and nothing on a card can contradict
// anything else on it. These helpers only divide.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { factorFor, trendIn, valueIn } from '../src/lib/price.js'

// Real numbers from the incident: the divine↔chaos market trades at 8.376, chaos is 58.07 ex, so
// Divine is 486.4 ex — priced through the market that trades it, not through a thin exalted one.
const MARKET = 8.376356033363113
const prices = { exalted: 1, chaos: 58.06851397170583, divine: 58.06851397170583 * MARKET }
const divine = { id: 'divine', mid: prices.divine }

test('the tile shows the rate of the market that prices the card', () => {
  const f = factorFor(divine, 'chaos', prices)
  assert.ok(Math.abs(divine.mid / f - MARKET) < 1e-9)
  // buy/sell/sparkline divide by the same factor, so a 10% higher mid still reads 10% higher.
  assert.ok(Math.abs((divine.mid * 1.1) / f - MARKET * 1.1) < 1e-9)
})

test('pricing in the reference itself is untouched (factor 1)', () => {
  assert.equal(factorFor(divine, 'exalted', prices), 1)
})

test('an unpriced numeraire falls back to 1 rather than dividing by nothing', () => {
  assert.equal(factorFor(divine, 'nothing', prices), 1)
  assert.equal(factorFor(divine, 'chaos', undefined), 1)
  assert.equal(factorFor(null, 'chaos', prices), prices.chaos)
})

test('valueIn is the same ratio, and tolerates missing data', () => {
  assert.ok(Math.abs(valueIn('divine', divine.mid, 'chaos', prices) - MARKET) < 1e-9)
  assert.equal(valueIn('divine', null, 'chaos', prices), null)
  assert.equal(valueIn('divine', divine.mid, 'nothing', prices), null)
})

// The sparkline is the history of the markets the number comes from, so its last point meets the
// number. Points arrive in `trend_num`; repricing into another numeraire scales them like the mid.
test('a trend already in the card\'s numeraire is drawn as-is', () => {
  const r = { ...divine, trend_num: 'chaos', trend: [{ t: 1, v: 8.0 }, { t: 2, v: MARKET }] }
  const f = factorFor(r, 'chaos', prices)
  assert.deepEqual(trendIn(r, 'chaos', f, prices), r.trend)
})

test('a chaos trend shown in exalted scales like the mid does', () => {
  const r = { ...divine, trend_num: 'chaos', trend: [{ t: 1, v: 8.0 }, { t: 2, v: MARKET }] }
  const f = factorFor(r, 'exalted', prices)      // 1
  const out = trendIn(r, 'exalted', f, prices)
  assert.ok(Math.abs(out[1].v - divine.mid) < 1e-9)                       // last point = the number
  assert.ok(Math.abs(out[0].v / out[1].v - 8.0 / MARKET) < 1e-12)         // shape preserved
})

test('a reference trend without trend_num divides by the factor, as before', () => {
  const r = { ...divine, trend: [{ t: 1, v: 400 }, { t: 2, v: divine.mid }] }
  const f = factorFor(r, 'chaos', prices)
  const out = trendIn(r, 'chaos', f, prices)
  assert.ok(Math.abs(out[1].v - MARKET) < 1e-9)
  assert.equal(trendIn({ id: 'x' }, 'chaos', 1, prices), undefined)
})
