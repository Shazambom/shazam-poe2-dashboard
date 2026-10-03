// Trading → Workspace: "Reprice in <currency>" (owner, 2026-10-02; design docs/reprice-design.md). The trade
// site sorts "cheapest first" by its own exalted-equivalent rates, which can disagree with the market. When the
// listing a search shows first is not the cheapest the page has loaded (at Arbiter's rates, by more than τ),
// offer to re-run it priced in the cheapest currency. Within one currency the site's order is exact, so each
// currency's first loaded row is its minimum. The site's own rates are never estimated.
import test from 'node:test'
import assert from 'node:assert/strict'
const R = await import('../src/lib/reprice.js')

// Divines per unit, as /api/strategy/calc?prices=1 served them on 2026-10-02.
const P = { vaal: 0.012811502165494587, chaos: 0.09150921466842146, exalted: 0.0014669982480578286, divine: 1, aug: 0.0003 }
// The site's price options as the tap captured them from the live site (2026-10-02).
const OPTIONS = { kind: 'options', wcId: 1, price: ['exalted_divine', 'aug', 'transmute', 'exalted', 'regal', 'chaos', 'vaal', 'alch', 'divine', 'annul', 'mirror'].map(id => ({ id, text: id === 'vaal' ? 'Vaal Orb' : id === 'chaos' ? 'Chaos Orb' : id === 'divine' ? 'Divine Orb' : id })) }
const QUERY = { status: { option: 'securable' }, type: 'Revelatory Wombgift', stats: [{ type: 'and', filters: [] }] }
const BODY = { query: QUERY, sort: { price: 'asc' } }

// A page: the options, a search with ids r0…r(n-1), then fetches of [currency, amount] in rank order.
function page(rows, { body = BODY, prices = P, fetchOrder = null, id = 'S1' } = {}) {
  let s = R.observe(R.EMPTY, OPTIONS)
  s = R.observe(s, { kind: 'search', wcId: 1, league: 'Forbidden Rites', id, body, ids: rows.map((_, i) => `r${i}`), total: rows.length }, prices)
  const all = rows.map(([currency, amount], i) => ({ id: `r${i}`, amount, currency }))
  for (const chunk of fetchOrder ? fetchOrder.map(ix => ix.map(i => all[i])) : [all]) s = R.observe(s, { kind: 'fetch', wcId: 1, searchId: id, rows: chunk })
  return s
}
const offer = (s, prices = P, ctx) => R.verdict(s, prices, ctx)?.currency ?? null

test('the owner\'s Wombgifts: vaal 105–120 shown above chaos 17 is already true order → no offer', () => {
  assert.equal(offer(page([['vaal', 105], ['vaal', 110], ['vaal', 120], ['chaos', 17]])), null)
  assert.equal(offer(page([['vaal', 105], ['vaal', 120]])), null, 'chaos not loaded: nothing to compare')
})

test('chaos 17 shown above vaal 105 → "Reprice in Vaal Orb", named with the site\'s own option text', () => {
  const v = R.verdict(page([['chaos', 17], ['vaal', 105]]), P)
  assert.deepEqual({ currency: v.currency, text: v.text }, { currency: 'vaal', text: 'Vaal Orb' })
  // for beta telemetry only (never shown): the currency on top and the gap, 17 chaos (1.55566 div) vs 105 vaal (1.34521 div) = 15.6%
  assert.equal(v.lead, 'chaos'); assert.equal(Math.round(v.gap * 1000) / 10, 15.6)
})

test('any pair of currencies, and the cheapest of three wins (no divine/exalted special case)', () => {
  // top: 2 divine = 2 div; 20 chaos = 1.83 div; 140 vaal = 1.79 div
  assert.equal(offer(page([['divine', 2], ['chaos', 20], ['vaal', 140]])), 'vaal')
  assert.equal(offer(page([['exalted', 1500], ['divine', 1.5]])), 'divine')   // 1500 ex = 2.2 div > 1.5 div
})

test('τ = 5%: a 4.9% gap is noise, 5.1% is an offer', () => {
  const chaosFor = (gap) => (105 * P.vaal * (1 + gap)) / P.chaos
  assert.equal(offer(page([['chaos', chaosFor(0.049)], ['vaal', 105]])), null)
  assert.equal(offer(page([['chaos', chaosFor(0.051)], ['vaal', 105]])), 'vaal')
})

