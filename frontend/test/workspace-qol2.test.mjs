// Batch 5 (QOL tier 2) store logic: rerunFromItem, sortChildren, removeMany/restoreMany, armFolder/disarmFolder,
// exportWorkspace/importWorkspace (history excluded; merge keeps ids unique; replace keeps the history folder).
import test from 'node:test'
import assert from 'node:assert/strict'
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ workspace: { version: 2, tree: [] } }), text: async () => '' })
const { useWorkspace, HISTORY_SYS, exportWorkspace } = await import('../src/lib/workspaceStore.js')
const st = () => useWorkspace.getState()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const fresh = async (tree) => { st().hydrate({ version: 2, tree, layout: null, openTabs: [] }); await sleep(5) }
const S = (id, name, extra = {}) => ({ id, kind: 'search', name, slug: 's' + id, ...extra })

test('rerunFromItem clears the slug of a q+slug row and opens it; refuses rows without q', async () => {
  await fresh([S('a', 'A', { q: '{"query":{}}' }), S('b', 'B')])
  assert.equal(st().rerunFromItem('a'), true)
  assert.equal(st().nodeById('a').slug, ''); assert.equal(st().activeId, 'a')
  assert.equal(st().rerunFromItem('b'), false); assert.equal(st().nodeById('b').slug, 'sb')
})

test('sortChildren orders a folder (folders first, then A–Z, case-insensitive); root when null', async () => {
  await fresh([{ id: 'f', kind: 'folder', name: 'F', children: [S('2', 'beta'), { id: 'g', kind: 'folder', name: 'zeta', children: [] }, S('1', 'Alpha')] }, S('r', 'root b'), S('q', 'Root a')])
  st().sortChildren('f')
  assert.deepEqual(st().nodeById('f').children.map(c => c.name), ['zeta', 'Alpha', 'beta'])
  st().sortChildren(null)
  assert.deepEqual(st().tree.map(c => c.name), ['F', 'Root a', 'root b'])
})

test('removeMany removes several nodes with one undo slot; restoreMany puts each back at its index', async () => {
  await fresh([S('a', 'A'), { id: 'f', kind: 'folder', name: 'F', children: [S('b', 'B'), S('c', 'C'), S('d', 'D')] }, S('e', 'E')])
  const undo = st().removeMany(['c', 'a', 'nope'])
  assert.equal(undo.length, 2); assert.deepEqual(st().tree.map(n => n.id), ['f', 'e']); assert.deepEqual(st().nodeById('f').children.map(n => n.id), ['b', 'd'])
  st().restoreMany(undo)
  assert.deepEqual(st().tree.map(n => n.id), ['a', 'f', 'e']); assert.deepEqual(st().nodeById('f').children.map(n => n.id), ['b', 'c', 'd'])
})

test('armFolder arms search children with a slug up to the budget; disarmFolder stops them all', async () => {
  await fresh([{ id: 'f', kind: 'folder', name: 'F', children: [S('a', 'A'), S('b', 'B', { slug: '' }), S('c', 'C'), S('d', 'D', { armed: true }), { id: 'g', kind: 'folder', name: 'G', children: [S('e', 'E')] }] }])
  const r = st().armFolder('f', 2)
  assert.deepEqual(r, { armed: 2, skipped: 2 })   // b has no slug; e is over budget
  assert.deepEqual(['a', 'c', 'e', 'd', 'b'].map(id => !!st().nodeById(id).armed), [true, true, false, true, false])
  assert.equal(st().disarmFolder('f'), 3)
  assert.ok(['a', 'c', 'd', 'e'].every(id => !st().nodeById(id).armed))
})

test('exportWorkspace excludes the history folder; import merge keeps ids unique, replace keeps history', async () => {
  await fresh([{ id: 'h', kind: 'folder', sys: HISTORY_SYS, name: 'H', children: [S('x', 'X', { q: '{}' })] }, S('a', 'A'), { id: 'f', kind: 'folder', name: 'F', children: [S('b', 'B')] }])
  const doc = exportWorkspace(st().tree)
  assert.equal(doc.version, 2); assert.deepEqual(doc.tree.map(n => n.id), ['a', 'f']); assert.ok(!JSON.stringify(doc).includes('"sys"'))
  const r1 = st().importWorkspace(doc, 'merge')
  assert.equal(r1.added, 3)   // a, f, b
  const ids = []; const walk = (ns) => ns.forEach(n => { ids.push(n.id); if (n.children) walk(n.children) }); walk(st().tree)
  assert.equal(new Set(ids).size, ids.length, 'colliding ids were re-minted')
  assert.equal(st().tree.length, 5)
  const r2 = st().importWorkspace(doc, 'replace')
  assert.equal(r2.added, 3)
  assert.deepEqual(st().tree.map(n => n.name), ['H', 'A', 'F']); assert.equal(st().nodeById('h').children.length, 1, 'history survives a replace')
  assert.equal(st().importWorkspace({ version: 1 }, 'merge').error, 'not a workspace export')
})

test('autoName only touches search rows still auto-named; rename never changes the history folder', async () => {
  await fresh([{ id: 'h', kind: 'folder', sys: HISTORY_SYS, name: 'ExiledExchange2 History', children: [] }, { id: 'f', kind: 'folder', name: 'F', children: [] }, S('a', 'A', { auto: true }), S('b', 'B', { auto: false })])
  st().autoName('h', 'Mid'); st().autoName('f', 'Mid'); st().autoName('b', 'Mid'); st().autoName('a', 'Scraped')
  assert.equal(st().nodeById('h').name, 'ExiledExchange2 History'); assert.equal(st().nodeById('f').name, 'F'); assert.equal(st().nodeById('b').name, 'B'); assert.equal(st().nodeById('a').name, 'Scraped')
  st().rename('h', 'Something else')
  assert.equal(st().nodeById('h').name, 'ExiledExchange2 History', 'the system folder keeps its name')
})
