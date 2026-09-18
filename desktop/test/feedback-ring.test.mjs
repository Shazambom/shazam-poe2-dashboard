// Pins desktop/src/feedback/ring.js — the bounded log rings a report carries.
import test from 'node:test'
import assert from 'node:assert/strict'

const { makeRing } = await import('../src/feedback/ring.js')

test('keeps only the last N lines, each stamped HH:MM:SS', () => {
  const r = makeRing(3, () => new Date(Date.UTC(2026, 8, 18, 13, 4, 5)))
  for (let i = 1; i <= 5; i++) r.push(`line ${i}`)
  assert.deepEqual(r.lines(), ['13:04:05 line 3', '13:04:05 line 4', '13:04:05 line 5'])
  r.clear()
  assert.deepEqual(r.lines(), [])
})

test('clamps a line to 500 chars and never throws on non-strings', () => {
  const r = makeRing(10)
  r.push('x'.repeat(2000))
  assert.equal(r.lines()[0].length, 9 + 500)
  assert.doesNotThrow(() => { r.push(undefined); r.push(null); r.push({ a: 1 }); r.push(42); r.push(new Error('e')) })
  assert.equal(r.lines().length, 6)
  assert.ok(r.lines()[3].endsWith('{"a":1}'))
  assert.ok(r.lines()[5].includes('e'))
})

test('lines() returns a copy', () => {
  const r = makeRing(2)
  r.push('a')
  r.lines().push('zzz')
  assert.equal(r.lines().length, 1)
})
