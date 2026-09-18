// The app's 9 distinct screens — one list feeding ⌘K, the feedback sweep and the opener's allow-list.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DESTS, SUB_DESTS, SNAP_PARAM } from '../src/lib/dests.js'

test('nine screens with unique slug ids: board, the seven sub-views, settings', () => {
  assert.equal(DESTS.length, 9)
  const ids = DESTS.map(d => d.id)
  assert.equal(new Set(ids).size, 9)
  for (const id of ids) assert.match(id, /^[a-z]+(-[a-z]+)?$/)
  assert.deepEqual(ids, ['board', 'strategy-hold', 'strategy-arbitrage', 'economy-inflation', 'economy-market',
                         'trading-workspace', 'trading-live', 'trading-sales', 'settings'])
  for (const d of DESTS) assert.ok(d.section && d.label, d.id)
})

test('SUB_DESTS is derived: exactly the seven sub-views ⌘K lists today, in order', () => {
  assert.deepEqual(SUB_DESTS, [
    { section: 'Strategy', sub: 'hold', label: 'Hold' },
    { section: 'Strategy', sub: 'arbitrage', label: 'Arbitrage' },
    { section: 'Economy', sub: 'inflation', label: 'Inflation' },
    { section: 'Economy', sub: 'market', label: 'Market' },
    { section: 'Trading', sub: 'workspace', label: 'Workspace' },
    { section: 'Trading', sub: 'live', label: 'Live' },
    { section: 'Trading', sub: 'sales', label: 'Sales' },
  ])
  assert.equal(SNAP_PARAM, 'snap')
})
