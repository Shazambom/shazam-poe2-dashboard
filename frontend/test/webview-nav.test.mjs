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

// Repro (review #3): a new tab opens the Instant Buyout home (?q=), the site runs that empty search and
// lands on its slug, and the workspace saved it into the blank row as an "everything" search.
test('a new tab\'s own landing slug is never saved; the next search the user runs is', async () => {
  const { homeCapture } = await import('../src/lib/webview.js')
  let s = homeCapture.start(true)                       // mounted on the Instant Buyout home
  let r = homeCapture.next(s, 'homeSlug')
  assert.equal(r.capture, false, 'the site\'s own search for the home page')
  r = homeCapture.next(r.state, 'mySearch')
  assert.equal(r.capture, true, 'a search the user ran from the tab')
  r = homeCapture.next(homeCapture.start(false), 'savedSlug')
  assert.equal(r.capture, true, 'a saved search or an EE2 query mount captures as before')
  const ws = (await import('node:fs')).readFileSync(new URL('../src/components/WorkspaceView.jsx', import.meta.url), 'utf8')
  assert.ok(ws.includes('homeCapture.next('), 'the workspace asks before saving a slug')
})
