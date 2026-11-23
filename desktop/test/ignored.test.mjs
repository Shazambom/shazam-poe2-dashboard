// The one handler for errors the desktop runtime carries on past (desktop/src/ignored.js): it writes the
// first failure of each scope to the log ring (through console.log, which main.js feeds into the ring),
// counts the rest, sends nothing anywhere, and can never throw — not with a hostile error value and not
// when the console itself is broken (a closed stdout at quit).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { ignored, ignoredCounts, unwrittenCount } = require('../src/ignored.js')

function capture(fn) {
  const lines = []
  const orig = console.log
  console.log = (...a) => { lines.push(a.join(' ')) }
  try { fn() } finally { console.log = orig }
  return lines
}

test('the first failure of a scope is logged once; later ones are only counted', () => {
  const lines = capture(() => {
    ignored('test:first', new Error('window closed'))
    ignored('test:first', new Error('window closed again'))
    ignored('test:first', 'a string')
  })
  assert.deepEqual(lines, ['[ignored] test:first: window closed'])
  assert.equal(ignoredCounts().get('test:first'), 3)
})

test('scopes are independent', () => {
  const lines = capture(() => { ignored('test:a', new Error('x')); ignored('test:b', new Error('y')) })
  assert.deepEqual(lines, ['[ignored] test:a: x', '[ignored] test:b: y'])
})

test('never throws: hostile error values, a throwing console, no error at all', () => {
  const hostile = { get message() { throw new Error('getter') }, toString() { throw new Error('toString') } }
  const nullProto = Object.create(null)
  const sym = Symbol('s')
  const lines = capture(() => {
    for (const v of [hostile, nullProto, sym, undefined, null, 0, new Error('')]) assert.doesNotThrow(() => ignored(`test:hostile:${typeof v}:${String(v === sym ? 'sym' : '')}`, v))
  })
  assert.ok(lines.length > 0)
  const orig = console.log
  const before = unwrittenCount()
  console.log = () => { throw new Error('EPIPE') }
  try { assert.doesNotThrow(() => ignored('test:broken-console', new Error('x'))) } finally { console.log = orig }
  assert.equal(ignoredCounts().get('test:broken-console'), 1)
  assert.equal(unwrittenCount(), before + 1, 'the line that could not be written is counted')
})

test('it sends nothing off the machine: it requires no module and calls no network primitive', () => {
  const src = readFileSync(new URL('../src/ignored.js', import.meta.url), 'utf8')
  assert.ok(!/\brequire\s*\(/.test(src), 'requires nothing (so no telemetry sender, http or electron net)')
  assert.ok(!/\b(fetch|WebSocket|XMLHttpRequest)\s*\(/.test(src), 'calls no network primitive')
})
