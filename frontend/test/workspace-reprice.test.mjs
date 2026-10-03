// Trading → Workspace "Reprice in <currency>": the repriced search REPLACES the saved search (owner, 2026-10-02).
// The store stays the tree's only writer. The repriced slug (a run search's slug is its query, gzipped) is saved at
// once and the trade window remounts on it, so nothing waits on the site: switching rows right after the click
// leaves a complete row (QA, 2026-10-03). A row with its own query keeps the two in agreement. Undo restores the
// exact fields, byte for byte.
import test from 'node:test'
import assert from 'node:assert/strict'
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ workspace: { version: 2, tree: [] } }), text: async () => '' })
const { useWorkspace, HISTORY_SYS } = await import('../src/lib/workspaceStore.js')
const st = () => useWorkspace.getState()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const fresh = async (tree) => { st().hydrate({ version: 2, tree, layout: null, openTabs: [] }); await sleep(5) }
const S = (id, name, extra = {}) => ({ id, kind: 'search', name, type: 'search', slug: 's' + id, live: false, ...extra })
const Q = '{"query":{"status":{"option":"securable"},"filters":{"trade_filters":{"disabled":false,"filters":{"price":{"option":"vaal"}}}}},"sort":{"price":"asc"}}'
const NEW = { slug: 'H4sIREPRICED', q: Q }

test('a saved slug search: the repriced slug is saved at once and the window remounts on it', async () => {
  await fresh([S('a', 'Wombgift'), S('b', 'Other')])
  const tick = st().rerunTick
  const prev = st().repriceSearch('a', NEW)
  assert.deepEqual(prev, { type: 'search', slug: 'sa', live: false })
  assert.deepEqual(st().nodeById('a'), S('a', 'Wombgift', { slug: 'H4sIREPRICED' }), 'complete at once: no query, no pending state')
  assert.equal(st().activeId, 'a'); assert.equal(st().rerunTick, tick + 1)
})

test('switching to another row right after the click leaves the repriced row complete', async () => {
  await fresh([S('a', 'Wombgift'), S('b', 'Other')])
  st().repriceSearch('a', NEW)
  st().setActive('b')
  assert.deepEqual(st().nodeById('a'), S('a', 'Wombgift', { slug: 'H4sIREPRICED' }))
})

test('a row with its own query (from an item or a strat) gets the repriced query too, so the two agree', async () => {
  await fresh([S('a', 'From item', { q: '{"query":{}}' })])
  const prev = st().repriceSearch('a', NEW)
  assert.deepEqual(prev, { type: 'search', slug: 'sa', live: false, q: '{"query":{}}' })
  assert.equal(st().nodeById('a').q, Q); assert.equal(st().nodeById('a').slug, 'H4sIREPRICED')
})

test('undo restores the exact previous row, byte for byte, and remounts', async () => {
  for (const before of [S('a', 'A'), S('a', 'A', { q: '{"query":{}}' }), S('a', 'A', { live: true })]) {
    await fresh([before])
    const prev = st().repriceSearch('a', NEW)
    st().setField('a', { slug: 'H4sISITE', type: 'search', live: false })   // the site's own capture after the remount
    const tick = st().rerunTick
    st().restoreSearch('a', prev)
    assert.equal(JSON.stringify(st().nodeById('a')), JSON.stringify(before), 'byte-identical, key order included')
    assert.equal(st().rerunTick, tick + 1)
  }
})

test('refused: History rows, folders, unknown ids, no slug, and a workspace that failed to load', async () => {
  await fresh([{ id: 'h', kind: 'folder', name: 'ExiledExchange2 History', sys: HISTORY_SYS, children: [S('x', 'X', { q: '{"query":{}}' })] }, { id: 'f', kind: 'folder', name: 'F', children: [] }])
  assert.equal(st().repriceSearch('x', NEW), null)
  assert.equal(st().repriceSearch('f', NEW), null)
  assert.equal(st().repriceSearch('nope', NEW), null)
  assert.equal(st().nodeById('x').q, '{"query":{}}')
  await fresh([S('a', 'A')])
  assert.equal(st().repriceSearch('a', { slug: '', q: Q }), null)
  useWorkspace.setState({ loadError: 'boom' })   // the tree is not the user's: nothing may be written
  assert.equal(st().repriceSearch('a', NEW), null)
  assert.equal(st().nodeById('a').slug, 'sa')
  useWorkspace.setState({ loadError: null })
})

test('an armed row stays armed and is live-searchable on the new slug at once', async () => {
  await fresh([S('a', 'A', { armed: true })])
  st().repriceSearch('a', NEW)
  assert.equal(st().nodeById('a').armed, true); assert.equal(st().nodeById('a').slug, 'H4sIREPRICED')
})

// Review (2026-10-03): Undo pressed after moving to another row must not remount that row's trade window (it lost the
// search being edited there). The window reloads only when the restored row is the one showing.
test('undo after switching rows restores the row without remounting the window', async () => {
  await fresh([S('a', 'A'), S('b', 'B')])
  const prev = st().repriceSearch('a', NEW)
  st().setActive('b')
  const tick = st().rerunTick
  st().restoreSearch('a', prev)
  assert.equal(st().nodeById('a').slug, 'sa')
  assert.equal(st().rerunTick, tick, 'the open row (B) keeps its window')
})
