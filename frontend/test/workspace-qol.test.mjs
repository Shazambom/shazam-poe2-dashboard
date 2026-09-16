// Pins the Batch 0 QOL logic: duplicate(), the tree filter matcher, palette items, live-label timeout.
// Run:  node --test frontend/test/
import test from 'node:test'
import assert from 'node:assert/strict'

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ workspace: { version: 2, tree: [] } }), text: async () => '' })
const { useWorkspace } = await import('../src/lib/workspaceStore.js')
const { matchesFilter } = await import('../src/lib/tree.js')
const { buildPaletteItems } = await import('../src/lib/palette.js')
const { liveLabel, LIVE_CONNECT_TIMEOUT } = await import('../src/lib/pingStore.js')
const st = () => useWorkspace.getState()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

test('duplicate() inserts a fresh-id copy right after the source, never armed', async () => {
  st().hydrate({ version: 2, tree: [{ id: 'f', kind: 'folder', name: 'F', children: [
    { id: 'a', kind: 'search', name: 'A', slug: 'x', armed: true, done: true, auto: true },
    { id: 'b', kind: 'search', name: 'B', slug: 'y' }] }], layout: null, openTabs: [] })
  await sleep(5)
  const id = st().duplicate('a')
  const kids = st().nodeById('f').children
  assert.deepEqual(kids.map(k => k.id), ['a', id, 'b'])
  const copy = kids[1]
  assert.notEqual(copy.id, 'a')
  assert.equal(copy.name, 'A copy'); assert.equal(copy.slug, 'x')
  assert.equal(copy.armed, false, 'a copy never starts live'); assert.equal(copy.done, false); assert.equal(copy.auto, false)
  assert.equal(st().duplicate('nope'), null)
})

test('matchesFilter is case-insensitive over name and item.name', () => {
  assert.ok(matchesFilter({ name: 'Headhunter Heavy Belt' }, 'head'))
  assert.ok(matchesFilter({ name: 'x', item: { name: 'Mageblood' } }, 'BLOOD'))
  assert.ok(!matchesFilter({ name: 'x' }, 'zzz'))
  assert.ok(matchesFilter({ name: 'x' }, ''), 'empty term matches everything')
})

test('buildPaletteItems lists commands and one Open-search row per node with its folder path', () => {
  const tree = [{ id: 'f', kind: 'folder', name: 'Belts', children: [{ id: 'a', kind: 'search', name: 'HH' }] }, { id: 'b', kind: 'search', name: 'MB' }]
  const cmds = [{ id: 'new-search', label: 'New search', run: () => {} }]
  const items = buildPaletteItems({ tabs: ['Board'], subDests: [], rows: [], leagues: [], commands: cmds, tree, q: '' })
  const kinds = items.map(i => i.kind)
  assert.ok(kinds.includes('cmd') && kinds.includes('ws'))
  const hh = items.find(i => i.kind === 'ws' && i.id === 'a')
  assert.equal(hh.label, 'Open search: HH'); assert.equal(hh.hint, 'Belts')
  assert.equal(items.find(i => i.kind === 'ws' && i.id === 'b').hint, 'Workspace')
  const filtered = buildPaletteItems({ tabs: ['Board'], subDests: [], rows: [], leagues: [], commands: cmds, tree, q: 'hh' })
  assert.deepEqual(filtered.map(i => i.id), ['a'])
})

test('liveLabel reports Reconnecting… when a connect has been pending past the timeout', () => {
  const now = 1_000_000
  assert.deepEqual(liveLabel({ armed: true }, { state: 'connecting', at: now - 1000 }, now), { text: 'Live …', title: 'Connecting' })
  assert.equal(liveLabel({ armed: true }, { state: 'connecting', at: now - LIVE_CONNECT_TIMEOUT - 1 }, now).text, 'Reconnecting…')
  assert.equal(liveLabel({ armed: true }, { state: 'live', at: now - 60000 }, now).text, 'Live ●')
})
