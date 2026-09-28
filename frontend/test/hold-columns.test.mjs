// Hold's two return columns look in opposite directions, and the headers must say so as a pair:
// "Past 3d (Div)" looks back, "Predicted +3d" looks forward. Both follow the horizon picker.
// Run:  node --test frontend/test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ROOT = new URL('../../', import.meta.url).pathname
const hold = readFileSync(`${ROOT}frontend/src/components/HoldView.jsx`, 'utf8')

test('the backward-looking column says it is the past, over the same horizon as the forecast', () => {
  assert.ok(hold.includes('>Past {delta}d ({unit})</th>'), 'header reads "Past Nd (Div)"')
  assert.ok(hold.includes('>Predicted +{delta}d</th>'), 'its forward-looking partner is unchanged')
  assert.ok(!hold.includes('>Return ({unit})</th>'), 'the ambiguous "Return (Div)" is gone')
})

test('the Hold score tooltip describes the ranking that ships', () => {
  // since 2026-09-28: holdscore.hold_rank — kept value, steadiness, a steady climb and price,
  // each ranked against the day's board (docs/hold-research.md)
  assert.ok(!hold.includes('Return × confidence'), 'the pre-0.3.2 `ret * conf` formula is gone')
  assert.ok(!hold.includes('Past return weighed against max drawdown'), 'the 0.3.2 score is gone')
  assert.ok(hold.includes('title="Value kept, steadiness, a steady climb, price and how it held in past leagues, each ranked against today\'s board (0–100). Caution sets how much steadiness counts."'))
  assert.ok(hold.includes('title="Worst drop since the league\'s prices settled"'))
})
