// QA pass 2 (2026-10-05): a hand edit followed within ~300 ms by an Arbitrage preset click was lost and left no preset
// highlighted — the edit's debounced save (or the save a panel makes as it redraws) landed after the preset's. Settings
// saves now go out one at a time in the order made, and a preset click sends pending edits first, so the preset wins
// its own values and an edit to anything else (Start from, Show at most) survives.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const { useStatus } = await import('../src/lib/statusStore.js')
const { api } = await import('../src/lib/api.js')

const deferred = () => { let res; const p = new Promise(r => { res = r }); return { p, res } }

test('settings saves go out one at a time, in the order they were made', async () => {
  const first = deferred(), second = deferred()
  const sent = []
  api.putSettings = (patch) => { sent.push(patch.n); return patch.n === 1 ? first.p : second.p }
  const a = useStatus.getState().saveSettings({ n: 1 })
  const b = useStatus.getState().saveSettings({ n: 2 })
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(sent, [1], 'the second waits for the first')
  first.res({ v: 1 })
  await a
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(sent, [1, 2])
  second.res({ v: 2 })
  await b
  assert.deepEqual(useStatus.getState().settings, { v: 2 }, 'the store holds the last answer')
})

test('a failed save does not block the next one', async () => {
  api.putSettings = (patch) => (patch.n === 1 ? Promise.reject(new Error('boom')) : Promise.resolve({ v: patch.n }))
  await assert.rejects(useStatus.getState().saveSettings({ n: 1 }))
  assert.deepEqual(await useStatus.getState().saveSettings({ n: 2 }), { v: 2 })
})

const src = (f) => readFileSync(new URL(`../src/components/${f}.jsx`, import.meta.url), 'utf8')

test('a preset click sends pending edits before the preset', () => {
  const rv = src('RoutesView')
  const pick = rv.slice(rv.indexOf('const pick = '), rv.indexOf('const pick = ') + 700)
  const order = ['flushSync(() => setRev(', 'await flush()', 'saveSettings(p.values)'].map(s => pick.indexOf(s))
  assert.ok(order.every(i => i >= 0), `pick: ${pick}`)
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'sliders flushed, then the filter boxes, then the preset')
})

test('the gold slider saves through the shared autosave, which sends a pending value when it goes away', () => {
  const g = src('GoldValueSlider')
  assert.match(g, /useAutosave\(/, 'one debounce + unmount-flush implementation (lib/hooks.js), not a second copy')
  assert.doesNotMatch(g, /pendingRef|clearTimeout/)
  assert.match(g, /arm\(\)/, 'armed on mount, so a drag before the settings load still saves')
  const hooks = readFileSync(new URL('../src/lib/hooks.js', import.meta.url), 'utf8')
  assert.match(hooks, /useEffect\(\(\) => \(\) => \{ clearTimeout\(timer\.current\); timer\.current = null; if \(pending\.current\) saver\(pending\.current\.payload\)/)
})
