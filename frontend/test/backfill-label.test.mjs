// The header orb's line while the local backend builds market history (BrandOrb.jsx). The
// crawl counts fetch candidates only, so a league with nothing to fetch is named without a
// counter rather than as "0/0 · 0%".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backfillLabel } from '../src/lib/backfillLabel.js'

test('fetching leagues, then a league with work shows its counter, one without only its name', () => {
  assert.equal(backfillLabel({ phase: 'leagues' }), 'Building your dashboard — fetching leagues…')
  assert.equal(backfillLabel({ phase: 'crawling', league: 'Rise of the Abyssal', league_done: 3, league_total: 12, pct: 25 }), 'Building your dashboard — Rise of the Abyssal · 3/12 · 25%')
  assert.equal(backfillLabel({ phase: 'crawling', league: 'Forbidden Rites', league_done: 0, league_total: 0, pct: 0 }), 'Building your dashboard — checking Forbidden Rites…')
  assert.equal(backfillLabel({ phase: 'crawling', league: null, league_done: 0, league_total: 0 }), 'Building your dashboard — checking market history…')
})