test('the top row must be loaded and priced; unpriced or unfilterable currencies are ignored', () => {
  // the real top (vaal 105) has not loaded; the dearer chaos below it must not pass for the top
  assert.equal(offer(page([['vaal', 105], ['chaos', 17], ['vaal', 110]], { fetchOrder: [[1, 2]] })), null, 'rank 0 not loaded yet')
  assert.equal(offer(page([['gold', 5], ['vaal', 105]])), null, 'the top row is in a currency without a price')
  assert.equal(offer(page([['chaos', 17], ['gold', 1], ['vaal', 105]], { prices: { ...P, gold: 0.00001 } })), 'vaal', 'gold is priced but no price option: never offered')
})

test('fetches that arrive out of order are placed by rank, and the offer only grows as rows load', () => {
  const rows = [['chaos', 17], ['chaos', 18], ['vaal', 105]]
  let s = page(rows, { fetchOrder: [[2]] })
  assert.equal(offer(s), null)
  s = R.observe(s, { kind: 'fetch', wcId: 1, searchId: 'S1', rows: [{ id: 'r0', amount: 17, currency: 'chaos' }] })
  assert.equal(offer(s), 'vaal')
  s = R.observe(s, { kind: 'fetch', wcId: 1, searchId: 'S1', rows: [{ id: 'r1', amount: 18, currency: 'chaos' }] })
  assert.equal(offer(s), 'vaal')
})

test('a fetch for another search is dropped; a new search starts a fresh page but keeps the options', () => {
  let s = page([['chaos', 17], ['vaal', 105]])
  s = R.observe(s, { kind: 'search', wcId: 1, league: 'Forbidden Rites', id: 'S2', body: BODY, ids: ['z0'], total: 1 }, P)
  assert.equal(offer(s), null)
  s = R.observe(s, { kind: 'fetch', wcId: 1, searchId: 'S1', rows: [{ id: 'z0', amount: 17, currency: 'chaos' }] })
  assert.equal(offer(s), null, 'stale search id')
  assert.ok(s.options)
})

test('the price table is the one taken when the search arrived, so a later poll cannot make it flicker', () => {
  const s = page([['chaos', 17], ['vaal', 105]])
  assert.equal(offer(s, { ...P, vaal: 0.5 }), 'vaal', 'the snapshot wins over a newer table')
  const cold = page([['chaos', 17], ['vaal', 105]], { prices: null })
  assert.equal(offer(cold, null), null, 'no prices at all → no offer')
  assert.equal(offer(cold, P), 'vaal', 'a search that arrived before the prices uses the first table it gets')
})

test('a search not sorted by price ascending never offers', () => {
  assert.equal(offer(page([['chaos', 17], ['vaal', 105]], { body: { query: QUERY, sort: { 'stat.explicit.x': 'desc' } } })), null)
  assert.equal(offer(page([['chaos', 17], ['vaal', 105]], { body: { query: QUERY, sort: { price: 'desc' } } })), null)
})

test('siblings: a chaos-filtered page offers vaal from the same search\'s earlier default page (5 minutes)', () => {
  const sib = new Map()
  const t0 = 1_000_000
  R.remember(sib, page([['vaal', 105], ['vaal', 120], ['chaos', 17.4]]), t0)
  const filtered = { query: { ...QUERY, filters: { trade_filters: { filters: { price: { option: 'chaos' } } } } }, sort: { price: 'asc' } }
  const chaosPage = page([['chaos', 17], ['chaos', 18]], { body: filtered, id: 'S9' })
  assert.equal(offer(chaosPage), null, 'alone, a one-currency page has nothing to compare')
  assert.equal(offer(chaosPage, P, { siblings: sib, now: t0 + 60_000 }), 'vaal')
  assert.equal(offer(chaosPage, P, { siblings: sib, now: t0 + 5 * 60_000 + 1 }), null, 'sibling evidence lasts 5 minutes (owner: 5 min TTL)')
})

test('the sibling key ignores the price filter and key order, but not the league or other filters', () => {
  const a = R.siblingKey('Forbidden Rites', { type: 'X', status: { option: 'securable' } })
  assert.equal(R.siblingKey('Forbidden Rites', { status: { option: 'securable' }, type: 'X', filters: { trade_filters: { filters: { price: { option: 'vaal', min: 3 } } } } }), a)
  assert.notEqual(R.siblingKey('Standard', { type: 'X', status: { option: 'securable' } }), a)
  assert.notEqual(R.siblingKey('Forbidden Rites', { type: 'Y', status: { option: 'securable' } }), a)
})

