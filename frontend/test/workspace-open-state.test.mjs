// Folder open state on mount: remembered per folder, except the EE2 History folder, which always
// starts collapsed (owner ask 2026-09-18: it was open on every launch).
import test from 'node:test'
import assert from 'node:assert/strict'
import { initialOpenState, HISTORY_SYS } from '../src/lib/workspaceStore.js'

test('history folder starts collapsed even when stored open; other folders keep their state', () => {
  const tree = [
    { id: 'h', kind: 'folder', sys: HISTORY_SYS, open: true, children: [{ id: 's1', kind: 'search' }] },
    { id: 'a', kind: 'folder', open: true, children: [{ id: 'b', kind: 'folder', open: false, children: [] }] },
    { id: 'c', kind: 'folder', children: [] },   // no flag = open (the newFolder default)
    { id: 's2', kind: 'search' },
  ]
  assert.deepEqual(initialOpenState(tree), { h: false, a: true, b: false, c: true })
})
test('empty tree → no entries', () => { assert.deepEqual(initialOpenState([]), {}) })
