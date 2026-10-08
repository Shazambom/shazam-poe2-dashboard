// Loop rows (first-contact audit, 2026-10-08): a row says what you need, what you make, how long it takes.
// Loop · Needs · Profit · Yield (tier) · Gold · Takes; the quote time once above the list; the expanded row is the
// trade list, never the score; knobs on beta and dev only; the notional banner is one link.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const rv = readFileSync(new URL('../src/components/RoutesView.jsx', import.meta.url), 'utf8')
const steps = readFileSync(new URL('../src/components/RouteSteps.jsx', import.meta.url), 'utf8')
const cols = rv.slice(rv.indexOf('const COLS = ['), rv.indexOf(']\n', rv.indexOf('const COLS = [')))
const keys = [...cols.matchAll(/\n\s*\['([a-z_]+)',\s*'([^']*)'/g)].map(m => [m[1], m[2]])

test('the row is Needs · Profit · Yield · Gold · Takes, sorted best-first by the hidden score', () => {
  assert.deepEqual(keys, [['commit', 'Needs'], ['margin', 'Profit'], ['velocity', 'Yield'], ['gold', 'Gold'], ['fill_hours', 'Takes']])
  assert.match(rv, /useState\(\{ key: 'score', dir: 'desc' \}\)/)
})

test('yield is a tier badge, not a number or a bar', () => {
  assert.match(rv, /yieldTiers\(/)
  assert.doesNotMatch(rv, /gold-bar/)
  assert.doesNotMatch(rv, /fmt\.n\(r\.velocity/)
})

test('the quote time is stated once above the list, not per row', () => {
  assert.match(rv, /prices from \{fmt\.age\(/)
  assert.doesNotMatch(rv, /<td className="num muted">\{fmt\.age\(r\.max_age_s\)\}<\/td>/)
})

test('the expanded row lists the trades; score parts, digest ages and loop value stay in the engine', () => {
  assert.doesNotMatch(steps, /score_parts/)
  assert.doesNotMatch(steps, /oldest quote/)
  assert.doesNotMatch(steps, /value through loop/)
  assert.match(steps, /Buy /)
  assert.doesNotMatch(steps, /Best offer|<th>Where<\/th>/, 'owner: both columns said the same thing on every row')
})

test('knobs show on beta and dev only; stable shows the presets and Start from', () => {
  assert.match(rv, /useTweaks\(\)/)
  const knobs = ['<GoldValueSlider', 'More filters', '<ArbitrageAlgorithm', 'Minimum margin %']
  for (const k of knobs) {
    const i = rv.indexOf(k)
    assert.ok(i > 0, k)
    const before = rv.slice(Math.max(0, i - 700), i)
    assert.match(before, /tweaks && /, `${k} is behind the tweaks gate`)
  }
  assert.doesNotMatch(rv, /Arbitrage algorithm expander for everyone/)
})

test('the notional banner is the one action, not a sentence', () => {
  assert.match(rv, /Add what you hold/)
  assert.doesNotMatch(rv, /to size them to what you hold/)
})
