// Trading → Workspace: "Reprice in <currency>" (owner, 2026-10-02; design docs/reprice-design.md). The trade
// site sorts "cheapest first" by its own exalted-equivalent rates, which can disagree with the market. When the
// listing a search shows first is not the cheapest the page has loaded — at Arbiter's rates (divines per unit,
// /api/strategy/calc?prices=1), by more than TAU — offer to re-run it priced in the cheapest currency. Within one
// currency the site's order is exact, so each currency's first loaded row is its minimum; the site's own rates
// are never estimated. Fed by the trade tap (desktop/src/trade/tap.js); pure, so the view only renders it.
import { canon } from './canon.js'
import { INSTANT_BUYOUT } from './regex/trade.js'
import { parseTradeUrl } from './session.js'

export const TAU = 0.05                  // a gap under 5% is rate noise
export const SIBLING_TTL_MS = 5 * 60_000   // owner, 2026-10-03: "5min ttl" — evidence and samples are reused this long

// One window's page: the site's price options, its current search (rank by result id), the rows loaded so
// far, and the price table taken when the search arrived (so a later poll cannot make the offer flicker).
export const EMPTY = Object.freeze({ options: null, search: null, rank: null, rows: {}, prices: null })

export function observe(page, evt, prices = null) {
  if (evt?.kind === 'options') return { ...page, options: evt.price }
  if (evt?.kind === 'search') {
    const rank = Object.fromEntries((evt.ids || []).map((id, i) => [id, i]))
    return { ...EMPTY, options: page.options, search: { id: evt.id, league: evt.league, body: evt.body, ids: evt.ids || [] }, rank, prices }
  }
  if (evt?.kind === 'fetch' && page.search && evt.searchId === page.search.id) {
    const rows = { ...page.rows }
    for (const r of evt.rows || []) if (page.rank[r.id] != null) rows[r.id] = { ...r, rank: page.rank[r.id] }
    return { ...page, rows }
  }
  return page
}

const sortedRows = (page) => Object.values(page.rows).sort((a, b) => a.rank - b.rank)
const priced = (P, c) => P?.[c] > 0

// Each currency's smallest loaded amount (rows the site can filter and Arbiter can price).
function minsOf(page, P) {
  const ok = new Set((page.options || []).map(o => o.id))
  const m = {}
  for (const r of sortedRows(page)) {
    if (!(r.amount > 0) || !priced(P, r.currency) || !ok.has(r.currency)) continue
    if (m[r.currency] == null || r.amount < m[r.currency]) m[r.currency] = r.amount
  }
  return m
}

// null, or { currency, text, lead, gap } — the currency to reprice in, named with the site's own option text.
export function verdict(page, latest, { siblings = null, now = Date.now() } = {}) {
  const P = page.prices || latest
  const body = page.search?.body
  if (!P || !page.options || !body || canon(body.sort) !== canon({ price: 'asc' })) return null
  const sib = siblings && lookup(siblings, siblingKey(page.search.league, body.query), now)
  // A search with no results (e.g. filtered to a currency nobody lists in): the cheapest currency that has listings.
  if (!page.search.ids?.length) {
    const own = body.query?.filters?.trade_filters?.filters?.price?.option   // never "reprice" into the page's own currency
    let b = null
    for (const [c, m] of Object.entries(sib || {})) if (c !== own && priced(P, c) && (!b || m * P[c] < b.v)) b = { c, v: m * P[c] }
    return b && { currency: b.c, text: page.options.find(o => o.id === b.c)?.text || b.c, lead: null, gap: null }
  }
  const top = page.rows && sortedRows(page)[0]
  if (!top || top.rank !== 0 || !priced(P, top.currency)) return null    // what the user sees first, priced
  const mins = minsOf(page, P)
  for (const [c, m] of Object.entries(sib || {})) if (priced(P, c) && (mins[c] == null || m < mins[c])) mins[c] = m
  let best = null
  for (const [c, m] of Object.entries(mins)) if (!best || m * P[c] < best.v) best = { c, v: m * P[c] }
  if (!best || best.c === top.currency || top.amount * P[top.currency] < best.v * (1 + TAU)) return null
  // lead and gap feed beta telemetry only; the view shows the action and its unit, never the reasoning
  return { currency: best.c, text: page.options.find(o => o.id === best.c)?.text || best.c, lead: top.currency, gap: (top.amount * P[top.currency]) / best.v - 1 }
}

// "Search once, click once" (owner, 2026-10-02): a search returns up to 100 ids but the page loads only the first
// 10, and the cheap currency can sit deeper (the real Wombgift search: chaos from rank 26 under vaal 139–150). The
// app fetches ids the search already returned (desktop/src/trade/listings.js; never a new search):
const PAGE = 10
const sortsByPrice = (body) => canon(body?.sort) === canon({ price: 'asc' })
// The one currency a search's price filter names, or null ("Exalted Orb equivalent" names none).
export const priceOption = (body) => { const o = body?.query?.filters?.trade_filters?.filters?.price?.option; return o && o !== 'exalted_divine' ? o : null }
export const currencyFiltered = (body) => !!priceOption(body)

