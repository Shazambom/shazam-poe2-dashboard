// Strat Calculator: how a linked trade search prices the maps or a tablet line. The trade window
// (TradeBuilder) and the pricing queue (StratCalcView) call these (the queue's back-offs live in the
// view's `retryAt` Map, which started/relinked/retryLater update), and test/stratcalc-pricing.test.mjs
// drives them against a fake trade site at the one boundary where a search leaves the app (`priceQuery`).
import * as sc from './stratcalc.js'
import { fullTabletQuery, uniqueQuery, waystonePriceQuery } from './regex/trade.js'
import { canon } from './canon.js'
import { priceOption } from './reprice.js'

// The search the trade window holds. `open`: the search it opened on (kept until it moves); `nav`: its
// address moved and decodes to `search` (null when it can't be read); `tap`: the page itself ran a search (the trade tap's `body`) — the surest read, since a run search can
// land on a short id its address doesn't carry.
export function windowSearch(found, e) {
  if (e.kind === 'open') return found ?? e.search ?? null
  if (e.kind === 'nav') return e.search ?? found
  if (e.kind === 'tap') return e.body?.query && typeof e.body.query === 'object' ? { query: e.body.query, ...(e.body.sort ? { sort: e.body.sort } : {}) } : found
  return found
}

// The pricing queue's key for a line: unique rows by their row key, linked lines as link:<id>.
export const linkKey = (lineId) => `link:${lineId}`
const waiting = (retryAt, key, now) => now < (retryAt.get(key) ?? 0)

// The next search the strat needs priced (unique floors first, then tablet lines, then the maps), or null.
export function nextPricing(s, { now, retryAt, uses }) {
  const r = [...s.loot, ...s.fixed].find(x => sc.needsFloor(x, now) && !waiting(retryAt, sc.rowKey(x), now))
  if (r) return { key: sc.rowKey(r), row: r, query: uniqueQuery(r.name, r.base) }
  const l = sc.lines(s).find(x => sc.needsLinkPrice(x, now) && !waiting(retryAt, linkKey(x.id), now) && sc.usesOf(x, uses) != null)
  if (l) return { key: linkKey(l.id), line: l, linked: l.link.query, query: fullTabletQuery(l.link.query, sc.usesOf(l, uses)) }
  if (sc.needsLinkPrice(s.maps, now) && !waiting(retryAt, linkKey('maps'), now)) return { key: linkKey('maps'), linked: s.maps.link.query, query: waystonePriceQuery(s.maps.link.query) }
  return null
}

// A search is being asked: it is not asked again for an hour (unless its answer says sooner).
export const started = (retryAt, job, now) => { job.mark = now + sc.FLOOR_TTL_MS; retryAt.set(job.key, job.mark) }

// Its answer says "again in `ms`" (listings with no price yet, a rate limit) — unless the line was linked
// to another search meanwhile (relinked cleared the mark): that wait is not the new search's.
export const retryLater = (retryAt, job, ms, now) => { if (retryAt.get(job.key) === job.mark) retryAt.set(job.key, now + ms) }

// "Use this search" on the search the line already holds (keys in any order): nothing to relink.
export const sameSearch = (a, b) => !!a?.query && !!b?.query && canon(a.query) === canon(b.query)

// A line was linked to a new search: price it now, whatever the old search's back-off said.
export const relinked = (retryAt, lineId) => { retryAt.delete(linkKey(lineId)) }

// The currency a linked line follows (owner: the search "should dictate what that currency override
// should be"): the search's own price currency when it names one with a price, else the currency most
// of the listings it was priced from are in (the cheapest first, so it breaks a tie).
export function searchCurrency(query, listings, prices) {
  const opt = priceOption(query)
  if (opt && prices[opt] > 0) return opt
  const n = new Map()
  for (const l of sc.cheapestListings(listings, prices)) n.set(l.currency, (n.get(l.currency) || 0) + 1)
  let best = null
  for (const [c, k] of n) if (best == null || k > n.get(best)) best = c
  return best
}

// What the trade site's answer for `job` found: { div, cur } (a unique's floor, or a linked search's
// average and the currency the line follows), or { retry } ms when it listed things with no price yet.
export function priceFound(job, res, prices) {
  if (!res?.ok) return {}
  const div = job.row ? sc.floorDiv(res.listings, prices) : sc.avgDiv(res.listings, prices)
  if (div == null) return res.listings?.length ? { retry: 60_000 } : {}
  return { div, cur: job.row ? null : searchCurrency(job.query, res.listings, prices) }
}

// The doc with a found price recorded on the job's row or line — unchanged when nothing was found, or
// when the line was linked to another search while this one was being priced (that answer is not its).
export function recordFound(doc, sid, job, { div, cur }, now) {
  if (div == null) return doc
  if (job.row) return sc.recordFloor(doc, sid, job.key, div, now)
  const s = doc.strats.find(x => x.id === sid)
  const line = !s ? null : job.line ? sc.lines(s).find(l => l.id === job.line.id) : s.maps
  if (!line?.link || line.link.query !== job.linked) return doc
  if (job.line) return sc.recordLinkPrice(doc, sid, job.line.id, div, now, cur)
  return sc.recordMapsPrice(doc, sid, div, now, cur)
}

// What a linked line's price box shows: the found price in the line's currency (NaN when it can't).
export const shownPrice = (x, prices) => (x.link?.div != null && prices[x.cur] > 0 ? x.link.div / prices[x.cur] : NaN)
