// The Arbitrage filters persist in the user's settings (user.sqlite) — audit 2026-09-29, U2: they were
// read from settings but never written back, so every tab or league switch reset them. The form shows
// an unset threshold as a blank box; the backend's settings store "off" as 0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { filtersFromSettings, filtersToSave, streamQuery } from '../src/lib/routeFilters.js'

test('settings → form: "off" (0 / missing) shows as a blank box, sort stays out of the form', () => {
  const form = filtersFromSettings({ min_margin_pct: 3, max_gold: 0, min_liquidity_ref: 200, max_fill_hours: 24, sort: 'score', limit: 100 })
  assert.equal(form.min_margin_pct, 3)
  assert.equal(form.max_gold, '')
  assert.equal(form.min_velocity, '')
  assert.equal(form.min_liquidity_ref, 200)
  assert.equal(form.sort, undefined)
})

test('form → settings: numbers as numbers, a blank box as 0 (off), the toggle and start kept', () => {
  const saved = filtersToSave({ min_margin_pct: '1.25', min_margin_ref: 0, max_gold: '', min_margin_per_1k_gold: '',
    min_liquidity_ref: '500', min_volume_ref_per_h: '', max_fill_hours: '12', max_step_minutes: '', min_velocity: '',
    exclude_recipes: true, limit: 100, start: 'divine' })
  assert.deepEqual(saved, { min_margin_pct: 1.25, min_margin_ref: 0, max_gold: 0, min_margin_per_1k_gold: 0,
    min_liquidity_ref: 500, min_volume_ref_per_h: 0, max_fill_hours: 12, max_step_minutes: 0, min_velocity: 0,
    exclude_recipes: true, limit: 100, start: 'divine' })
})

test('a round trip keeps what the user typed', () => {
  const typed = { min_margin_pct: 2, max_fill_hours: 6, exclude_recipes: false, start: '' }
  const back = filtersFromSettings(filtersToSave({ ...filtersFromSettings({}), ...typed }))
  for (const [k, v] of Object.entries(typed)) assert.equal(back[k], v, k)
})

test('RoutesView saves its filters and debounces the search', () => {
  const src = readFileSync(new URL('../src/components/RoutesView.jsx', import.meta.url), 'utf8')
  assert.match(src, /saveSettings\(\{ filters: filtersToSave\(/)
  assert.ok(src.includes('useDebounced('), 'typing must not restart the route search on every keystroke')
})

test('the search sends what the form shows, and re-runs on any of it (code review 2026-09-29)', () => {
  // A cleared box used to be dropped from the query, so the server filled in the STORED value (the
  // save lands 300 ms after the search); and "Show at most" never re-ran the search at all.
  const src = readFileSync(new URL('../src/components/RoutesView.jsx', import.meta.url), 'utf8')
  assert.match(src, /routesStreamUrl\(streamQuery\(f\)\)/)
  assert.match(src, /const filterKey = JSON\.stringify\(filtersToSave\(f\)\)/)
  const sent = filtersToSave({ ...filtersFromSettings({ max_fill_hours: 24 }), max_fill_hours: '' })
  assert.equal(sent.max_fill_hours, 0, 'a cleared box is sent as off, not left for the server to fill')
})

test('the search pool is at least the default 100; "Show at most" only trims what is shown', () => {
  // The client re-sorts the pool by the picked column and bands it, then shows f.limit rows, so a small
  // limit must not shrink the pool the server ranks (the reason the query once sent no limit at all).
  assert.equal(streamQuery({ ...filtersFromSettings({}), limit: 20 }).limit, 100)
  assert.equal(streamQuery({ ...filtersFromSettings({}), limit: 250 }).limit, 250)
  assert.equal(streamQuery({ ...filtersFromSettings({}), max_gold: '' }).max_gold, 0)
})
