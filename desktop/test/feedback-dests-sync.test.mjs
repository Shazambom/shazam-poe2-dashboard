// One screen list, three copies that must never drift: frontend/src/lib/dests.js (the UI),
// desktop/src/feedback/dests.js (the sweep), ops/feedback-bot/opener/dests.py (the opener's
// allow-list — drift here is the path-traversal hole).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const { DESTS } = await import('../../frontend/src/lib/dests.js')
const desktop = createRequire(import.meta.url)('../src/feedback/dests.js').DESTS

test('the desktop sweep list equals the frontend list (id, section, sub)', () => {
  assert.deepEqual(desktop, DESTS.map(({ id, section, sub }) => ({ id, section, sub })))
})

test("the opener's SCREEN allow-list equals the frontend ids plus 'current'", () => {
  const py = readFileSync(new URL('../../ops/feedback-bot/opener/dests.py', import.meta.url), 'utf8')
  const m = py.match(/SCREENS\s*=\s*\(([\s\S]*?)\)/)
  assert.ok(m, 'SCREENS tuple not found')
  const ids = [...m[1].matchAll(/"([a-z-]+)"/g)].map(x => x[1])
  assert.deepEqual(ids, ['current', ...DESTS.map(d => d.id)])
})
