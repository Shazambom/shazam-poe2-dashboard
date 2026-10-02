// Strat Calculator → Trading (owner, 2026-10-01: "if someone wants to click a tablet link it should take
// them straight to the trade tab and focus the trade window that already exists or create a new one").
// The same search is the same filters whatever the key order or how it was saved (a ?q= row or a
// saved slug); a new one lands in a "From strats" folder; nothing touches the workspace before it has
// loaded (an early write would replace the saved tree).
import test from 'node:test'
import assert from 'node:assert/strict'
const T = await import('../src/lib/stratTrading.js')

const HH_SLUG = 'H4sIAAAAAAAAEzXMQQqAIBBG4avEv_YELlt1h3Ax5USBqegYiHj3KGr7PngNWUhKhm4IUY7goZF5LYkWx-gKnk6GxsRk9-KFExSkxq9ddRjZCdT7ydBz-5W8hcJ2OOH0gOmm36ay9cNvAAAA'
const HH = { status: { option: 'securable' }, name: 'Headhunter', type: 'Heavy Belt', stats: [{ type: 'and', filters: [] }] }
const BREACH = { query: { type: 'Breach Tablet', status: { option: 'securable' } }, sort: { price: 'asc' } }

function fakeStore(tree, loaded = true) {
  const calls = []
  const st = {
    loaded, tree, activeId: null,
    setActive: (id) => { calls.push(['setActive', id]); st.activeId = id },
    addFolder: (p) => { calls.push(['addFolder', p]); const id = 'f_new'; st.tree = [...st.tree, { id, kind: 'folder', name: 'New group', children: [] }]; return id },
    rename: (id, name) => { calls.push(['rename', id, name]); st.tree = st.tree.map(n => (n.id === id ? { ...n, name } : n)) },
    ingest: (i) => { calls.push(['ingest', i]); return { result: 'added', id: 'n_new' } },
  }
  return { get: () => st, calls }
}

test('a saved search with the same filters is selected, however it was saved', async () => {
  const s1 = fakeStore([{ id: 'hh', kind: 'search', type: 'search', slug: HH_SLUG }])
  await T.openInTrading({ query: { query: { stats: HH.stats, type: HH.type, name: HH.name, status: HH.status } }, name: 'x', league: 'L', store: s1.get, go: () => {} })
  assert.deepEqual(s1.calls, [['setActive', 'hh']], 'a slug row, keys in another order: the same search')
  const s2 = fakeStore([{ id: 'f', kind: 'folder', name: 'Mine', children: [{ id: 'q1', kind: 'search', type: 'search', slug: '', q: JSON.stringify(BREACH) }] }])
  await T.openInTrading({ query: BREACH, name: 'x', league: 'L', store: s2.get, go: () => {} })
  assert.deepEqual(s2.calls, [['setActive', 'q1']])
})

test('a new search lands in "From strats" (made once), named after the line; the Trading tab opens', async () => {
  let went = 0
  const s = fakeStore([{ id: 'hist', kind: 'folder', sys: 'ee2-history', name: 'History', children: [{ id: 'h1', kind: 'search', type: 'search', q: JSON.stringify(BREACH) }] }])
  await T.openInTrading({ query: BREACH, name: 'Breach Tablet', league: 'L', store: s.get, go: () => { went++ } })
  assert.equal(went, 1)
  assert.deepEqual(s.calls.map(c => c[0]), ['addFolder', 'rename', 'ingest'], 'History is the automatic log, never a match')
  assert.deepEqual(s.calls[1], ['rename', 'f_new', T.FROM_STRATS])
  assert.deepEqual(s.calls[2][1], { source: 'strat', q: JSON.stringify(BREACH), name: 'Breach Tablet', targetId: 'f_new' })
  const again = fakeStore([{ id: 'fs', kind: 'folder', name: T.FROM_STRATS, children: [] }])
  await T.openInTrading({ query: BREACH, name: 'B', league: 'L', store: again.get, go: () => {} })
  assert.deepEqual(again.calls.map(c => c[0]), ['ingest'], 'the folder is reused')
  assert.equal(again.calls[0][1].targetId, 'fs')
})

test('nothing is written before the workspace has loaded', async () => {
  const s = fakeStore([], false)
  let tick = 0
  const p = T.openInTrading({ query: BREACH, name: 'B', league: 'L', store: s.get, go: () => {}, wait: () => { tick++; if (tick === 3) s.get().loaded = true; return Promise.resolve() } })
  await p
  assert.equal(tick, 3)
  assert.ok(s.calls.length > 0, 'once loaded, it goes ahead')
  const never = fakeStore([], false)
  await T.openInTrading({ query: BREACH, name: 'B', league: 'L', store: never.get, go: () => {}, wait: () => Promise.resolve(), tries: 5 })
  assert.deepEqual(never.calls, [], 'never loaded: nothing written')
})

// ---------------------------------------------------------------- the saved searches, one rule (simplify 2026-10-01)
// "Your searches…" in the trade window and "Open in Trading" walk the same list: the workspace's searches
// with their folder path, never the History folder (the automatic log; the picker used to list it).
const W = await import('../src/lib/workspaceStore.js')

test('savedSearches: every saved search with its folder path; History is not a saved search', () => {
  const tree = [
    { id: 'a', kind: 'search', type: 'search', name: 'Headhunter', slug: HH_SLUG },
    { id: 'h', kind: 'folder', sys: W.HISTORY_SYS, name: 'History', children: [{ id: 'h1', kind: 'search', name: 'Logged', q: '{}' }] },
    { id: 'f', kind: 'folder', name: 'Live', children: [{ id: 'b', kind: 'search', name: 'Breach', q: JSON.stringify(BREACH) },
      { id: 'g', kind: 'folder', name: 'Deep', children: [{ id: 'c', kind: 'search', name: 'Empty', slug: '' }] }] },
  ]
  assert.deepEqual(W.savedSearches(tree).map(x => [x.node.id, x.path]), [['a', []], ['b', ['Live']], ['c', ['Live', 'Deep']]])
})

test('searchOfNode: a ?q= row is its JSON; a slug row is decoded; an empty row is nothing', async () => {
  assert.deepEqual(await W.searchOfNode({ q: JSON.stringify(BREACH) }, 'L'), BREACH)
  assert.deepEqual(await W.searchOfNode({ type: 'search', slug: HH_SLUG }, 'L'), { query: HH })
  assert.equal(await W.searchOfNode({ type: 'search', slug: '' }, 'L'), null)
  assert.equal(await W.searchOfNode({ q: 'not json' }, 'L'), null)
})
