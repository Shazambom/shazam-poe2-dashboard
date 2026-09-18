// The renderer's side of "Report a problem": the error ring a report carries, and the short id.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installErrorRing, MAX_ERRORS } from '../src/lib/errorRing.js'

function fakeWindow() {
  const handlers = {}
  return {
    handlers,
    addEventListener: (ev, fn) => { handlers[ev] = fn },
    console: { error: () => {} },
  }
}

test('collects window errors, unhandled rejections and console.error, newest last, capped', () => {
  const w = fakeWindow()
  const ring = installErrorRing(w, w.console)
  w.handlers.error({ message: 'boom', error: new Error('boom') })
  w.handlers.unhandledrejection({ reason: new Error('nope') })
  w.console.error('console said', { a: 1 })
  const lines = w.__arbiterErrors()
  assert.equal(lines.length, 3)
  assert.match(lines[0], /^\d\d:\d\d:\d\d error: Error: boom \| at /)
  assert.match(lines[1], /^\d\d:\d\d:\d\d unhandledrejection: Error: nope/)
  assert.match(lines[2], /console said \{"a":1\}/)
  for (let i = 0; i < MAX_ERRORS + 20; i++) w.console.error('e' + i)
  assert.equal(w.__arbiterErrors().length, MAX_ERRORS)
  assert.equal(ring.lines().length, MAX_ERRORS)
})

test('keeps at most the first 3 stack frames and never throws on odd input', () => {
  const w = fakeWindow()
  installErrorRing(w, w.console)
  const e = new Error('deep'); e.stack = ['Error: deep', ...Array.from({ length: 10 }, (_, i) => `    at f${i} (x.js:${i})`)].join('\n')
  w.handlers.error({ error: e })
  const line = w.__arbiterErrors()[0]
  assert.ok(line.includes('at f2') && !line.includes('at f3'), line)
  assert.doesNotThrow(() => { w.handlers.error(undefined); w.handlers.unhandledrejection({}); w.console.error() })
})

test('the original console.error still runs', () => {
  const w = fakeWindow()
  let called = 0
  w.console.error = () => { called++ }
  installErrorRing(w, w.console)
  w.console.error('x')
  assert.equal(called, 1)
})
