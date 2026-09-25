// The Regex tab's persisted settings (docs/regex-filters-plan.md): a stored blob of any age folds
// over the defaults, unknown keys are dropped, arrays replace, and the limit predicate flips at 251.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaults, defaultOptions, merge, overLimit, LIMIT, KINDS } from '../src/lib/regex/index.js'

test('merge of nothing is the defaults, and never the same object', () => {
  const m = merge(undefined)
  assert.deepEqual(m.waystone, defaults.waystone)
  assert.deepEqual(m.tablet, defaults.tablet)
  assert.equal(m.kind, defaultOptions.kind)
  assert.equal(m.autoCopy, defaultOptions.autoCopy)
  assert.notEqual(m.waystone, defaults.waystone)
  assert.deepEqual(merge(null).tablet, defaults.tablet)
  assert.deepEqual(merge('junk').waystone, defaults.waystone)
  assert.deepEqual(KINDS, ['waystone', 'tablet'])
})

test('a partial blob keeps what it has and fills the rest', () => {
  const m = merge({ kind: 'tablet', waystone: { tier: { min: 14 }, want: [{ id: 'x', min: 5 }], round10: true } })
  assert.equal(m.kind, 'tablet')
  assert.deepEqual(m.waystone.tier, { min: 14, max: 16 })
  assert.deepEqual(m.waystone.want, [{ id: 'x', min: 5 }])
  assert.equal(m.waystone.round10, true)
  assert.deepEqual(m.waystone.rarity, defaults.waystone.rarity)
  assert.deepEqual(m.tablet, defaults.tablet)
})

test('keys the app does not know are dropped, arrays replace rather than merge', () => {
  const m = merge({ bogus: 1, waystone: { bogus: 2, avoid: ['a', 'b'] }, tablet: { type: { ritual: true, bogus: true } } })
  assert.equal('bogus' in m, false)
  assert.equal('bogus' in m.waystone, false)
  assert.deepEqual(m.waystone.avoid, ['a', 'b'])
  assert.equal(m.tablet.type.ritual, true)
  assert.equal('bogus' in m.tablet.type, false)
  assert.deepEqual(merge({ waystone: { avoid: [] } }).waystone.avoid, [])
})

test('merge never mutates the defaults', () => {
  const m = merge({ waystone: { want: [{ id: 'x', min: 1 }] } })
  m.waystone.want.push({ id: 'y', min: 0 })
  m.waystone.tier.min = 9
  assert.deepEqual(defaults.waystone.want, [])
  assert.equal(defaults.waystone.tier.min, 1)
  assert.deepEqual(merge(undefined).waystone.want, [])
})

test('the limit predicate flips at 251 characters', () => {
  assert.equal(LIMIT, 250)
  assert.equal(overLimit('x'.repeat(250)), false)
  assert.equal(overLimit('x'.repeat(251)), true)
  assert.equal(overLimit(''), false)
})