test('property: over random pairs from the price table, offer ⇔ the cheapest is not on top by more than τ', () => {
  const ids = ['vaal', 'chaos', 'exalted', 'divine']
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let i = 0; i < 400; i++) {
    const a = ids[Math.floor(rnd() * 4)], b = ids[Math.floor(rnd() * 4)]
    if (a === b) continue
    const va = 0.5 + rnd() * 2, vb = 0.5 + rnd() * 2   // values in divines
    const got = offer(page([[a, va / P[a]], [b, vb / P[b]]]))
    assert.equal(got, va >= vb * 1.05 ? b : null, `${a}=${va} on top, ${b}=${vb}`)
  }
})

// The action: the page's own search, priced in the chosen currency.
test('repriceQuery sets the price option, Instant Buyout and price sort; every other key keeps its bytes', () => {
  const body = { query: { status: { option: 'online' }, type: 'X', stats: [{ type: 'and', filters: [{ id: 's1' }] }], filters: { misc_filters: { filters: { corrupted: { option: 'false' } } } } }, sort: { price: 'asc' } }
  const out = JSON.parse(R.repriceQuery(body, 'vaal', P))
  assert.deepEqual(out.query.status, { option: 'securable' })
  assert.deepEqual(out.query.filters.trade_filters, { disabled: false, filters: { price: { option: 'vaal' } } })
  assert.deepEqual(out.sort, { price: 'asc' })
  const strip = (b) => { const c = structuredClone(b); delete c.query.status; delete c.query.filters.trade_filters; delete c.sort; return JSON.stringify(c) }
  assert.equal(strip(out), strip(body))
})

test('repriceQuery switches a disabled trade-filter group on and keeps its other filters', () => {
  const body = { query: { filters: { trade_filters: { disabled: true, filters: { fee: { max: 9 }, price: { option: 'chaos' } } } } }, sort: { price: 'asc' } }
  assert.deepEqual(JSON.parse(R.repriceQuery(body, 'vaal', P)).query.filters.trade_filters, { disabled: false, filters: { fee: { max: 9 }, price: { option: 'vaal' } } })
})

test('repriceQuery converts min/max into the new currency, rounded outward (owner: convert)', () => {
  // 17–30 chaos → vaal: ×(0.0915092/0.0128115) = 121.4…–214.2…; min rounds down, max up (3 significant figures)
  const body = { query: { filters: { trade_filters: { filters: { price: { option: 'chaos', min: 17, max: 30 } } } } }, sort: { price: 'asc' } }
  assert.deepEqual(JSON.parse(R.repriceQuery(body, 'vaal', P)).query.filters.trade_filters.filters.price, { option: 'vaal', min: 121, max: 215 })
  // No option = the site's Exalted Orb Equivalent
  const ex = { query: { filters: { trade_filters: { filters: { price: { max: 1000 } } } } }, sort: { price: 'asc' } }
  assert.deepEqual(JSON.parse(R.repriceQuery(ex, 'chaos', P)).query.filters.trade_filters.filters.price, { option: 'chaos', max: 16.1 })
  // A unit we cannot price: the bounds are dropped, so nothing the user allowed is excluded
  const odd = { query: { filters: { trade_filters: { filters: { price: { option: 'annul', min: 2 } } } } }, sort: { price: 'asc' } }
  assert.deepEqual(JSON.parse(R.repriceQuery(odd, 'vaal', P)).query.filters.trade_filters.filters.price, { option: 'vaal' })
})

test('repriceQuery is idempotent', () => {
  const once = R.repriceQuery(BODY, 'vaal', P)
  assert.equal(R.repriceQuery(JSON.parse(once), 'vaal', P), once)
})

// When the chip may show at all: a saved search selected that is not live and not a History row,
// and the trade window showing that very search (its slug) — not the Instant Buyout home landing or an edited,
// not-yet-captured search, whose evidence would be written over the wrong row.
test('the gate: a saved non-live non-History row, and the window on that row\'s own search', () => {
  const node = { id: 'a', kind: 'search', slug: 'H4sIROW', type: 'search', live: false }
  const url = 'https://www.pathofexile.com/trade2/search/poe2/Forbidden%20Rites/H4sIROW'
  const ok = { node, inHistory: false, navUrl: url }
  assert.equal(R.applies(ok), true)
  assert.equal(R.applies({ ...ok, node: null }), false)
  assert.equal(R.applies({ ...ok, node: { ...node, live: true } }), false)
  assert.equal(R.applies({ ...ok, inHistory: true }), false)
  assert.equal(R.applies({ ...ok, navUrl: url.replace('ROW', 'OTHER') }), false, 'an edited search not yet captured')
  assert.equal(R.applies({ ...ok, navUrl: url + '/live' }), false)
  assert.equal(R.applies({ ...ok, navUrl: 'https://www.pathofexile.com/trade2/exchange/poe2/Forbidden%20Rites/H4sIROW' }), false)
  assert.equal(R.applies({ ...ok, node: { ...node, slug: '' }, navUrl: 'https://www.pathofexile.com/trade2/search/poe2/Forbidden%20Rites' }), false)
  assert.equal(R.applies({ ...ok, navUrl: '' }), false)
})

