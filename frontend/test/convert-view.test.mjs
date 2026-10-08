// Convert (first-contact audit, 2026-10-08): the grey "50" in the amount box was a placeholder that looked like a
// value, and 1 chaos -> divine said "No conversion route found" when the amount was the problem. The box holds a
// real number (what you hold, else 1), and the backend's min_amount becomes "Minimum N <have>".
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/components/ConvertView.jsx', import.meta.url), 'utf8')
const amountField = src.slice(src.indexOf('convert-field amount'), src.indexOf('convert-field amount') + 400)

test('the amount box holds a real value, never a placeholder that looks like one', () => {
  assert.doesNotMatch(amountField, /placeholder=/)
  assert.match(amountField, /value=\{amount\}/)
  assert.match(src, /const amount = dirty \? typed : String\(held\[have\] \|\| 1\)/, 'derived: what you hold, else 1, until the user types (no seeding effect)')
  assert.match(src, /nameOf\(have\)/, 'names come from the shared currency index')
})

test('too small names the minimum the backend worked out; "no route" is kept for no route', () => {
  assert.match(src, /res\.min_amount/)
  assert.match(src, /Minimum \$\{/)
  assert.match(src, /No conversion route found/)
  assert.doesNotMatch(src, /too small — it buys less than one/)
})
