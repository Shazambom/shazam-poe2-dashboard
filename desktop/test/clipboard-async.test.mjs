// Electron 44 rearchitected `clipboard`: `readText()` returns a Promise (docs/breaking-changes.md, 44.0).
// Every clipboard read awaits it, so it works on the old synchronous API and the new one alike. The EE2
// watcher's reads were synchronous; `String(promise)` would have hashed "[object Promise]" and never seen
// an item (owner approved touching the watcher for this, 2026-09-30).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
const W = await import('../src/integrations/exiled-exchange/clipboard-watcher.js')

const ITEM = (name) => `Item Class: Stackable Currency\nRarity: Currency\n${name}\n--------\nStack Size: 1/20`
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// A clipboard shaped like Electron 44's: readText resolves after `lag` ms; counts overlapping reads.
function asyncClip(initial, lag = 2) {
  const c = { text: initial, inFlight: 0, maxInFlight: 0, reads: 0 }
  c.readText = () => { c.reads++; c.inFlight++; c.maxInFlight = Math.max(c.maxInFlight, c.inFlight)
    return new Promise(r => setTimeout(() => { c.inFlight--; r(c.text) }, lag)) }
  return c
}

test('the watcher ignores what was on the clipboard at start, then reports a new item once', async () => {
  const clip = asyncClip(ITEM('Old Orb'))
  W._useClipboard(clip)
  const seen = []
  const w = new W.ClipboardWatcher({ intervalMs: 60, onItem: (i) => seen.push(i.name) })
  w.start()
  await sleep(150)
  clip.text = ITEM('Divine Orb')
  await sleep(200)
  w.stop()
  assert.deepEqual(seen, ['Divine Orb'])
})

test('a slow clipboard never gets overlapping reads from the watcher', async () => {
  const clip = asyncClip('', 150)
  W._useClipboard(clip)
  const w = new W.ClipboardWatcher({ intervalMs: 60, onItem: () => {} })
  w.start()
  await sleep(500)
  w.stop()
  assert.equal(clip.maxInFlight, 1)
})

test('the EE2 burst catches an item that appears mid-burst, and skips the one already there', async () => {
  const clip = asyncClip(ITEM('Old Orb'))
  W._useClipboard(clip)
  const seen = []
  W.captureItemBurst({ intervalMs: 15, durationMs: 250, onItem: (i) => seen.push(i.name) })
  await sleep(40)
  clip.text = ITEM('Exalted Orb')          // EE2 copies the hovered item …
  await sleep(60)
  clip.text = ITEM('Old Orb')              // … and restores the previous clipboard ~120 ms later
  await sleep(250)
  assert.deepEqual(seen, ['Exalted Orb'])
  assert.equal(clip.maxInFlight, 1)
})

test('no clipboard read in desktop/src is left un-awaited', () => {
  const root = new URL('../src/', import.meta.url).pathname
  const files = []
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (f !== 'vendor') walk(p) } else if (p.endsWith('.js')) files.push(p) } }
  walk(root)
  const bad = []
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
      if (!l.trim().startsWith('//') && /\.readText\(\)/.test(l) && !/await [\w().]*\.readText\(\)/.test(l) && !/readText: \(\) =>|c\.readText = /.test(l)) bad.push(`${f.replace(root, '')}:${i + 1}`)
    })
  }
  assert.deepEqual(bad, [])
})