// Beta telemetry checks that the page ran the repriced search. The site re-serializes the price filter in its own
// shape (seen in the drive, 2026-10-02: {"filters":{"price":{"min":null,"max":null,"option":"chaos"}}}, no
// `disabled`), so the check is on what the reprice decides — Instant Buyout and the price option — not on bytes.
test('ranRepriced: the site\'s own re-serialization of a repriced search counts as ran-as-built', () => {
  const site = { status: { option: 'securable' }, type: 'Revelatory Wombgift', stats: [{ type: 'and', filters: [] }], filters: { trade_filters: { filters: { price: { min: null, max: null, option: 'chaos' } } } } }
  assert.equal(R.ranRepriced(site, 'chaos'), true)
  assert.equal(R.ranRepriced(site, 'vaal'), false)
  assert.equal(R.ranRepriced({ ...site, status: { option: 'online' } }, 'chaos'), false)
  assert.equal(R.ranRepriced({ status: { option: 'securable' } }, 'chaos'), false)
})

// Found driving the app (2026-10-02): after a fresh load the first search arrives before the price table, so its
// page has no snapshot; its evidence must still count once prices exist (remember takes the latest table).
test('a page that arrived before the prices still leaves sibling evidence', () => {
  const sib = new Map()
  const t0 = 5_000_000
  const filtered = { query: { ...QUERY, filters: { trade_filters: { filters: { price: { option: 'chaos' } } } } }, sort: { price: 'asc' } }
  const chaosFirst = page([['chaos', 15], ['chaos', 15]], { body: filtered, id: 'C1', prices: null })
  R.remember(sib, chaosFirst, t0, P)
  const vaalPage = page([['vaal', 139], ['vaal', 140]], { id: 'V1' })
  assert.equal(offer(vaalPage, P, { siblings: sib, now: t0 + 1000 }), 'chaos')   // 139 vaal 1.78 div > 15 chaos 1.37 div
})

// "Search once, click once" (owner, 2026-10-02). A search returns up to 100 ids but the page loads only the first
// 10; in the real Wombgift search the first 26 rows were vaal 139–150 and the cheap chaos (15, 16, 17…) started at
// rank 26. So after a search the app fetches a sample of the ids the search already returned — every 10th rank and
// the last — and, only when a sampled row cannot decide the offer, the ≤9 ids just before a currency's first
// sampled row, where its true minimum sits. No new searches.
const ranks = (n) => Array.from({ length: n }, (_, i) => `r${i}`)
function searched(n, { body = BODY, prices = P } = {}) {
  let s = R.observe(R.EMPTY, OPTIONS)
  return R.observe(s, { kind: 'search', wcId: 1, league: 'Forbidden Rites', id: 'S1', body, ids: ranks(n), total: n }, prices)
}
const load = (s, rows) => R.observe(s, { kind: 'fetch', wcId: 1, searchId: 'S1', rows: rows.map(([i, currency, amount]) => ({ id: `r${i}`, amount, currency })) })
const first10 = (s, cur = 'vaal', at = 139) => load(s, Array.from({ length: 10 }, (_, i) => [i, cur, at + i]))

test('samplePlan: every 10th rank past the first page, plus the last, skipping what is loaded', () => {
  assert.deepEqual(R.samplePlan(first10(searched(100))), ['r10', 'r20', 'r30', 'r40', 'r50', 'r60', 'r70', 'r80', 'r90', 'r99'])
  assert.deepEqual(R.samplePlan(first10(searched(25))), ['r10', 'r20', 'r24'])
  assert.deepEqual(R.samplePlan(load(first10(searched(25)), [[20, 'vaal', 150]])), ['r10', 'r24'])
  assert.deepEqual(R.samplePlan(searched(10)), [], 'the page already has all of it')
})

