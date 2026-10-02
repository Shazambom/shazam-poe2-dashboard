// One Undo toast (simplify pass, 2026-10-01): the Workspace's delete toasts and the Strat Calculator's
// share it — same markup, same 10 s, Undo runs the restore and dismisses the toast.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const { bus, undoToast, UNDO_TTL } = await import('../src/lib/api.js')

test('undoToast emits a keyed toast whose Undo restores and dismisses it', () => {
  const seen = []
  const off = bus.on(t => seen.push(t))
  let undone = 0
  undoToast('sc-undo', 'Deleted “Ritual”', () => undone++)
  const t = seen[0]
  assert.equal(t.id, 'sc-undo')
  assert.equal(t.ttl, UNDO_TTL)
  assert.equal(UNDO_TTL, 10_000)
  const [text, button] = t.node.props.children
  assert.equal(t.node.props.className, 'ws-undo')
  assert.equal(text.props.children, 'Deleted “Ritual”')
  button.props.onClick()
  assert.equal(undone, 1)
  assert.deepEqual(seen.at(-1), { id: 'sc-undo', dismiss: true })
  off()
})

test('every Undo toast in the app goes through it', () => {
  for (const f of ['WorkspaceView.jsx', 'StratCalcView.jsx']) {
    const src = readFileSync(new URL(`../src/components/${f}`, import.meta.url), 'utf8')
    assert.ok(src.includes('undoToast('), f)
    assert.ok(!src.includes('className="ws-undo"'), `${f}: no hand-made copy of the toast`)
  }
})
