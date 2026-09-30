// The header orb's line while the local backend builds market history (BrandOrb.jsx). The
// crawl counts fetch candidates only, so a league with nothing to fetch is named without a
// counter rather than as "0/0 · 0%". Only a first build says "Building your dashboard"; the routine
// 12-hourly catch-up of a league that already has history says "Refreshing" (audit 2026-09-29, U1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backfillLabel } from '../src/lib/backfillLabel.js'

test('a first build: fetching leagues, then a league with work shows its counter, one without only its name', () => {
  const b = { building: true }
  assert.equal(backfillLabel({ ...b, phase: 'leagues' }), 'Building your dashboard — fetching leagues…')
  assert.equal(backfillLabel({ ...b, phase: 'crawling', league: 'Rise of the Abyssal', league_done: 3, league_total: 12, pct: 25 }), 'Building your dashboard — Rise of the Abyssal · 3/12 · 25%')
  assert.equal(backfillLabel({ ...b, phase: 'crawling', league: 'Forbidden Rites', league_done: 0, league_total: 0, pct: 0 }), 'Building your dashboard — checking Forbidden Rites…')
  assert.equal(backfillLabel({ ...b, phase: 'crawling', league: null, league_done: 0, league_total: 0 }), 'Building your dashboard — checking market history…')
})

test('a routine catch-up of history we already hold says Refreshing', () => {
  assert.equal(backfillLabel({ phase: 'leagues' }), 'Refreshing market data — fetching leagues…')
  assert.equal(backfillLabel({ building: false, phase: 'crawling', league: 'Forbidden Rites', league_done: 40, league_total: 400, pct: 10 }), 'Refreshing market data — Forbidden Rites · 40/400 · 10%')
})
