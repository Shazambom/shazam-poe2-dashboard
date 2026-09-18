// A card priced in a counterpart it trades against directly shows that market's rate; only a
// pair with no market falls back to the cross of two reference prices.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { factorFor, trendIn, valueIn } from '../src/lib/price.js'

// Real numbers from the incident: divine 424.47 ex, chaos 58.07 ex → cross 7.31; market 8.376.
const prices = { exalted: 1, chaos: 58.06851397170583, divine: 424.47447023208883 }
const pairs = { 'divine>chaos': 8.376356033363113, 'chaos>divine': 1 / 8.376356033363113 }
const divine = { id: 'divine', mid: prices.divine }

test('the tile shows the direct market rate, and the whole card scales with it', () => {
  const f = factorFor(divine, 'chaos', prices, pairs)
  assert.ok(Math.abs(divine.mid / f - 8.376356033363113) < 1e-9)
  // buy/sell/sparkline divide by the same factor, so a 10% higher mid still reads 10% higher.
  assert.ok(Math.abs((divine.mid * 1.1) / f - 8.376356033363113 * 1.1) < 1e-9)
})

test('no direct market → the reference cross, exactly as before', () => {
  assert.equal(factorFor(divine, 'chaos', prices, {}), prices.chaos)
  assert.ok(Math.abs(divine.mid / factorFor(divine, 'chaos', prices, {}) - 7.31) < 0.01)
  assert.equal(factorFor(divine, 'chaos', prices, undefined), prices.chaos)
})

test('pricing in the reference itself is untouched (factor 1)', () => {
  assert.equal(factorFor(divine, 'exalted', prices, pairs), 1)
})

test('valueIn follows the same preference order and tolerates missing data', () => {
  assert.equal(valueIn('divine', divine.mid, 'chaos', prices, pairs), 8.376356033363113)
  assert.ok(Math.abs(valueIn('divine', divine.mid, 'chaos', prices, {}) - 7.31) < 0.01)
  assert.equal(valueIn('divine', null, 'chaos', prices, {}), null)
  assert.equal(valueIn('divine', divine.mid, 'nothing', prices, {}), null)
})

test('a zero or missing mid never divides by zero', () => {
  assert.equal(factorFor({ id: 'divine', mid: 0 }, 'chaos', prices, pairs), prices.chaos)
  assert.equal(factorFor({ id: 'divine' }, 'chaos', prices, pairs), prices.chaos)
  assert.equal(factorFor(null, 'chaos', prices, pairs), prices.chaos)
})

// The sparkline is the history of the market the number comes from, so its last point meets
// the number. Points arrive in `trend_num`; repricing into another numeraire scales them the
// same way the mid is scaled.
test('a trend already in the card\'s numeraire is drawn as-is', () => {
  const r = { ...divine, trend_num: 'chaos', trend: [{ t: 1, v: 8.0 }, { t: 2, v: 8.376356033363113 }] }
  const f = factorFor(r, 'chaos', prices, pairs)
  assert.deepEqual(trendIn(r, 'chaos', f, prices, pairs), r.trend)
})

test('a chaos trend shown in exalted scales like the mid does', () => {
  const r = { ...divine, trend_num: 'chaos', trend: [{ t: 1, v: 8.0 }, { t: 2, v: 8.376356033363113 }] }
  const f = factorFor(r, 'exalted', prices, pairs)      // 1
  const out = trendIn(r, 'exalted', f, prices, pairs)
  // last point → the card's mid (the direct rate × chaos's implied reference price)
  assert.ok(Math.abs(out[1].v - divine.mid) < 1e-9)
  assert.ok(Math.abs(out[0].v / out[1].v - 8.0 / 8.376356033363113) < 1e-12)  // shape preserved
})

test('a reference trend without trend_num divides by the factor, as before', () => {
  const r = { ...divine, trend: [{ t: 1, v: 400 }, { t: 2, v: divine.mid }] }
  const f = factorFor(r, 'chaos', prices, pairs)
  const out = trendIn(r, 'chaos', f, prices, pairs)
  assert.ok(Math.abs(out[1].v - 8.376356033363113) < 1e-9)
  assert.equal(trendIn({ id: 'x' }, 'chaos', 1, prices, pairs), undefined)
})