test('samplePlan: nothing for a search filtered to one currency or not sorted by price ascending', () => {
  const filtered = { query: { ...QUERY, filters: { trade_filters: { filters: { price: { option: 'chaos' } } } } }, sort: { price: 'asc' } }
  assert.deepEqual(R.samplePlan(searched(100, { body: filtered })), [])
  assert.deepEqual(R.samplePlan(searched(100, { body: { query: QUERY, sort: { price: 'desc' } } })), [])
  const either = { query: { ...QUERY, filters: { trade_filters: { filters: { price: { option: 'exalted_divine' } } } } }, sort: { price: 'asc' } }
  assert.equal(R.samplePlan(searched(100, { body: either })).length, 10, 'exalted_divine is a mode, not one currency')
})

test('the real Wombgift search: the sample alone decides when its chaos row already beats the top', () => {
  let s = first10(searched(100))                            // vaal 139… on top
  s = load(s, [[10, 'vaal', 146], [20, 'vaal', 149], [30, 'chaos', 16], [40, 'chaos', 18], [99, 'chaos', 22]])
  assert.equal(offer(s), 'chaos')                           // 16 chaos 1.46 div < 139 vaal 1.78 div
  assert.deepEqual(R.gapPlan(s, P), [], 'no fill-in fetch needed')
})

test('gapPlan: when the sampled row cannot decide, fetch the ids just before it, then decide', () => {
  let s = first10(searched(100))
  s = load(s, [[10, 'vaal', 146], [20, 'vaal', 149], [30, 'chaos', 19.2], [40, 'chaos', 20]])
  assert.equal(offer(s), null, '19.2 chaos (1.757 div) vs 139 vaal (1.781 div): 1.4%, undecided')
  assert.deepEqual(R.gapPlan(s, P), ['r21', 'r22', 'r23', 'r24', 'r25', 'r26', 'r27', 'r28', 'r29'])
  s = load(s, [[21, 'vaal', 149], [22, 'vaal', 150], [23, 'vaal', 150], [24, 'vaal', 150], [25, 'vaal', 150], [26, 'chaos', 15], [27, 'chaos', 15], [28, 'chaos', 16], [29, 'chaos', 16]])
  assert.equal(offer(s), 'chaos')
  assert.deepEqual(R.gapPlan(s, P), [])
})

test('gapPlan: nothing without prices, without the top row, or when no other currency was seen', () => {
  assert.deepEqual(R.gapPlan(load(first10(searched(100, { prices: null })), [[30, 'chaos', 19.2]]), null), [], 'no prices at all')
  assert.deepEqual(R.gapPlan(load(searched(100), [[30, 'chaos', 19.2]]), P), [], 'rank 0 not loaded')
  assert.deepEqual(R.gapPlan(load(first10(searched(100)), [[30, 'vaal', 160]]), P), [])
})

// Found proving it on the packaged app (2026-10-03): the window's address switches to the new search ~60 ms before
// the tap reports that search, so for a moment the page still holds the previous one (the Instant Buyout home's
// landing search) while the row already looks shown — and the sample went to the wrong search. The page counts as
// the row's only when its query is the one the row's link decodes to (a run search's slug is its query, byte-equal).
test('pageIsRows: the page\'s search must be the query the row\'s link decodes to', () => {
  const s = searched(100)
  assert.equal(R.pageIsRows(s, QUERY), true)
  assert.equal(R.pageIsRows(s, { ...QUERY, type: 'Other' }), false, 'the previous search still on the page')
  assert.equal(R.pageIsRows(s, { stats: QUERY.stats, type: QUERY.type, status: QUERY.status }), true, 'key order does not matter')
  assert.equal(R.pageIsRows(R.EMPTY, QUERY), false)
  assert.equal(R.pageIsRows(s, null), false)
})


// QA (2026-10-03): switching rows right after the click left the row half-done (no slug, a one-off query),
// because the saved search waited for the site's answer. A run search's slug IS its query, gzipped and
// base64url'd (byte-equal, measured), so the repriced slug is built here and saved at once.
test('encodeSlug: the slug the app builds decodes, through the app\'s own link reader, to the exact query', async () => {
  const { searchOfLink, tradeUrl } = await import('../src/lib/session.js')
  const q = JSON.parse(R.repriceQuery(BODY, 'chaos', P)).query
  const slug = await R.encodeSlug(q)
  assert.match(slug, /^H4sI[A-Za-z0-9_-]+$/, 'gzip, base64url, no padding')
  const back = await searchOfLink(tradeUrl({ type: 'search', slug }, 'Forbidden Rites'))
  assert.equal(JSON.stringify(back.query), JSON.stringify(q))
})

