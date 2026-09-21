// Hold's forecast column shows a direction + strength (1-3 arrows), never a percentage: only the
// forecast's ordering was validated, and its ± was 4-22x too narrow. Past league-day 14 the backend
// sets pred_shown=false and the column goes away. See backend/tests/test_hold_score.py §10.
// Run:  node --test frontend/test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { arrowCell } = await import('../src/lib/arrows.js')
const ROOT = new URL('../../', import.meta.url).pathname
const hold = readFileSync(`${ROOT}frontend/src/components/HoldView.jsx`, 'utf8')

test('up is green arrows, one to three', () => {
  assert.deepEqual(arrowCell(1), { text: '↑', cls: 'gain' })
  assert.deepEqual(arrowCell(3), { text: '↑↑↑', cls: 'gain' })
})

test('down is red arrows, one to three', () => {
  assert.deepEqual(arrowCell(-1), { text: '↓', cls: 'loss' })
  assert.deepEqual(arrowCell(-2), { text: '↓↓', cls: 'loss' })
})

test('a weak forecast and no forecast are both a quiet dash', () => {
  for (const v of [0, null, undefined]) assert.deepEqual(arrowCell(v), { text: '–', cls: 'muted' }, String(v))
})

test('the percentage and its ± never reach the Hold view', () => {
  for (const dead of ['pred_pct', 'pred_band_pct', 'pred_leagues']) assert.ok(!hold.includes(dead), dead)
  assert.ok(hold.includes('arrowCell('), 'the column renders through arrowCell')
  assert.ok(hold.includes('pred_shown'), 'the column is gated on the backend’s pred_shown')
})