// 1. a sample — every 10th rank past the first page, and the last — skipping rows already loaded.
export function samplePlan(page) {
  const s = page.search
  if (!s || !sortsByPrice(s.body) || currencyFiltered(s.body) || s.ids.length <= PAGE) return []
  const want = []
  for (let r = PAGE; r < s.ids.length; r += PAGE) want.push(r)
  if (want[want.length - 1] !== s.ids.length - 1) want.push(s.ids.length - 1)
  return want.map(r => s.ids[r]).filter(id => !page.rows[id]).slice(0, PAGE)
}

// 2. only when the sample cannot decide: the unloaded ids just before the first loaded row of the most promising
// other currency — where that currency's true minimum sits (the site's order is exact within a currency).
export function gapPlan(page, latest) {
  const P = page.prices || latest
  const s = page.search
  const top = s && sortedRows(page)[0]
  if (!P || !top || top.rank !== 0 || !priced(P, top.currency) || verdict(page, latest)) return []
  const firsts = new Map()
  for (const r of sortedRows(page)) if (r.currency !== top.currency && !firsts.has(r.currency)) firsts.set(r.currency, r)
  const ok = new Set((page.options || []).map(o => o.id))
  const best = [...firsts.values()].filter(r => priced(P, r.currency) && ok.has(r.currency))
    .sort((a, b) => a.amount * P[a.currency] - b.amount * P[b.currency])[0]
  if (!best) return []
  const gap = []
  for (let r = best.rank - 1; r > 0 && !page.rows[s.ids[r]]; r--) gap.unshift(s.ids[r])
  return gap.slice(-(PAGE - 1))
}

// When the chip may show at all: a saved search selected that is neither live nor a History row,
// and the trade window showing that very search — not the Instant Buyout home landing or an edited search not yet
// captured, whose evidence would be written over the wrong row.
export function applies({ node, inHistory, navUrl }) {
  if (!node || node.kind !== 'search' || node.live || inHistory || !node.slug) return false
  const p = parseTradeUrl(navUrl || '')
  return !!p && p.type === 'search' && !p.live && p.slug === node.slug
}

// Sibling evidence: the same search under any price filter (the price filter and key order ignored), so a page
// filtered to one currency can know another is cheaper from an earlier page of that search. Memory only.
export const siblingKey = (league, query) => `${league}|${canon(equivalentQuery(query))}`

// The search without its currency filter — what the site sorts by Exalted Orb Equivalent. A copy; groups left
// empty are dropped.
export function equivalentQuery(query) {
  const q = structuredClone(query || {})
  const tf = q.filters?.trade_filters
  if (tf?.filters) {
    delete tf.filters.price
    if (!Object.keys(tf.filters).length) delete q.filters.trade_filters
    if (!Object.keys(q.filters).length) delete q.filters
  }
  return q
}

// "Find cheapest" (owner, 2026-10-03): the background search's answer (desktop trade:recheck — its ids and the
// listings of its first ten and a sample of the rest) as a page, so its evidence feeds the ordinary rule.
export function pageFromRecheck(result, league, query, options, prices) {
  let p = observe(EMPTY, { kind: 'options', price: options || [] })
  p = observe(p, { kind: 'search', id: result.searchId, league, body: { query: equivalentQuery(query), sort: { price: 'asc' } }, ids: result.ids || [] }, prices)
  return observe(p, { kind: 'fetch', searchId: result.searchId, rows: result.rows || [] })
}

// What the strip shows — one thing at a time (owner, 2026-10-03). The swap button wins anywhere. Only a page filtered
// to one currency gets the rest: "Checking…" while a check runs, "Already cheapest" when the app knows (a check the
// user asked for, or the automatic check — e.g. right after a reprice), else the "Find cheapest" button.
export function findState({ shown, filtered, judgeable = true, empty, offer, checking, checked, known }) {
  if (!shown) return null
  if (offer) return 'reprice'
  if (!filtered || !judgeable) return null   // no answer the rule could stand behind: no button, no note (review 2026-10-03)
  if (checking) return 'checking'
  if (checked || known) return empty ? null : 'cheapest'   // nothing listed anywhere: nothing to say (QA 2026-10-03)
  return 'find'
}