// QA (2026-10-03): ↻ right after a fresh search reloaded the trade home, not the row's search: the window's address
// was computed once per row and never again. Reloading recomputes it from the saved row.
test('the trade window\'s address is recomputed on a reload (↻), from the saved row', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/components/WorkspaceView.jsx', import.meta.url), 'utf8')
  const memo = src.slice(src.indexOf('const mountUrl = useMemo('), src.indexOf('const mountUrl = useMemo(') + 400)
  assert.match(memo, /\}, \[activeId, league, rerunTick, wvNonce\]\)/)
})

// Aggressive caching (owner, 2026-10-03: "5min ttl"): a search whose deeper listings were fetched in the last 5
// minutes is not fetched again — reopening the row, ↻, or running it again reuse what is known.
test('sampledRecently: the same search within 5 minutes needs no new fetch', () => {
  const sib = new Map()
  const t0 = 9_000_000
  const s = load(first10(searched(100)), [[30, 'chaos', 16]])
  assert.equal(R.sampledRecently(sib, 'Forbidden Rites', QUERY, t0), false)
  R.remember(sib, s, t0, P)
  assert.equal(R.sampledRecently(sib, 'Forbidden Rites', QUERY, t0 + 1000), false, 'rows the page loaded itself are not a sample')
  R.remember(sib, s, t0, P, { sampled: true })
  assert.equal(R.sampledRecently(sib, 'Forbidden Rites', QUERY, t0 + 4 * 60_000), true)
  assert.equal(R.sampledRecently(sib, 'Forbidden Rites', { ...QUERY, type: 'Other' }, t0 + 1000), false)
  assert.equal(R.sampledRecently(sib, 'Forbidden Rites', QUERY, t0 + 5 * 60_000 + 1), false)
  R.remember(sib, s, t0 + 60_000, P)
  assert.equal(R.sampledRecently(sib, 'Forbidden Rites', QUERY, t0 + 4 * 60_000), true, 'a later unsampled visit keeps the sample mark')
})

// Owner, 2026-10-03: drop previously triggered fetches when the user moves on. The hook cancels on a row switch,
// a reload, a hidden Workspace sub-tab and leaving the Trading tab.
test('the hook cancels waiting fetches when the user moves on; the Workspace knows when it is hidden', async () => {
  const { readFileSync } = await import('node:fs')
  const hook = readFileSync(new URL('../src/lib/useReprice.js', import.meta.url), 'utf8')
  assert.match(hook, /listingsCancel/)
  assert.match(hook, /\}, \[remountKey, visible\]\)/, 'cancel when the window remounts or hides')
  const tv = readFileSync(new URL('../src/components/TradingView.jsx', import.meta.url), 'utf8')
  assert.match(tv, /<WorkspaceView league=\{league\} visible=\{sub === 'workspace'\} \/>/)
})

// remember() takes the time the rows were seen, so evidence re-recorded later never looks newer than it is.
test('remember with an old "seen" time cannot make stale evidence fresh', () => {
  const sib = new Map()
  const t0 = 3_000_000
  const old = load(first10(searched(100)), [[30, 'chaos', 15]])
  R.remember(sib, old, t0, P)                                    // seen at t0
  R.remember(sib, old, t0, P)                                    // re-recorded later, still stamped t0
  const vaalOnly = page([['vaal', 139], ['vaal', 140]], { id: 'V9' })
  assert.equal(offer(vaalOnly, P, { siblings: sib, now: t0 + 5 * 60_000 + 1 }), null, 'no offer from 5-minute-old evidence')
})

// "Find cheapest" (owner, 2026-10-03): the check on demand for a page the automatic check cannot help — usually one
// filtered to a single currency. The page's search without its currency filter (the exalted-equivalent search) is
// run in the background; its listings become evidence for the same search, and the ordinary rule decides.
test('equivalentQuery drops only the currency filter (and empty groups left behind)', () => {
  const filtered = { ...QUERY, filters: { trade_filters: { filters: { price: { option: 'chaos', min: 10 }, fee: { max: 5 } } }, misc_filters: { filters: { corrupted: { option: 'false' } } } } }
  assert.deepEqual(R.equivalentQuery(filtered), { ...QUERY, filters: { trade_filters: { filters: { fee: { max: 5 } } }, misc_filters: { filters: { corrupted: { option: 'false' } } } } })
  assert.deepEqual(R.equivalentQuery({ ...QUERY, filters: { trade_filters: { filters: { price: { option: 'vaal' } } } } }), QUERY)
  assert.deepEqual(R.equivalentQuery(QUERY), QUERY)
  assert.notEqual(R.equivalentQuery(QUERY), QUERY, 'a copy, never the page\'s own object')
})

