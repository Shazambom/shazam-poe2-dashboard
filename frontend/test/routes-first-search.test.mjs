// The Arbitrage page re-sorted itself a second after it opened (owner, 2026-10-03). Telemetry showed two
// route searches per visit, ~1 s apart, with different filters (after_filters 825, then 259): the page
// searched with the DEFAULT filters on mount, then again once the saved filters loaded, and swapped the
// table. Nothing is searched until the saved filters are in; the first search then runs at once.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const { searchKeyOf, DEFAULT_FILTERS, filtersFromSettings } = await import('../src/lib/routeFilters.js')

test('no search key until the saved filters have loaded; then the key of what the form shows', () => {
  assert.equal(searchKeyOf(DEFAULT_FILTERS, false), null, 'never a search with filters the user did not choose')
  const saved = filtersFromSettings({ min_liquidity_ref: 500 })
  const key = searchKeyOf(saved, true)
  assert.equal(typeof key, 'string')
  assert.notEqual(key, searchKeyOf(DEFAULT_FILTERS, true), 'the key follows the filters')
})

test('RoutesView searches only with a key, and its first search does not wait for the debounce', () => {
  const src = readFileSync(new URL('../src/components/RoutesView.jsx', import.meta.url), 'utf8')
  assert.match(src, /searchKeyOf\(f, loaded\)/)
  assert.match(src, /if \(searchKey == null\) return/, 'no search before the saved filters')
  assert.match(src, /useDebounced\(filterKey, 500\) \?\? filterKey/, 'the first key applies at once; later edits debounce')
})
