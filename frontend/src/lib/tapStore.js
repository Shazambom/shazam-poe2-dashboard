// The trade tap's events (desktop/src/trade/tap.js), kept per trade window whether or not a view is listening yet.
// A reloaded window's search can finish before its <webview> reports its id to the view (seen in the packaged app,
// 2026-10-03), so the view never filters events itself: every event lands in its window's page here, and the view
// reads its own window's page. Pages are reprice.js pages; the price options are site-wide.
import { EMPTY, observe, SIBLING_TTL_MS } from './reprice.js'
import { canon } from './canon.js'

const RECENT_TTL_MS = SIBLING_TTL_MS   // owner, 2026-10-03: "5min ttl"
const keyOf = (league, query) => `${league}|${canon(query)}`

export function makeTapStore() {
  const pages = new Map()          // wcId → page
  // The last page seen for each exact search (league + query): re-showing a search the site ran moments ago is
  // often redrawn from the site's own cache with no request the tap could see (packaged app, 2026-10-03).
  const recent = new Map()
  const seenAt = new Map()         // wcId → when its current search was seen (evidence ages from then)
  const subs = new Set()
  let options = null
  let prices = null
  const notify = () => subs.forEach(f => { try { f() } catch {} })
  const get = (wcId) => pages.get(wcId) || EMPTY
  const keep = (page, now) => { if (page.search) recent.set(keyOf(page.search.league, page.search.body?.query), { page, at: now }) }

  return {
    ingest(evt, latest = prices, now = Date.now()) {
      if (!evt || evt.wcId == null) return
      if (evt.kind === 'options') options = evt.price
      if (evt.kind === 'search') seenAt.set(evt.wcId, now)
      let page = get(evt.wcId)
      if (evt.kind === 'search' && !page.options && options) page = observe(page, { kind: 'options', price: options })
      page = observe(page, evt, latest)
      pages.set(evt.wcId, page)
      if (evt.kind !== 'options') keep(page, now)
      notify()
    },
    // Rows the app fetched itself for a window's search (the reprice sample); rows for another search are dropped.
    merge(wcId, searchId, rows, now = Date.now()) {
      const page = observe(get(wcId), { kind: 'fetch', searchId, rows })
      pages.set(wcId, page)
      keep(page, now)
      notify()
    },
    // The first price table a page gets is kept (no flicker); a page that arrived before any prices takes this one.
    setPrices(P) {
      prices = P
      for (const [wcId, page] of pages) if (page.search && !page.prices) pages.set(wcId, { ...page, prices: P })
      notify()
    },
    pageOf: get,
    seenAtOf: (wcId) => seenAt.get(wcId) ?? null,
    recentFor(league, query, now = Date.now()) {
      const e = query ? recent.get(keyOf(league, query)) : null
      return e && now - e.at <= RECENT_TTL_MS ? e.page : null
    },
    drop(wcId) { pages.delete(wcId); seenAt.delete(wcId) },
    // Pages whose search was seen in the last 5 minutes, with that time: the only ones that may be re-recorded as
    // evidence (an old window's page re-stamped as new made stale listings look fresh; drive, 2026-10-03).
    freshPages(now = Date.now()) {
      const out = []
      for (const [wcId, at] of seenAt) { const page = pages.get(wcId); if (page?.search && now - at <= RECENT_TTL_MS) out.push({ wcId, page, at }) }
      return out
    },
    subscribe(f) { subs.add(f); return () => subs.delete(f) },
  }
}
