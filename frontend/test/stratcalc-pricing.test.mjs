// Strat Calculator: a linked trade search prices the maps / a tablet line (owner bug report, 2026-10-03:
// "If I select a search and search in the window but don't put a link in and click 'use this search' it
// sets the cost to nothing"; it worked only once the cost currency matched the listings — maps priced in
// Vaal Orbs under an "Exalted Orb equivalent" filter, the picker on Chaos).
//
// No request leaves the test: a fake trade site answers at the one boundary where the app searches
// (`priceQuery`), and everything above it runs as the app runs it — the trade window following its search
// (lib/stratPricing.js windowSearch, fed the same events the window gets), "Use this search" / a pasted
// link (stratcalc link*), the pricing queue and its back-off (stratPricing nextPricing / priceFound /
// recordFound), and
// the costs (stratcalc tally). Expected, for every combination: the cost is the linked search's own
// listings, and the cost line's currency follows the search (owner: the search "should dictate what that
// currency override should be").
import test from 'node:test'
import assert from 'node:assert/strict'
const sc = await import('../src/lib/stratcalc.js')
const SP = await import('../src/lib/stratPricing.js')
const { searchOfLink, queryUrl } = await import('../src/lib/session.js')

const LEAGUE = 'Forbidden Rites'
// Divines per unit, as /api/strategy/calc serves them (backend stratcalc.divine_prices).
const PRICES = {
  divine: 1, exalted: 1 / 711, chaos: 66.5 / 711, vaal: 9.42 / 711, annul: 326 / 711, regal: 0.42 / 711,
  alch: 0.2 / 711, mirror: 5262, 'greater-chaos-orb': 193 / 711, 'perfect-exalted-orb': 2360 / 711, aug: 0.05 / 711,
}
const PICKER = ['chaos', 'exalted', 'divine', 'vaal', 'annul', 'regal', 'alch', 'mirror', 'greater-chaos-orb', 'perfect-exalted-orb']
// What the maps are listed in: one currency, or a mix (sellers price in whatever they like).
const LISTED_IN = [['vaal'], ['chaos'], ['exalted'], ['divine'], ['annul'], ['regal', 'alch'], ['exalted', 'chaos', 'divine'], ['vaal', 'exalted', 'chaos']]
const USES = [{ name: null, base: 'Breach Tablet', uses: 10 }]

// ---------------------------------------------------------------- the fake trade site
// The user's search carries a marker (`term`); anything else is the plain waystone/tablet market, priced
// differently, so a line linked to the wrong search prices visibly wrong. A price filter on one currency
// returns only listings in it; an "equivalent" filter returns every listing, cheapest (in exalted) first.
function market(currencies, scale) {
  const out = []
  for (let i = 0; i < 14; i++) {
    const cur = currencies[i % currencies.length]
    const ex = scale * (40 + i * 7)                                  // the listing's worth in exalted
    out.push({ amount: Math.max(1, Math.round(ex / (PRICES[cur] * 711))), currency: cur })
  }
  return out
}
function tradeSite(currencies) {
  const user = market(currencies, 1), plain = market(currencies, 3)
  const calls = []
  const priceQuery = async ({ query, league }) => {
    calls.push(query)
    assert.equal(league, LEAGUE)
    const q = query.query
    let rows = q.term === 'user' ? user : plain
    const opt = q.filters?.trade_filters?.filters?.price?.option
    if (opt && PRICES[opt]) rows = rows.filter(l => l.currency === opt)
    rows = [...rows].sort((a, b) => a.amount * PRICES[a.currency] - b.amount * PRICES[b.currency])
    return { ok: true, total: rows.length, listings: rows.slice(0, 10) }
  }
  return { priceQuery, calls, user }
}
// The price a line should get: its search's ten cheapest listings, averaged, in divines.
const expectedUnit = (rows, opt) => {
  const v = rows.filter(l => !opt || !PRICES[opt] || l.currency === opt).map(l => l.amount * PRICES[l.currency]).sort((a, b) => a - b).slice(0, 10)
  return v.reduce((a, b) => a + b, 0) / v.length
}
// The currency the line follows: the search's own price currency, else the one most of the listings it
// priced from (its ten cheapest) are in — the cheapest listing's currency breaking a tie.
const expectedCur = (rows, opt) => {
  if (opt && PRICES[opt]) return opt
  const top = rows.filter(l => PRICES[l.currency] > 0).sort((a, b) => a.amount * PRICES[a.currency] - b.amount * PRICES[b.currency]).slice(0, 10)
  const n = new Map(); for (const l of top) n.set(l.currency, (n.get(l.currency) || 0) + 1)
  let best = null; for (const [c, k] of n) if (best == null || k > n.get(best)) best = c
  return best
}

