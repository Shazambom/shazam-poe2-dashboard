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

test('the Hold score tooltip describes the score that ships, not the pre-0.3.2 product', () => {
  // since 0.3.2: log(1 + return) + Caution x log(1 + drawdown) — see backend/app/holdscore.py
  assert.ok(!hold.includes('Return × confidence'), 'the old `ret * conf` formula is gone')
  assert.ok(hold.includes('title="Past return weighed against max drawdown — higher ranks first. Caution sets the weight."'))
})
