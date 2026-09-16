// Batch 3: the history-folder rules of ingest() — dedupe/bump per league, newest first, cap, expiry,
// clearHistory (one undo slot), pre-hydrate buffering, disabled drops, and rows outside the folder untouched.
import test from 'node:test'
import assert from 'node:assert/strict'
let puts = 0
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('/api/trading/workspace') && opts.method === 'PUT') puts++
  return { ok: true, status: 200, json: async () => ({ workspace: { version: 2, tree: [] } }), text: async () => '' }
}
const { useWorkspace, HISTORY_SYS, HISTORY_NAME, HISTORY_PREFS } = await import('../src/lib/workspaceStore.js')
const st = () => useWorkspace.getState()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const Q = (n) => JSON.stringify({ query: { name: n } })
const intent = (name, q, extra = {}) => ({ source: 'ee2', origin: 'ee2', q, name, item: { name, baseType: 'Belt', rarity: 'Unique', itemClass: 'Belts' }, folder: HISTORY_SYS, ...extra })
const hist = () => st().tree.find(n => n.sys === HISTORY_SYS)
const fresh = async (tree = []) => { st().setHistoryPrefs({ ...HISTORY_PREFS }); st().hydrate({ version: 2, tree, layout: null, openTabs: [] }); await sleep(5) }

test('rows land newest-first with league stamped; a byte-identical q in the same league bumps to the top and keeps a renamed name', async () => {
  await fresh(); st().setLeague('Forbidden Rites')
  const a = st().ingest(intent('A', Q('A')))
  const b = st().ingest(intent('B', Q('B')))
  assert.equal(a.result, 'added'); assert.equal(b.result, 'added')
  assert.deepEqual(hist().children.map(c => c.name), ['B', 'A'])
  const row = hist().children[1]
  assert.equal(row.league, 'Forbidden Rites'); assert.equal(row.slug, ''); assert.equal(row.auto, false); assert.equal(row.origin, 'ee2'); assert.equal(row.q, Q('A'))
  st().rename(row.id, 'My belt')
  const again = st().ingest(intent('A', Q('A')))
  assert.equal(again.result, 'bumped')
  assert.deepEqual(hist().children.map(c => c.name), ['My belt', 'B'], 'old twin removed, new row on top, name inherited')
  assert.equal(hist().children.length, 2)
  // a different league is a different row
  st().setLeague('Standard')
  const c = st().ingest(intent('A', Q('A')))
  assert.equal(c.result, 'added'); assert.equal(hist().children.length, 3)
  assert.equal(st().activeId, null, 'the item stream never selects')
})

test('cap trims the oldest (hidden-league rows count); expiry removes rows older than retention', async () => {
  await fresh(); st().setLeague('L1'); st().setHistoryPrefs({ max: 3, retentionDays: 14 })
  st().ingest(intent('1', Q('1'))); st().setLeague('L2')
  st().ingest(intent('2', Q('2'))); st().ingest(intent('3', Q('3'))); st().ingest(intent('4', Q('4')))
  assert.deepEqual(hist().children.map(c => c.name), ['4', '3', '2'], 'cap 3 — the L1 row was the oldest and went first')
  const now = Date.now()
  hist().children[2].ts = now - (14 * 86400000 + 3600000)   // 14 d 1 h old
  hist().children[1].ts = now - (13 * 86400000 + 23 * 3600000)   // 13 d 23 h old
  st().expireHistory(now)
  assert.deepEqual(hist().children.map(c => c.name), ['4', '3'])
})

test('dedupe, cap and expiry never touch rows outside the folder; degraded intents insert q:null', async () => {
  await fresh([{ id: 'x', kind: 'search', name: 'Curated', q: Q('A'), slug: '', ts: 1, league: 'L' }]); st().setLeague('L'); st().setHistoryPrefs({ max: 1, retentionDays: 1 })
  st().ingest(intent('A', Q('A'))); st().ingest(intent('B', Q('B')))
  st().expireHistory(Date.now() + 10 * 86400000)
  assert.ok(st().nodeById('x'), 'curated row survives dedupe/cap/expiry')
  assert.equal(st().tree[0].sys, HISTORY_SYS, 'folder created at root index 0')
  const d = st().ingest(intent('New', null, { degraded: true, stage: 'parse' }))
  assert.equal(d.result, 'degraded')
  const row = hist().children[0]
  assert.equal(row.q, null); assert.equal(row.degraded, true); assert.equal(row.name, 'New')
})

test('folder is found after rename/move and recreated after deletion; persist fires once per ingest', async () => {
  await fresh([{ id: 'g', kind: 'folder', name: 'G', children: [{ id: 'h', kind: 'folder', sys: HISTORY_SYS, name: 'Renamed', children: [] }] }]); st().setLeague('L')
  st().ingest(intent('A', Q('A')))
  assert.equal(st().nodeById('h').children.length, 1)
  st().remove('h')
  st().ingest(intent('B', Q('B')))
  assert.equal(st().tree[0].sys, HISTORY_SYS); assert.equal(st().tree[0].name, HISTORY_NAME)
  puts = 0
  st().ingest(intent('C', Q('C')))
  await st().flush()
  assert.equal(puts, 1)
})

test('clearHistory empties only the folder and is one undo slot', async () => {
  await fresh([{ id: 'x', kind: 'search', name: 'Keep', slug: 's' }]); st().setLeague('L')
  st().ingest(intent('A', Q('A'))); st().ingest(intent('B', Q('B')))
  const undo = st().clearHistory()
  assert.equal(undo.n, 2); assert.equal(hist().children.length, 0); assert.ok(st().nodeById('x'))
  st().restoreHistory(undo)
  assert.deepEqual(hist().children.map(c => c.name), ['B', 'A'])
})

test('intents before hydrate are buffered and applied in order; disabled drops; load-error drops', async () => {
  useWorkspace.setState({ loaded: false, loadError: null, tree: [] })
  assert.deepEqual(st().ingest(intent('A', Q('A'))), { result: 'buffered' })
  assert.deepEqual(st().ingest(intent('B', Q('B'))), { result: 'buffered' })
  await fresh(); st().setLeague('L')
  assert.deepEqual(hist().children.map(c => c.name), ['B', 'A'])
  st().setHistoryPrefs({ enabled: false })
  assert.deepEqual(st().ingest(intent('C', Q('C'))), { result: 'dropped', reason: 'disabled' })
  st().setHistoryPrefs({ enabled: true })
  st().failLoad('boom')
  assert.deepEqual(st().ingest(intent('C', Q('C'))), { result: 'dropped', reason: 'load-error' })
  await fresh()
})
