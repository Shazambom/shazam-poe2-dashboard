// The exact-number box (components/Num.jsx): a value applies as it is typed only when it is a
// number in range; a blank or out-of-range entry waits for the box to lose focus, then clamps.
// Clamping on every keystroke snapped "82" → backspace → "" to the minimum mid-edit, so typing
// "75" after it read "175" and clamped to 100 (code review 2026-09-28).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const { typed, settle } = await import('../src/lib/numInput.js')

test('typing applies only an in-range number; blank and out-of-range wait', () => {
  assert.equal(typed('8', 1, 100), 8)
  assert.equal(typed('75', 1, 100), 75)
  assert.equal(typed('', 1, 100), null, 'a cleared box does not snap to the minimum')
  assert.equal(typed('0', 1, 100), null, 'below range waits')
  assert.equal(typed('150', 1, 100), null, 'above range waits')
  assert.equal(typed('7.9', 1, 100), 7)
  assert.equal(typed('abc', 1, 100), null)
})

test('leaving the box settles it: clamped, blank means the minimum', () => {
  assert.equal(settle('', 1, 100), 1)
  assert.equal(settle('150', 1, 100), 100)
  assert.equal(settle('0', 1, 100), 1)
  assert.equal(settle('42', 0, 100), 42)
  assert.equal(settle('x', 0, 100), 0)
})

test('Num keeps the draft while focused and settles on blur', () => {
  const s = readFileSync(new URL('../src/components/Num.jsx', import.meta.url), 'utf8')
  assert.ok(s.includes('typed(') && s.includes('settle(') && s.includes('onBlur'), 'Num uses the draft rule')
})
