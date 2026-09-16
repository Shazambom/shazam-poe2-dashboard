// Pins lib/tree.js — the ONE set of workspace tree walkers (store, views and liveWiring share them).
// Run:  node --test frontend/test/
import test from 'node:test'
import assert from 'node:assert/strict'
const { find, findWhere, locate, flatten, mapNode, removeNode, insertAt } = await import('../src/lib/tree.js')

const T = [
  { id: 'a', kind: 'search', name: 'A', slug: 's1' },
  { id: 'f', kind: 'folder', name: 'F', children: [
    { id: 'b', kind: 'search', name: 'B', slug: 's2' },
    { id: 'g', kind: 'folder', name: 'G', children: [{ id: 'c', kind: 'search', name: 'C', slug: 's2' }] },
  ] },
]

test('find / findWhere / locate', () => {
  assert.equal(find(T, 'c').name, 'C')
  assert.equal(find(T, 'zz'), null)
  assert.equal(findWhere(T, n => n.kind === 'search' && n.slug === 's2').id, 'b', 'first match in document order')
  assert.deepEqual(locate(T, 'g'), { node: T[1].children[1], parentId: 'f', index: 1 })
  assert.deepEqual(locate(T, 'a'), { node: T[0], parentId: null, index: 0 })
  assert.equal(locate(T, 'zz'), null)
})

test('flatten walks depth-first, optionally filtered', () => {
  assert.deepEqual(flatten(T).map(n => n.id), ['a', 'f', 'b', 'g', 'c'])
  assert.deepEqual(flatten(T, n => n.kind === 'search').map(n => n.id), ['a', 'b', 'c'])
  assert.deepEqual(flatten(null), [])
})

test('mapNode / removeNode / insertAt are pure', () => {
  const t2 = mapNode(T, 'c', n => ({ ...n, name: 'C2' }))
  assert.equal(find(t2, 'c').name, 'C2'); assert.equal(find(T, 'c').name, 'C')
  const t3 = removeNode(T, 'g')
  assert.equal(find(t3, 'c'), null); assert.equal(find(T, 'c').name, 'C')
  const t4 = insertAt(t3, { id: 'n', kind: 'search', name: 'N' }, 'f', 0)
  assert.deepEqual(find(t4, 'f').children.map(n => n.id), ['n', 'b'])
  const t5 = insertAt(T, { id: 'r', kind: 'folder', children: [] }, null, 1)
  assert.deepEqual(t5.map(n => n.id), ['a', 'r', 'f'])
  assert.equal(find(insertAt(T, { id: 'x' }, 'nope', 0), 'x'), null, 'missing parent inserts nothing')
})
