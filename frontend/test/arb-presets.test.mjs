// Arbitrage presets (docs/learnability-plan.md part 4): the backend serves the five owner-tuned sets; the page
// writes a picked one through the normal settings save and shows a preset as picked while the saved values equal
// it, so editing any number deselects it (no stored "current preset").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { activePreset } from '../src/lib/arbPresets.js'

const values = (over = {}, filters = {}) => ({
  filters: { min_margin_pct: 5, min_margin_ref: 0, max_gold: 1000000, min_margin_per_1k_gold: 0.41, min_liquidity_ref: 200,
    min_volume_ref_per_h: 10000, max_fill_hours: 0, max_step_minutes: 15, min_velocity: 0, exclude_recipes: false, ...filters },
  max_steps: 3, rank_weights: { velocity: 0.8, margin_per_1k_gold: 0.2, margin_ref: 0.4, volume: 0.4 },
  step_overhead_min: 2, volume_window_h: 24, wide_spread: 2, gold_value_per_1k: 0.009098518761145686, ...over,
})
const PRESETS = [
  { id: 'balanced', label: 'Balanced', values: values({ volume_window_h: 72 }, { min_margin_pct: 20 }) },
  { id: 'quick', label: 'Quick flips', values: values() },
]
// a saved settings blob: the preset's values plus the user's own choices and unrelated keys
const saved = (v) => ({ theme: 'ember', max_start_fraction: 0.5, ...JSON.parse(JSON.stringify(v)),
  filters: { ...v.filters, start: 'divine', limit: 40, sort: 'score', live_only: false } })

test('the preset whose values the settings hold is the picked one', () => {
  assert.equal(activePreset(PRESETS, saved(PRESETS[1].values)), 'quick')
  assert.equal(activePreset(PRESETS, saved(PRESETS[0].values)), 'balanced')
})

test('editing any one value deselects it', () => {
  for (const s of [
    { ...saved(PRESETS[1].values), max_steps: 4 },
    { ...saved(PRESETS[1].values), gold_value_per_1k: 0.01 },
    { ...saved(PRESETS[1].values), rank_weights: { ...PRESETS[1].values.rank_weights, volume: 0.45 } },
    { ...saved(PRESETS[1].values), filters: { ...saved(PRESETS[1].values).filters, min_margin_pct: 6 } },
    { ...saved(PRESETS[1].values), filters: { ...saved(PRESETS[1].values).filters, exclude_recipes: true } },
  ]) assert.equal(activePreset(PRESETS, s), null)
})

test('the user\'s own choices never deselect a preset', () => {
  const s = saved(PRESETS[1].values)
  s.filters.start = 'chaos'; s.filters.limit = 10; s.max_start_fraction = 0.1
  assert.equal(activePreset(PRESETS, s), 'quick')
})

test('nothing loaded yet: no preset', () => {
  assert.equal(activePreset(PRESETS, null), null)
  assert.equal(activePreset([], saved(PRESETS[1].values)), null)
})

const routesView = readFileSync(new URL('../src/components/RoutesView.jsx', import.meta.url), 'utf8')
const apiSrc = readFileSync(new URL('../src/lib/api.js', import.meta.url), 'utf8')

test('the page reads the presets from the backend and saves a pick through the normal settings save', () => {
  assert.match(apiSrc, /arbitragePresets: \(\) => fetch\('\/api\/arbitrage\/presets'\)/)
  assert.match(routesView, /useApi\(\(\) => api\.arbitragePresets\(\), \[\]\)/, 'the one fetch-on-mount shape: answers the topbar refresh')
  assert.match(routesView, /saveSettings\(p\.values\)/)
  assert.match(routesView, /activePreset\(presets, settings\)/)
  assert.match(routesView, /aria-pressed=\{active === p\.id\}/)
})

test('after a pick the sliders and filter boxes show the new values', () => {
  assert.match(routesView, /setF\(filtersFromSettings\(s\.filters\)\)/)
  assert.match(routesView, /<GoldValueSlider key=\{`gold-\$\{rev\}`\}/)
  assert.match(routesView, /<ArbitrageAlgorithm key=\{`algo-\$\{rev\}`\}/)
})

test('currency thresholds are labelled in exalted (the presets\' unit), whatever the reference', () => {
  for (const label of ['Minimum margin, in exalted', 'Minimum liquidity, in exalted', 'Minimum velocity, exalted/h per 1k gold',
    'Minimum traded volume, exalted per hour']) assert.ok(routesView.includes(label), label)
  assert.doesNotMatch(routesView, /Minimum liquidity, in \{ref\}/)
})