const recheckResult = (rows) => ({ ok: true, searchId: 'RC1', ids: rows.map((_, i) => `x${i}`), total: rows.length, rows: rows.map(([currency, amount], i) => ({ id: `x${i}`, amount, currency })) })
const chaosFiltered = { query: { ...QUERY, filters: { trade_filters: { filters: { price: { option: 'chaos' } } } } }, sort: { price: 'asc' } }

test('pageFromRecheck: the background search\'s listings decide a chaos-filtered page — vaal cheaper → offer vaal', () => {
  const sib = new Map(), t0 = 7_000_000
  const rc = R.pageFromRecheck(recheckResult([['vaal', 105], ['vaal', 110], ['chaos', 17]]), 'Forbidden Rites', QUERY, OPTIONS.price, P)
  R.remember(sib, rc, t0, P, { sampled: true })
  const chaosPage = page([['chaos', 17], ['chaos', 18]], { body: chaosFiltered, id: 'C2' })
  assert.equal(offer(chaosPage, P, { siblings: sib, now: t0 + 1000 }), 'vaal')
  assert.equal(R.sampledRecently(sib, 'Forbidden Rites', chaosFiltered.query, t0 + 1000), true, 'the same search now counts as checked')
})

test('pageFromRecheck: chaos already the cheapest → no offer (the strip says "Already cheapest")', () => {
  const sib = new Map(), t0 = 8_000_000
  R.remember(sib, R.pageFromRecheck(recheckResult([['vaal', 139], ['chaos', 15]]), 'Forbidden Rites', QUERY, OPTIONS.price, P), t0, P, { sampled: true })
  const chaosPage = page([['chaos', 15], ['chaos', 16]], { body: chaosFiltered, id: 'C3' })
  assert.equal(offer(chaosPage, P, { siblings: sib, now: t0 + 1000 }), null)
})

test('findState: one thing in the strip at a time', () => {
  assert.equal(R.findState({ shown: false, filtered: true }), null, 'not the row\'s own priced search: nothing')
  assert.equal(R.findState({ shown: true, filtered: true, offer: { currency: 'vaal' } }), 'reprice')
  assert.equal(R.findState({ shown: true, filtered: true, checking: true }), 'checking')
  assert.equal(R.findState({ shown: true, filtered: true, checked: true }), 'cheapest', 'checked on request, nothing cheaper')
  assert.equal(R.findState({ shown: true, filtered: true }), 'find')
  assert.equal(R.findState({ shown: true, filtered: true, checking: true, offer: { currency: 'vaal' } }), 'reprice', 'an offer wins')
})

// Owner, 2026-10-03: "The find cheapest button should only show up on pages where a price currency filter was applied.
// I.e. not exalted orb equivalent." The site's "Exalted/Divine" mode is not one currency either.
test('Find cheapest only on a page filtered to one currency', () => {
  assert.equal(R.findState({ shown: true, filtered: false }), null, 'Exalted Orb Equivalent: no button')
  assert.equal(R.findState({ shown: true, filtered: false, known: true }), null, 'and no note')
  assert.equal(R.findState({ shown: true, filtered: false, offer: { currency: 'vaal' } }), 'reprice', 'the swap still shows there')
  assert.equal(R.findState({ shown: true, filtered: true }), 'find')
  // The owner's Atziri's Disdain page (2026-10-03): repriced to Exalted moments ago, so the app already knows it is the
  // cheapest — a filtered page always answers: "Already cheapest", with no new request.
  assert.equal(R.findState({ shown: true, filtered: true, known: true }), 'cheapest')
  const q = (option) => ({ query: { ...QUERY, filters: { trade_filters: { filters: { price: option ? { option } : { max: 5 } } } } }, sort: { price: 'asc' } })
  assert.equal(R.currencyFiltered(q('chaos')), true)
  assert.equal(R.currencyFiltered(q('exalted_divine')), false)
  assert.equal(R.currencyFiltered(q(null)), false, 'a price range without a currency is still the exalted equivalent')
  assert.equal(R.currencyFiltered(BODY), false)
})

