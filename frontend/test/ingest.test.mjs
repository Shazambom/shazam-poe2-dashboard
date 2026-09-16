// Pins the store's ingest() for the two URL rungs, ensureFolder, prependSearch and sanitize().
import test from 'node:test'
import assert from 'node:assert/strict'
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ workspace: { version: 2, tree: [] } }), text: async () => '' })
const { useWorkspace, HISTORY_SYS, HISTORY_NAME, HISTORY_CAP, MAX_Q_BYTES, sanitize } = await import('../src/lib/workspaceStore.js')
const st = () => useWorkspace.getState()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const Q = JSON.stringify({ query: { name: 'Headhunter', type: 'Heavy Belt' }, sort: { price: 'asc' } })

test('ensureFolder finds the sys folder anywhere (renamed/moved) and creates it at root index 0 otherwise', async () => {
  st().hydrate({ version: 2, tree: [{ id: 'g', kind: 'folder', name: 'G', children: [{ id: 'h', kind: 'folder', sys: HISTORY_SYS, name: 'My history', children: [] }] }], layout: null, openTabs: [] })
  await sleep(5)
  assert.equal(st().ensureFolder(HISTORY_SYS, HISTORY_NAME), 'h')
  st().hydrate({ version: 2, tree: [{ id: 'a', kind: 'search', name: 'A', slug: 'x' }], layout: null, openTabs: [] }); await sleep(5)
  const id = st().ensureFolder(HISTORY_SYS, HISTORY_NAME)
  assert.equal(st().tree[0].id, id); assert.equal(st().tree[0].name, HISTORY_NAME); assert.equal(st().tree[0].sys, HISTORY_SYS)
})

test('ingest: url rung adds to the target folder, query-url rung stores q, dedupe selects instead of duplicating', async () => {
  st().hydrate({ version: 2, tree: [{ id: 'f', kind: 'folder', name: 'F', children: [] }], layout: null, openTabs: [] }); await sleep(5)
  const r1 = st().ingest({ source: 'clipboard', slug: 'abcdef123', type: 'search', live: false, name: 'Search abcdef', folder: null, targetId: 'f' })
  assert.equal(r1.result, 'added')
  const n1 = st().nodeById('f').children[0]
  assert.equal(n1.slug, 'abcdef123'); assert.equal(n1.origin, 'clipboard'); assert.ok(n1.ts > 0); assert.equal(n1.auto, true)
  assert.equal(st().activeId, r1.id, 'a clipboard add opens the search')
  const r2 = st().ingest({ source: 'clipboard', slug: 'abcdef123', type: 'search', live: false, name: 'x', folder: null, targetId: null })
  assert.equal(r2.result, 'dup'); assert.equal(r2.id, r1.id); assert.equal(st().nodeById('f').children.length, 1)
  const r3 = st().ingest({ source: 'clipboard', q: Q, name: 'Headhunter Heavy Belt', folder: null, targetId: null })
  assert.equal(r3.result, 'added')
  const n3 = st().nodeById(r3.id)
  assert.equal(n3.q, Q); assert.equal(n3.slug, ''); assert.equal(n3.auto, false, 'ingested rows keep their parsed name')
  assert.equal(st().tree[0].id, 'f'); assert.equal(st().tree[1].id, r3.id, 'no target → root, appended')
  const r4 = st().ingest({ source: 'clipboard', q: Q, name: 'again', folder: null, targetId: 'f' })
  assert.equal(r4.result, 'dup'); assert.equal(r4.id, r3.id)
})

test('ingest into the history folder prepends (newest first) and never targets it from the clipboard', async () => {
  st().hydrate({ version: 2, tree: [], layout: null, openTabs: [] }); await sleep(5)
  const a = st().ingest({ source: 'ee2', origin: 'ee2', q: Q, name: 'A', folder: HISTORY_SYS })
  const b = st().ingest({ source: 'ee2', origin: 'ee2', q: Q.replace('Headhunter', 'Mageblood'), name: 'B', folder: HISTORY_SYS })
  const h = st().tree[0]
  assert.equal(h.sys, HISTORY_SYS); assert.deepEqual(h.children.map(c => c.id), [b.id, a.id])
  assert.equal(st().activeId, null, 'the item stream never steals the pane')
  const c = st().ingest({ source: 'clipboard', slug: 'zzz', type: 'search', live: false, name: 'C', folder: null, targetId: h.id })
  assert.ok(!st().nodeById(h.id).children.some(x => x.id === c.id), 'clipboard adds never land inside the history folder')
})

test('ingest is refused after a load failure', async () => {
  st().failLoad('boom')
  assert.deepEqual(st().ingest({ source: 'clipboard', slug: 'q', name: 'x' }), { result: 'dropped', reason: 'load-error' })
  st().hydrate({ version: 2, tree: [], layout: null, openTabs: [] }); await sleep(5)
})

test('sanitize drops oversize q and trims the history folder to the cap, leaving everything else byte-identical', () => {
  const kids = Array.from({ length: HISTORY_CAP + 5 }, (_, i) => ({ id: 'n' + i, kind: 'search', name: 'N' + i, q: '{}', ts: i }))
  const tree = [{ id: 'h', kind: 'folder', sys: HISTORY_SYS, name: 'H', children: kids },
    { id: 'big', kind: 'search', name: 'Big', q: 'x'.repeat(MAX_Q_BYTES + 1), slug: '' },
    { id: 'ok', kind: 'search', name: 'Ok', q: '{}', slug: '', extra: { keep: true } }]
  const out = sanitize(tree)
  assert.equal(out[0].children.length, HISTORY_CAP)
  assert.deepEqual(out[0].children.map(c => c.id), kids.slice(0, HISTORY_CAP).map(c => c.id), 'keeps the first (newest) rows')
  assert.equal(out[1].q, null); assert.equal(out[1].degraded, true)
  assert.deepEqual(out[2], tree[2])
})

test('nameFromQuery prefers "<name> <type>", then type, then a fallback', async () => {
  const { nameFromQuery } = await import('../src/lib/clipboardAdd.js')
  assert.equal(nameFromQuery(Q), 'Headhunter Heavy Belt')
  assert.equal(nameFromQuery(JSON.stringify({ query: { type: 'Heavy Belt' } })), 'Heavy Belt')
  assert.equal(nameFromQuery(JSON.stringify({ query: { type: { option: 'Sapphire Ring' } } })), 'Sapphire Ring')
  assert.equal(nameFromQuery(JSON.stringify({ query: { filters: { type_filters: { filters: { category: { option: 'accessory.ring' } } } } } })), 'Ring query')
  assert.equal(nameFromQuery('{}'), 'Query search')
})
