// The number-to-regex core of the Regex tab (docs/regex-filters-plan.md). Written before
// frontend/src/lib/regex/number.js existed. The expectations are the game's search-box facts,
// typed here; the exhaustive sweeps are the property the examples only sample.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { minRegex, rangeRegex, priceRange } from '../src/lib/regex/number.js'

// `.` stands for "any digit" in these strings; downstream turns it into \d where it matters.
const digits = (r) => new RegExp('^(?:' + r.replace(/\./g, '\\d') + ')$')

test('minRegex: the four upstream regressions', () => {
  const re290 = digits(minRegex('290'))
  for (let v = 200; v < 290; v++) assert.equal(re290.test(String(v)), false, `290 must not match ${v}`)
  for (let v = 290; v <= 999; v++) assert.equal(re290.test(String(v)), true, `290 must match ${v}`)
  for (const n of [175, 185]) {
    const re = digits(minRegex(String(n)))
    for (let v = n; v <= 999; v++) assert.equal(re.test(String(v)), true, `${n} must match ${v}`)
  }
  const re105 = digits(minRegex('105'))
  for (const v of [200, 300, 400, 500, 600, 700, 800, 900]) assert.equal(re105.test(String(v)), true)
})

test('minRegex: exact hundreds collapse', () => {
  assert.equal(minRegex('100'), '[1-9]..')
  assert.equal(minRegex('200'), '[2-9]..')
  assert.equal(minRegex('500'), '[5-9]..')
  assert.equal(minRegex('900'), '9..')
})

test('minRegex: edges', () => {
  const re999 = digits(minRegex('999'))
  assert.equal(re999.test('999'), true); assert.equal(re999.test('998'), false); assert.equal(re999.test('100'), false)
  const re990 = digits(minRegex('990'))
  for (let v = 990; v <= 999; v++) assert.equal(re990.test(String(v)), true)
  assert.equal(re990.test('989'), false)
  assert.equal(minRegex(''), '')
  assert.equal(minRegex('abc'), '')
  assert.equal(minRegex('0'), '')
  // A value Round to tens takes to 0 is "any": no pattern, so callers drop the term.
  assert.equal(minRegex('5', true), '')
  assert.equal(minRegex('9', true), '')
  assert.equal(minRegex(7), minRegex('7'))
})

test('minRegex: every n in 1..999 matches exactly v >= n, both modes', () => {
  for (let n = 1; n <= 999; n++) {
    const r = minRegex(String(n))
    assert.ok(r, `n=${n} produced nothing`)
    assert.ok(r.length <= 30, `n=${n} too long: ${r}`)
    const re = digits(r)
    for (let v = 1; v <= 999; v++) assert.equal(re.test(String(v)), v >= n, `n=${n} v=${v} re=${r}`)
  }
  for (let n = 1; n <= 9; n++) assert.equal(minRegex(String(n), true), '')
  for (let n = 10; n <= 999; n++) {
    const r = minRegex(String(n), true)
    const floor = Math.floor(n / 10) * 10
    const re = digits(r)
    for (let v = 1; v <= 999; v++) assert.equal(re.test(String(v)), v >= floor, `round n=${n} v=${v} re=${r}`)
  }
})

test('rangeRegex: compact forms', () => {
  const cases = [
    ['23', '27', '2[3-7]'], ['20', '29', '2.'], ['10', '99', '[1-9].'],
    ['15', '42', '(1[5-9]|[2-3].|4[0-2])'], ['15', '40', '(1[5-9]|[2-3].|40)'], ['19', '30', '(19|2.|30)'],
    ['30', '50', '([3-4].|50)'], ['30', '59', '[3-5].'], ['23', '23', '23'],
    ['3', '7', '[3-7]'], ['5', '5', '5'], ['0', '9', '.'],
    ['5', '20', '([5-9]|1.|20)'], ['8', '12', '([8-9]|1[0-2])'], ['1', '99', '([1-9]|[1-9].)'],
  ]
  for (const [lo, hi, want] of cases) assert.equal(rangeRegex(lo, hi), want, `${lo}-${hi}`)
  assert.equal(rangeRegex('25', '48', true), '([2-3].|40)')
  assert.equal(rangeRegex('25', '29', true), '20')
  assert.equal(rangeRegex('+23%', '27'), '2[3-7]')
  assert.equal(rangeRegex('100', '200'), '')
  assert.equal(rangeRegex('10', '150'), '')
  assert.equal(rangeRegex('abc', '27'), '')
  assert.equal(rangeRegex('50', '30'), '')
})

test('rangeRegex: every 1..99 pair matches exactly its integers', () => {
  for (let lo = 1; lo <= 99; lo++) for (let hi = lo; hi <= 99; hi++) {
    const re = digits(rangeRegex(String(lo), String(hi)))
    for (let n = 1; n <= 99; n++) assert.equal(re.test(String(n)), n >= lo && n <= hi, `${lo}-${hi} n=${n}`)
  }
})

test('priceRange: inclusive, currency-bound, normalised, compact, decimals read by their whole part', () => {
  // The way the game does it: the quoted body, unanchored, against the item's price note.
  const hit = (r, price, cur) => new RegExp(r.slice(1, -1)).test(`~price ${price} ${cur}`)
  // Notes are often fractional ("~b/o 2.5 exalted"); 2.5 counts as 2.
  assert.equal(hit(priceRange('1', '25', 'exalted'), '2.5', 'exalted'), true)
  assert.equal(hit(priceRange('1', '2', 'exalted'), '2.5', 'exalted'), true)
  assert.equal(hit(priceRange('1', '9', 'exalted'), '12.5', 'exalted'), false)
  assert.equal(hit(priceRange('3', '9', 'exalted'), '2.9', 'exalted'), false)
  const r = priceRange('8', '123', 'chaos')
  assert.equal(hit(r, 7, 'chaos'), false); assert.equal(hit(r, 8, 'chaos'), true)
  assert.equal(hit(r, 99, 'chaos'), true); assert.equal(hit(r, 123, 'chaos'), true); assert.equal(hit(r, 124, 'chaos'), false)
  const d = priceRange('100', '999', 'divine')
  assert.equal(hit(d, 100, 'divine'), true); assert.equal(hit(d, 999, 'divine'), true); assert.equal(hit(d, 100, 'chaos'), false)
  const n = priceRange('1200', '-5', 'chaos')
  assert.equal(hit(n, 0, 'chaos'), true); assert.equal(hit(n, 999, 'chaos'), true); assert.equal(hit(n, 1000, 'chaos'), false)
  assert.equal(priceRange('0', '999', 'chaos'), '" (0|[1-9]\\d{0,2})(\\.\\d+)? chaos"')
  assert.equal(priceRange('', '25', 'chaos'), priceRange('0', '25', 'chaos'))
  assert.equal(priceRange('25', '', 'chaos'), priceRange('25', '999', 'chaos'))
  // The leading space anchors on the note: without it a 1-to-25 range matches "~price 124 chaos"
  // through "24 chaos".
  assert.equal(priceRange('1', '25', 'exalted'), '" ([1-9]|1\\d|2[0-5])(\\.\\d+)? exalted"')
  assert.equal(priceRange('1', '9', 'divine'), '" [1-9](\\.\\d+)? divine"')
  assert.equal(hit(priceRange('1', '25', 'exalted'), 124, 'exalted'), false)
})
