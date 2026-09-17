// The frontend no longer re-derives backend-owned vocabulary (audit F-09, F-13, F-24).
// Run:  node --test frontend/test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8')

test('hold horizon is hours end to end (no holdHorizon bridge)', () => {
  assert.ok(!src('lib/horizonStore.js').includes('holdHorizon'))
  for (const f of ['components/HoldView.jsx', 'components/BoardView.jsx']) assert.ok(!src(f).includes('holdHorizon'), f)
})

test('route scores come from the server (no client scoreAll)', () => {
  const rv = src('components/RoutesView.jsx')
  assert.ok(!rv.includes('scoreAll') && !rv.includes('weightsRef') && !rv.includes('rank_weights'))
  assert.ok(rv.includes("addEventListener('scores'"))
})

test('feed staleness is rendered from the backend state strings', () => {
  const sc = src('components/SyncControls.jsx')
  assert.ok(!sc.includes('feedState') && !sc.includes('2 * 3600'))
  // the order-book feed chip went with the deprecated Bulk Item Exchange (docs/market-data-sources.md)
  assert.ok(sc.includes('digest?.state') && !sc.includes('orderbook'))
})

test('anchor vocab comes from the API (no hardcoded anchor lists)', () => {
  assert.ok(!src('components/HoldView.jsx').includes("['divine', 'vs Divine']"))
  const iv = src('components/InflationView.jsx')
  assert.ok(!iv.includes("Hinekora's Lock") && !iv.includes("{ id: 291, name: 'Divine Orb' }"))
})
