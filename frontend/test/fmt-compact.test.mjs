// Big counts read as amounts (first-contact audit, 2026-10-08): "24,891,610 / 2,347,190" becomes "24.9M / 2.35M".
import test from 'node:test'
import assert from 'node:assert/strict'
import { fmt } from '../src/lib/api.js'

test('compact keeps three significant figures with k / M suffixes', () => {
  assert.equal(fmt.compact(24_891_610), '24.9M')
  assert.equal(fmt.compact(2_347_190), '2.35M')
  assert.equal(fmt.compact(224_446), '224k')
  assert.equal(fmt.compact(26_314), '26.3k')
  assert.equal(fmt.compact(979), '979')
  assert.equal(fmt.compact(0.4), '0.4')
  assert.equal(fmt.compact(null), '–')
})

test('the suffix is chosen after rounding (code review: 999,950 printed "1000k")', () => {
  assert.equal(fmt.compact(999_950), '1M')
  assert.equal(fmt.compact(999_500), '1M')
  assert.equal(fmt.compact(999_499), '999k')
  assert.equal(fmt.compact(999.7), '1k')
  assert.equal(fmt.compact(999.49), '999')
  assert.equal(fmt.compact(1e9), '1B')
  assert.equal(fmt.compact(-999_950), '-1M')
})