// `latest`: the current price table, for a page whose search arrived before any prices were loaded.
// `sampled`: the app fetched this search's deeper listings (samplePlan/gapPlan), so they need not be fetched again.
export function remember(map, page, now = Date.now(), latest = null, { sampled = false } = {}) {
  if (!page.search) return
  const key = siblingKey(page.search.league, page.search.body?.query)
  const prevEntry = map.get(key)
  const fresh = prevEntry && now - prevEntry.at <= SIBLING_TTL_MS
  const mins = { ...(fresh ? prevEntry.mins : {}) }
  for (const [c, m] of Object.entries(minsOf(page, page.prices || latest))) if (mins[c] == null || m < mins[c]) mins[c] = m
  const wasSampled = fresh && prevEntry.sampled
  map.set(key, { mins, at: wasSampled && !sampled ? prevEntry.at : now, sampled: sampled || !!wasSampled })
}

// A search whose deeper listings were fetched in the last 5 minutes: no new fetch (reopen, ↻, run again).
export const sampledRecently = (map, league, query, now = Date.now()) => { const e = map.get(siblingKey(league, query)); return !!e?.sampled && now - e.at <= SIBLING_TTL_MS }

function lookup(map, key, now) {
  const e = map.get(key)
  return e && now - e.at <= SIBLING_TTL_MS ? e.mins : null
}

// Round outward to 3 significant figures, so a converted bound never excludes what the old one allowed.
function outward(x, up) {
  if (!(x > 0)) return x
  const k = 10 ** (Math.floor(Math.log10(x)) - 2)
  return Number(((up ? Math.ceil(x / k - 1e-9) : Math.floor(x / k + 1e-9)) * k).toPrecision(12))
}

// The page's own search, priced in `currency`: Instant Buyout, cheapest first, the trade-filter group on, an
// existing min/max converted into the new currency (no option = the site's Exalted Orb Equivalent; a unit we
// cannot price drops the bounds). Every other key keeps its bytes. Returns the query string for `?q=`.
export function repriceQuery(body, currency, P) {
  const query = structuredClone(body.query || {})
  query.status = { ...INSTANT_BUYOUT }
  const tf = query.filters?.trade_filters || {}
  const old = tf.filters?.price || {}
  const from = old.option && old.option !== 'exalted_divine' ? old.option : 'exalted'
  const f = priced(P, from) && priced(P, currency) ? P[from] / P[currency] : null
  const price = { option: currency }
  if (f != null && old.option !== currency) {
    if (old.min != null) price.min = outward(old.min * f, false)
    if (old.max != null) price.max = outward(old.max * f, true)
  } else if (old.option === currency) {
    if (old.min != null) price.min = old.min
    if (old.max != null) price.max = old.max
  }
  query.filters = { ...query.filters, trade_filters: { ...tf, disabled: false, filters: { ...tf.filters, price } } }
  return JSON.stringify({ ...body, query, sort: { price: 'asc' } })
}

// Did the page run the repriced search? The site re-serializes filters in its own shape, so this checks what the
// reprice decides (Instant Buyout, the price option), not bytes. Beta telemetry only.
export const ranRepriced = (query, currency) =>
  query?.status?.option === INSTANT_BUYOUT.option && query?.filters?.trade_filters?.filters?.price?.option === currency

// The page holds the row's own search: its query is the one the row's link decodes to (a run search's slug is its
// query, byte-equal; key order ignored). The window's address can switch ~60 ms before the tap reports the new
// search, and until then the page still holds the previous one.
export const pageIsRows = (page, rowQuery) => !!page.search && !!rowQuery && canon(page.search.body?.query) === canon(rowQuery)

// A run search's slug is its query, gzipped and base64url'd (searchOfLink reads it back; byte-equal to what the page
// POSTs). Built here so the repriced search is saved at once, never waiting on the site (QA, 2026-10-03).
export async function encodeSlug(query) {
  const gz = new Uint8Array(await new Response(new Blob([JSON.stringify(query)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
  let bin = ''
  for (const b of gz) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// The rule can judge this page: sorted by price, the site's price options known, and the listing shown first priced —
// or no results at all. Elsewhere neither "Already cheapest" nor "Find cheapest" may show (review, 2026-10-03).
export function judgeable(page, latest) {
  const P = page.prices || latest
  if (!page.search || !page.options || canon(page.search.body?.sort) !== canon({ price: 'asc' })) return false
  if (!page.search.ids?.length) return true
  const top = sortedRows(page)[0]
  return !!top && top.rank === 0 && priced(P, top.currency)
}

// The automatic sample runs only on the window's own page: a page redrawn from the site's cache belongs to an earlier
// window, and rows fetched for it could not land here.
export const sampleTarget = (own, rowQuery) => (own && pageIsRows(own, rowQuery) ? own : null)

// After a sample or fill-in fetch: a cancel (the user moved away and back) is tried again; a budget refusal is final.
export const stepAfter = (r) => (!r?.ok && r?.error === 'cancelled' ? 'todo' : 'done')
