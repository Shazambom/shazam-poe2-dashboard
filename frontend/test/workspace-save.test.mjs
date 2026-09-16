// Pins saveState / flush / undo-able remove on the workspace store.
// Run:  node --test frontend/test/
import test from 'node:test'
import assert from 'node:assert/strict'

const puts = []
let putMode = 'ok'
globalThis.fetch = async (url, opts = {}) => {
  if (!String(url).includes('/api/trading/workspace')) return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
  if ((opts.method || 'GET') === 'GET') return { ok: true, status: 200, json: async () => ({ workspace: { version: 2, tree: [], layout: null, openTabs: [] } }), text: async () => '' }
  puts.push(JSON.parse(opts.body).workspace)
  if (putMode === 'fail') return { ok: false, status: 413, text: async () => JSON.stringify({ detail: '413 too big' }), json: async () => ({}) }
  return { ok: true, status: 200, json: async () => ({ workspace: puts.at(-1) }), text: async () => '' }
}
const { useWorkspace, loadWorkspace } = await import('../src/lib/workspaceStore.js')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const st = () => useWorkspace.getState()

test('saveState goes idle → dirty → saving → idle; flush() sends exactly one payload equal to state', async () => {
  await loadWorkspace(); await sleep(5)
  assert.equal(st().saveState, 'idle')
  const fid = st().addFolder(null)
  assert.equal(st().saveState, 'dirty')
  const n = puts.length
  await st().flush()
  assert.equal(puts.length, n + 1, 'flush PUTs once, immediately')
  assert.deepEqual(puts.at(-1).tree, st().tree)
  assert.equal(st().saveState, 'idle')
  await sleep(900)
  assert.equal(puts.length, n + 1, 'the cancelled debounce does not fire a second PUT')
  st().remove(fid)
})

test('a rejected PUT leaves saveState = error and keeps the tree', async () => {
  putMode = 'fail'
  st().addFolder(null)
  await st().flush()
  assert.equal(st().saveState, 'error')
  assert.equal(st().tree.length, 1)
  putMode = 'ok'
  await st().flush()
  assert.equal(st().saveState, 'idle')
})

test('remove() returns the exact subtree + position and restore() puts it back at that index', async () => {
  st().hydrate({ version: 2, tree: [
    { id: 'a', kind: 'search', name: 'A', slug: 'x' },
    { id: 'f', kind: 'folder', name: 'F', children: [{ id: 'b', kind: 'search', name: 'B', slug: 'y' }, { id: 'c', kind: 'search', name: 'C', slug: 'z' }] },
  ], layout: null, openTabs: [], activeId: 'c' })
  await sleep(5)
  const r = st().remove('c')
  assert.deepEqual(r, { node: { id: 'c', kind: 'search', name: 'C', slug: 'z' }, parentId: 'f', index: 1 })
  assert.equal(st().activeId, null)
  st().restore(r)
  assert.deepEqual(st().nodeById('f').children.map(n => n.id), ['b', 'c'])
  const r2 = st().remove('f')
  assert.equal(r2.parentId, null); assert.equal(r2.index, 1); assert.equal(r2.node.children.length, 2)
  st().restore(r2)
  assert.deepEqual(st().tree.map(n => n.id), ['a', 'f'])
  assert.equal(st().remove('nope'), null)
})

test('done and layout.railWidth round-trip through the persist payload', async () => {
  st().hydrate({ version: 2, tree: [{ id: 'a', kind: 'search', name: 'A', slug: 'x', done: false }], layout: null, openTabs: [] })
  await sleep(5)
  st().setField('a', { done: true })
  st().setLayout({ railWidth: 333 })
  await st().flush()
  const p = puts.at(-1)
  assert.equal(p.tree[0].done, true)
  assert.equal(p.layout.railWidth, 333)
  st().hydrate(p); await sleep(5)
  assert.equal(st().layout.railWidth, 333)
})
