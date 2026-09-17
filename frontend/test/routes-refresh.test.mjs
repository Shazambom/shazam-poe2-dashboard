// Regression: the Arbitrage filter boxes hold '' when empty (RoutesView normalises unset numeric
// filters to '' for the inputs). The GET stream drops blanks in qs(); the two refresh POSTs sent
// them verbatim, the backend's RouteQuery rejected '' as a float (422), and the page printed the
// raw pydantic JSON as its note. A blank filter means "unset" on every route call.
import test from 'node:test'
import assert from 'node:assert/strict'
import { api } from '../src/lib/api.js'

const FILTERS = { min_margin_pct: 0.5, min_margin_ref: 0, max_gold: '', min_margin_per_1k_gold: '', max_fill_hours: '',
  min_velocity: null, live_only: false, exclude_recipes: false, start: '' }

function capture() {
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url, body: init?.body && JSON.parse(init.body) }); return { ok: true, json: async () => ({}) } }
  return calls
}

test('refresh-top sends no blank filters', async () => {
  const calls = capture()
  await api.refreshTop(FILTERS, 5)
  assert.deepEqual(calls[0].body, { filters: { min_margin_pct: 0.5, min_margin_ref: 0, live_only: false, exclude_recipes: false }, start: null, n: 5 })
})

test('refresh (one loop) sends no blank filters and keeps a chosen start', async () => {
  const calls = capture()
  await api.refreshRoute('a>b|b>a', [['a', 'b']], { ...FILTERS, start: 'exalted' })
  assert.deepEqual(calls[0].body.filters, { min_margin_pct: 0.5, min_margin_ref: 0, live_only: false, exclude_recipes: false, start: 'exalted' })
  assert.equal(calls[0].body.start, 'exalted')
})

test('the stream URL drops the same blanks (one rule for GET and POST)', () => {
  assert.equal(api.routesStreamUrl(FILTERS), '/api/routes/stream?min_margin_pct=0.5&min_margin_ref=0&live_only=false&exclude_recipes=false')
})
