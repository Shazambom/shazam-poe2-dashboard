// A card priced in a counterpart it trades against directly shows that market's rate; only a
// pair with no market falls back to the cross of two reference prices.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { factorFor, valueIn } from '../src/lib/price.js'

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