// QA (2026-10-03): a currency-filtered search with no results said "Already cheapest". With no listings in the filtered
// currency, the cheapest currency that HAS listings is the answer; with none anywhere, there is nothing to say.
test('a filtered search with no results: offer the cheapest currency that has listings, else nothing', () => {
  const sib = new Map(), t0 = 9_500_000
  R.remember(sib, R.pageFromRecheck(recheckResult([['vaal', 139], ['chaos', 15]]), 'Forbidden Rites', QUERY, OPTIONS.price, P), t0, P, { sampled: true })
  const exaltedEmpty = R.observe(R.observe(R.EMPTY, OPTIONS), { kind: 'search', wcId: 1, league: 'Forbidden Rites', id: 'E0', body: { query: { ...QUERY, filters: { trade_filters: { filters: { price: { option: 'exalted' } } } } }, sort: { price: 'asc' } }, ids: [], total: 0 }, P)
  assert.equal(offer(exaltedEmpty, P, { siblings: sib, now: t0 + 1000 }), 'chaos')
  assert.equal(offer(exaltedEmpty, P, { siblings: new Map(), now: t0 + 1000 }), null)
  assert.equal(R.findState({ shown: true, filtered: true, empty: true, known: true }), null, 'checked, nothing anywhere: no note')
  assert.equal(R.findState({ shown: true, filtered: true, empty: true }), 'find', 'not yet checked: the button')
})

// Review (2026-10-03): "Already cheapest" (and the button) only where the rule can judge the page: sorted by price,
// the site's price options known, the first listing priced — or no results at all.
test('judgeable: price-sorted, options known, and the top row priced (or no results)', () => {
  assert.equal(R.judgeable(page([['vaal', 10], ['chaos', 1]]), P), true)
  assert.equal(R.judgeable(page([['vaal', 10]], { body: { query: QUERY, sort: { 'stat.x': 'desc' } } }), P), false, 'a stat sort')
  const noOpts = R.observe(R.EMPTY, { kind: 'search', wcId: 1, league: 'L', id: 'N1', body: BODY, ids: ['r0'], total: 1 }, P)
  assert.equal(R.judgeable(noOpts, P), false, 'price options never seen')
  assert.equal(R.judgeable(page([['gold', 5]]), P), false, 'the top row has no price')
  const empty = R.observe(R.observe(R.EMPTY, OPTIONS), { kind: 'search', wcId: 1, league: 'L', id: 'E1', body: BODY, ids: [], total: 0 }, P)
  assert.equal(R.judgeable(empty, P), true, 'no results is judgeable')
  assert.equal(R.findState({ shown: true, filtered: true, judgeable: false, known: true }), null)
  assert.equal(R.findState({ shown: true, filtered: true, judgeable: false }), null, 'no button where the answer would be meaningless')
  assert.equal(R.findState({ shown: true, filtered: true, judgeable: true, known: true }), 'cheapest')
})

// Review: on a filtered page with no results, never offer the currency the page is already filtered to.
test('the empty-page offer never names the page\'s own currency', () => {
  const sib = new Map(), t0 = 9_700_000
  R.remember(sib, R.pageFromRecheck(recheckResult([['divine', 5], ['chaos', 60]]), 'L', QUERY, OPTIONS.price, P), t0, P, { sampled: true })
  const divineEmpty = R.observe(R.observe(R.EMPTY, OPTIONS), { kind: 'search', wcId: 1, league: 'L', id: 'D0', body: { query: { ...QUERY, filters: { trade_filters: { filters: { price: { option: 'divine', max: 1 } } } } }, sort: { price: 'asc' } }, ids: [], total: 0 }, P)
  assert.equal(offer(divineEmpty, P, { siblings: sib, now: t0 + 1000 }), 'chaos', 'not divine')
})

// Review: the automatic sample runs only on the window's own page (a page redrawn from the site's cache belongs to an
// earlier window — its rows could not land here); a cancelled sample is tried again later, a refusal is final.
test('sampleTarget and stepAfter', () => {
  const own = page([['vaal', 1]])
  assert.equal(R.sampleTarget(own, QUERY), own)
  assert.equal(R.sampleTarget(own, { ...QUERY, type: 'Other' }), null, 'the window shows another search')
  assert.equal(R.sampleTarget(R.EMPTY, QUERY), null)
  assert.equal(R.stepAfter({ ok: true, rows: [] }), 'done')
  assert.equal(R.stepAfter({ ok: false, error: 'cancelled' }), 'todo', 'moved away and back: try again')
  assert.equal(R.stepAfter({ ok: false, error: 'rate' }), 'done', 'the budget said no: not this search')
})
