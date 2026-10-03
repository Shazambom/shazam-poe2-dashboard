// The trade tap's events, kept per trade window whether or not a view is listening yet (QA regression,
// 2026-10-03): in the packaged app a reloaded window's search can finish before its <webview> reports its id to
// the view, and events the view could not match yet were dropped — the reprice chip never came back after ↻.
// Now every event lands in its window's page at once, and the view reads its own window's page.
import test from 'node:test'
import assert from 'node:assert/strict'
const S = await import('../src/lib/tapStore.js')

const P = { vaal: 0.0128, chaos: 0.0915 }
const OPTIONS = { kind: 'options', price: [{ id: 'vaal', text: 'Vaal Orb' }, { id: 'chaos', text: 'Chaos Orb' }] }
const search = (wcId, id) => ({ kind: 'search', wcId, league: 'L', id, body: { query: { type: 'X' }, sort: { price: 'asc' } }, ids: ['a', 'b'], total: 2 })
const fetchOf = (wcId, searchId) => ({ kind: 'fetch', wcId, searchId, rows: [{ id: 'a', amount: 17, currency: 'chaos' }] })

test('events that arrive before any view asks are kept for their window', () => {
  const st = S.makeTapStore()
  st.ingest({ ...OPTIONS, wcId: 5 }, P)
  st.ingest(search(5, 'Q1'), P)
  st.ingest(fetchOf(5, 'Q1'), P)
  const page = st.pageOf(5)
  assert.equal(page.search.id, 'Q1')
  assert.equal(page.rows.a.amount, 17)
  assert.ok(page.options)
  assert.equal(page.prices, P)
})

test('windows are kept apart, and a new window gets the site\'s options even if they came on another', () => {
  const st = S.makeTapStore()
  st.ingest({ ...OPTIONS, wcId: 1 }, P)
  st.ingest(search(2, 'Q2'), P)        // window 2 attached after the options were sent to window 1
  assert.equal(st.pageOf(1).search, null)
  assert.equal(st.pageOf(2).search.id, 'Q2')
  assert.ok(st.pageOf(2).options, 'the price options are site-wide')
  assert.equal(st.pageOf(9).search, null, 'an unknown window is an empty page')
})

test('subscribers hear every change; extra rows can be merged into a window\'s page; old windows can be dropped', () => {
  const st = S.makeTapStore()
  let heard = 0
  const off = st.subscribe(() => heard++)
  st.ingest(search(3, 'Q3'), P)
  st.merge(3, 'Q3', [{ id: 'b', amount: 105, currency: 'vaal' }])
  assert.equal(st.pageOf(3).rows.b.amount, 105)
  st.merge(3, 'OLD', [{ id: 'a', amount: 1, currency: 'vaal' }])
  assert.equal(st.pageOf(3).rows.a, undefined, 'rows for another search are dropped')
  assert.equal(heard, 3)
  off(); st.ingest(fetchOf(3, 'Q3'), P); assert.equal(heard, 3)
  st.drop(3); assert.equal(st.pageOf(3).search, null)
})

test('a page keeps the first price table it got (no flicker), and one that arrived before prices takes the next', () => {
  const st = S.makeTapStore()
  st.ingest(search(4, 'Q4'), null)
  assert.equal(st.pageOf(4).prices, null)
  st.setPrices(P)
  assert.equal(st.pageOf(4).prices, P)
  st.setPrices({ vaal: 1, chaos: 1 })
  assert.equal(st.pageOf(4).prices, P)
})

// Found by the proof's cache check (packaged app, 2026-10-03): re-showing a search the site ran moments ago (undo,
// ↻) is often redrawn from the site's own cache — no search request, no listing fetch — so the tap sees nothing.
// The store keeps the last page it saw for each exact search for 5 minutes; a window showing that search without
// its own events uses it (the same results the site redraws), with no request.
test('recentFor: the last page seen for an exact search is kept 5 minutes, across windows', () => {
  const st = S.makeTapStore()
  const t0 = 1_000_000
  st.ingest({ ...OPTIONS, wcId: 1 }, P, t0)
  st.ingest(search(1, 'Q1'), P, t0)
  st.ingest(fetchOf(1, 'Q1'), P, t0 + 100)
  const q = { type: 'X' }
  const p = st.recentFor('L', q, t0 + 4 * 60_000)
  assert.equal(p?.search.id, 'Q1'); assert.equal(p.rows.a.amount, 17)
  assert.equal(st.recentFor('L', { type: 'X', other: 1 }, t0 + 1000), null, 'only the exact search')
  assert.equal(st.recentFor('Other league', q, t0 + 1000), null)
  assert.equal(st.recentFor('L', q, t0 + 100 + 5 * 60_000 + 1), null, '5 minutes after it was last seen')
  st.merge(1, 'Q1', [{ id: 'b', amount: 105, currency: 'vaal' }], t0 + 200)
  assert.equal(st.recentFor('L', q, t0 + 1000).rows.b.amount, 105, 'rows the app fetched are remembered too')
})

// Found by the careful drive (2026-10-03): the store kept every window's page forever, and the hook re-recorded all
// of them as fresh evidence each time prices refreshed, so chaos listings seen >10 minutes earlier kept offering
// "Reprice in Chaos Orb" on a page showing only vaal. Evidence must age from when it was seen; gone windows go.
test('freshPages: only pages whose search was seen in the last 5 minutes', () => {
  const st = S.makeTapStore()
  const t0 = 2_000_000
  st.ingest(search(1, 'OLD'), P, t0)
  st.ingest(search(2, 'NEW'), P, t0 + 4 * 60_000)
  const fresh = st.freshPages(t0 + 5 * 60_000 + 1)
  assert.deepEqual(fresh.map(x => x.page.search.id), ['NEW'])
  assert.equal(fresh[0].at, t0 + 4 * 60_000, 'with the time the search was seen')
  assert.equal(st.seenAtOf(2), t0 + 4 * 60_000); assert.equal(st.seenAtOf(7), null)
  st.drop(2)
  assert.deepEqual(st.freshPages(t0 + 4 * 60_000 + 1).map(x => x.page.search.id), ['OLD'])
})
