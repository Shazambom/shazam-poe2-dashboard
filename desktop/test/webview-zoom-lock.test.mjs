// QA 2026-11-24: setVisualZoomLevelLimits returns a promise; a guest disposed while it attached rejected
// it outside the try ("Render frame was disposed before WebFrameMain could be accessed", unhandled in main).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')

test('every setVisualZoomLevelLimits call handles its asynchronous rejection', () => {
  const calls = main.split('\n').filter(l => l.includes('setVisualZoomLevelLimits('))
  assert.ok(calls.length > 0)
  for (const line of calls) assert.match(line, /setVisualZoomLevelLimits\(1, 1\)\)\.catch\(/, line)
})