// The user's search: waystones (or a tablet) with a marker, priced under `opt` ("" = an equivalent filter).
const userSearch = (kind, opt) => ({
  query: {
    status: { option: 'securable' }, term: 'user',
    filters: {
      type_filters: { filters: { category: { option: kind === 'maps' ? 'map.waystone' : 'map.tablet' } } },
      trade_filters: { filters: { price: opt ? { option: opt } : { min: 1 } } },
    },
  },
  sort: { price: 'asc' },
})
const baseSearch = (kind) => ({ query: { status: { option: 'securable' }, filters: { type_filters: { filters: { category: { option: kind === 'maps' ? 'map.waystone' : 'map.tablet' } } } } } })

// The trade site's own address for a run search: a gzip slug of the query (what a saved search is).
async function gzipSlug(query) {
  const bytes = new Uint8Array(await new Response(new Blob([JSON.stringify(query)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const searchUrl = (slug) => `https://www.pathofexile.com/trade2/search/poe2/${encodeURIComponent(LEAGUE)}/${slug}`

// How the user's search reaches the line — the four ways the app offers.
const WAYS = {
  // a trade link pasted into the window's box (or picked from "Your searches")
  async paste(search) { return searchOfLink(queryUrl({ q: JSON.stringify(search) }, LEAGUE)) },
  // the window lands on the search's ?q= address, then "Use this search"
  async windowQ(search, kind) { return useWindow(kind, [{ kind: 'nav', search: await searchOfLink(queryUrl({ q: JSON.stringify(search) }, LEAGUE)) }]) },
  // the window lands on a gzip slug, then "Use this search"
  async windowGzip(search, kind) { return useWindow(kind, [{ kind: 'nav', search: await searchOfLink(searchUrl(await gzipSlug(search.query))) }]) },
  // the page searches (the app sees the page's own search) and lands on a short id it can't decode
  async windowShortId(search, kind) {
    return useWindow(kind, [{ kind: 'tap', body: search }, { kind: 'nav', search: await searchOfLink(searchUrl('Xk3pLm9QaZ')) }])
  },
}
// The window opens on the line's base search; each event moves it; "Use this search" takes what it holds.
function useWindow(kind, events) {
  let found = SP.windowSearch(null, { kind: 'open', search: baseSearch(kind) })
  for (const e of events) found = SP.windowSearch(found, e)
  return found
}

// A strat with 10 maps run, the cost currency on `pickerCur`, and one tablet line (any tablet, 1 slot).
function strat(pickerCur) {
  let d = sc.newStrat(sc.blankDoc(), { id: 's', name: 'S', now: 0 })
  d = sc.edit(d, 's', x => ({ ...x, maps: { ...x.maps, count: 10 } }), 0)
  d = sc.addTablet(d, 's', { id: 't', now: 0 })
  d = sc.setCostCur(d, 's', 'maps', pickerCur, 0)
  d = sc.editTablet(d, 's', 't', { cur: pickerCur }, 0)
  return d
}
const linkTo = (d, kind, search, now) => (kind === 'maps'
  ? sc.linkMaps(d, 's', { query: search, league: LEAGUE }, now)
  : sc.linkTablet(d, 's', 't', { query: search, league: LEAGUE }, now))

// The pricing queue, as the view runs it: take the next due search, ask the trade site, record.
async function priceAll(d, site, retryAt, now) {
  for (let i = 0; i < 6; i++) {
    const job = SP.nextPricing(sc.activeStrat(d), { now, retryAt, uses: USES })
    if (!job) break
    SP.started(retryAt, job, now)
    const res = await site.priceQuery({ query: job.query, league: LEAGUE })
    d = SP.recordFound(d, 's', job, SP.priceFound(job, res, PRICES), now)
  }
  return d
}

function check(d, kind, rows, opt, label) {
  const s = sc.activeStrat(d)
  const t = sc.tally(s, PRICES, 0, USES)
  const unit = expectedUnit(rows, opt)
  const line = kind === 'maps' ? s.maps : s.tablets.lines[0]
  assert.ok(line.link, `${label}: linked`)
  assert.ok(Number.isFinite(line.link.div), `${label}: priced (the cost is never left empty)`)
  assert.ok(Math.abs(line.link.div - unit) < 1e-9 * Math.max(1, unit), `${label}: priced from the linked search's listings ${line.link.div} vs ${unit}`)
  if (kind === 'maps') assert.ok(Math.abs(t.maps - 10 * unit) < 1e-6 * Math.max(1, unit), `${label}: maps cost ${t.maps}`)
  else assert.ok(Math.abs(t.tablets - 10 * (1 / 10) * unit) < 1e-6 * Math.max(1, unit), `${label}: tablets cost ${t.tablets}`)
  const cur = expectedCur(rows, opt)
  assert.equal(line.cur, cur, `${label}: the cost currency follows the search`)
  assert.ok(Math.abs(SP.shownPrice(line, PRICES) - unit / PRICES[cur]) < 1e-6 * Math.max(1, unit / PRICES[cur]), `${label}: the price box reads it in that currency`)
}

for (const kind of ['maps', 'tablet']) {
  for (const way of Object.keys(WAYS)) {
    test(`${kind} via ${way}: every picker currency × listing currencies × filter prices from the search`, async () => {
      let n = 0
      for (const pickerCur of PICKER) {
        for (const cur of LISTED_IN) {
          for (const opt of ['', cur[0]]) {
            const site = tradeSite(cur)
            const search = userSearch(kind, opt)
            const got = await WAYS[way](search, kind)
            assert.deepEqual(got?.query, search.query, `${way}: "Use this search" takes the search the user ran`)
            const retryAt = new Map()
            let d = linkTo(strat(pickerCur), kind, got, 1)
            d = await priceAll(d, site, retryAt, 1)
            check(d, kind, site.user, opt, `${kind}/${way}/picker ${pickerCur}/listed ${cur}/filter ${opt || 'equivalent'}`)
            n++
          }
        }
      }
      assert.equal(n, PICKER.length * LISTED_IN.length * 2)
    })
  }

  test(`${kind}: a line priced earlier and linked to a new search is priced again at once`, async () => {
    for (const pickerCur of PICKER) {
      for (const cur of LISTED_IN) {
        const site = tradeSite(cur)
        const retryAt = new Map()
        let d = linkTo(strat(pickerCur), kind, baseSearch(kind), 1)
        d = await priceAll(d, site, retryAt, 1)                       // the plain market, an hour's back-off
        const search = userSearch(kind, '')
        d = linkTo(d, kind, search, 2)
        SP.relinked(retryAt, kind === 'maps' ? 'maps' : 't')
        d = await priceAll(d, site, retryAt, 2)
        check(d, kind, site.user, '', `${kind}/relink/picker ${pickerCur}/listed ${cur}`)
      }
    }
  })
}

test('a search with no listings leaves the line linked and unpriced — never a 0 cost', async () => {
  const site = { priceQuery: async () => ({ ok: true, total: 0, listings: [] }) }
  const retryAt = new Map()
  let d = linkTo(strat('chaos'), 'maps', userSearch('maps', ''), 1)
  d = await priceAll(d, site, retryAt, 1)
  const m = sc.activeStrat(d).maps
  assert.equal(m.link.div, null)
  assert.equal(sc.tally(sc.activeStrat(d), PRICES, 0, USES).maps, null, 'unpriced, not free')
})

test('listings with no price yet are asked again in a minute, not an hour', () => {
  const retryAt = new Map()
  const job = { key: 'link:maps', linked: {} }
  SP.started(retryAt, job, 1000)
  const found = SP.priceFound(job, { ok: true, listings: [{ amount: 3, currency: 'mystery-orb' }] }, PRICES)
  assert.deepEqual(found, { retry: 60_000 })
  SP.retryLater(retryAt, job, found.retry, 2000)
  assert.equal(retryAt.get('link:maps'), 62_000)
})

test('listings in a currency with no price are skipped, the rest still price the line', async () => {
  const site = { priceQuery: async () => ({ ok: true, total: 3, listings: [{ amount: 5, currency: 'mystery-orb' }, { amount: 2, currency: 'divine' }, { amount: 4, currency: 'divine' }] }) }
  const retryAt = new Map()
  let d = linkTo(strat('chaos'), 'maps', userSearch('maps', ''), 1)
  d = await priceAll(d, site, retryAt, 1)
  const m = sc.activeStrat(d).maps
  assert.equal(m.link.div, 3)
  assert.equal(m.cur, 'divine')
})

test('a price still on its way for the old search never lands on the newly linked one', async () => {
  for (const kind of ['maps', 'tablet']) {
    const site = tradeSite(['exalted'])
    const retryAt = new Map()
    let d = linkTo(strat('chaos'), kind, baseSearch(kind), 1)
    const job = SP.nextPricing(sc.activeStrat(d), { now: 1, retryAt, uses: USES })
    SP.started(retryAt, job, 1)
    const late = site.priceQuery({ query: job.query, league: LEAGUE })      // asked for the old search…
    d = linkTo(d, kind, userSearch(kind, ''), 2)                             // …the user links a new one…
    SP.relinked(retryAt, kind === 'maps' ? 'maps' : 't')
    d = SP.recordFound(d, 's', job, SP.priceFound(job, await late, PRICES), 3)   // …and the old answer arrives
    const line = kind === 'maps' ? sc.activeStrat(d).maps : sc.activeStrat(d).tablets.lines[0]
    assert.equal(line.link.div, null, `${kind}: the old search's price is dropped`)
    d = await priceAll(d, site, retryAt, 3)
    check(d, kind, site.user, '', `${kind}/in-flight relink`)
  }
})

// ---------------------------------------------------------------- code review (2026-10-03)
test('a price typed while its search was on the way keeps the currency it was typed in', async () => {
  for (const kind of ['maps', 'tablet']) {
    const site = tradeSite(['divine'])
    const retryAt = new Map()
    let d = linkTo(strat('exalted'), kind, userSearch(kind, 'divine'), 1)
    const job = SP.nextPricing(sc.activeStrat(d), { now: 1, retryAt, uses: USES })
    SP.started(retryAt, job, 1)
    const late = site.priceQuery({ query: job.query, league: LEAGUE })
    d = kind === 'maps' ? sc.edit(d, 's', x => ({ ...x, maps: { ...x.maps, price: 50 } }), 2) : sc.editTablet(d, 's', 't', { price: 50 }, 2)
    d = SP.recordFound(d, 's', job, SP.priceFound(job, await late, PRICES), 3)
    const line = kind === 'maps' ? sc.activeStrat(d).maps : sc.activeStrat(d).tablets.lines[0]
    assert.deepEqual([line.price, line.cur], [50, 'exalted'], `${kind}: 50 exalted stays 50 exalted`)
  }
})

test('the search sets the currency when it is linked; a currency picked afterwards survives a refresh', async () => {
  const site = tradeSite(['vaal'])
  const retryAt = new Map()
  let d = linkTo(strat('chaos'), 'maps', userSearch('maps', ''), 1)
  d = await priceAll(d, site, retryAt, 1)
  assert.equal(sc.activeStrat(d).maps.cur, 'vaal', 'the search dictates it')
  d = sc.setCostCur(d, 's', 'maps', 'divine', 2)
  d = sc.refreshed ? sc.refreshed(d, 's') : d
  const job = { key: 'link:maps', maps: true, linked: sc.activeStrat(d).maps.link.query, query: sc.activeStrat(d).maps.link.query }
  d = SP.recordFound(d, 's', job, SP.priceFound(job, await site.priceQuery({ query: userSearch('maps', ''), league: LEAGUE }), PRICES), 3)
  assert.equal(sc.activeStrat(d).maps.cur, 'divine', 'the hourly refresh keeps the pick')
})

test('an answer for the old search sets no wait on the newly linked one', async () => {
  const site = tradeSite(['exalted'])
  const retryAt = new Map()
  let d = linkTo(strat('chaos'), 'maps', baseSearch('maps'), 1)
  const job = SP.nextPricing(sc.activeStrat(d), { now: 1, retryAt, uses: USES })
  SP.started(retryAt, job, 1)
  d = linkTo(d, 'maps', userSearch('maps', ''), 2)
  SP.relinked(retryAt, 'maps')
  SP.retryLater(retryAt, job, 60_000, 3)                 // the old search: listed, no prices
  d = await priceAll(d, site, retryAt, 3)
  check(d, 'maps', site.user, '', 'relinked while the old answer said "again in a minute"')
})

test('the currency vote counts exactly the listings the price was averaged from', () => {
  const listings = [{ amount: 2, currency: 'divine' }, { amount: 1, currency: 'divine' }, { amount: 900, currency: 'exalted' }]
  assert.deepEqual(sc.cheapestListings(listings, {}).map(l => l.currency), ['divine', 'divine'], 'no price table: divines still count, as in the average')
  assert.equal(SP.searchCurrency({ query: {} }, listings, {}), 'divine')
  assert.equal(sc.avgDiv(listings, {}), 1.5)
})

test('an "equivalent" price filter never names a currency, whatever the price table holds', () => {
  const q = { query: { filters: { trade_filters: { filters: { price: { option: 'exalted_divine' } } } } } }
  assert.equal(SP.searchCurrency(q, [{ amount: 1, currency: 'chaos' }], { ...PRICES, exalted_divine: 1 }), 'chaos')
})

test('"Use this search" on the search already linked keeps its price and spends no search', () => {
  const a = { query: { status: { option: 'securable' }, term: 'x', filters: { a: 1, b: 2 } }, sort: { price: 'asc' } }
  const reordered = { sort: { price: 'asc' }, query: { filters: { b: 2, a: 1 }, term: 'x', status: { option: 'securable' } } }
  assert.equal(SP.sameSearch(a, reordered), true)
  assert.equal(SP.sameSearch(a, userSearch('maps', '')), false)
  assert.equal(SP.sameSearch(null, a), false)
})
