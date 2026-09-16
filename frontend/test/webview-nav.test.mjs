// Pins the webview-nav guard: only events from the embedded webview drive the workspace.
import test from 'node:test'
import assert from 'node:assert/strict'
const { shouldAcceptNav } = await import('../src/lib/webview.js')

test('shouldAcceptNav matches the embedded webview id and tolerates the legacy bare-url payload', () => {
  assert.equal(shouldAcceptNav({ url: 'x', wcId: 7, phase: 'nav' }, 7), true)
  assert.equal(shouldAcceptNav({ url: 'x', wcId: 9, phase: 'nav' }, 7), false, 'the pop-out window')
  assert.equal(shouldAcceptNav({ url: 'x', wcId: 7 }, null), false, 'no mounted webview yet')
  assert.equal(shouldAcceptNav('https://…', 7), false, 'legacy payloads are ignored')
})
