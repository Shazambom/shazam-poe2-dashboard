// Trading → Workspace "Reprice in <currency>" (docs/reprice-design.md): the trade tap's view of this window's
// page (desktop/src/trade/tap.js) → at most one offer; apply() replaces the saved search with the repriced one,
// with a 10 s undo. The rules are in reprice.js; this only wires events, prices, the store and telemetry.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, undoToast } from './api.js'
import { diag } from './diag.js'
import { useWorkspace } from './workspaceStore.js'
import { verdict, remember, applies, repriceQuery, ranRepriced, samplePlan, gapPlan, pageIsRows, encodeSlug, sampledRecently, equivalentQuery, pageFromRecheck, findState, siblingKey, currencyFiltered, judgeable, sampleTarget, stepAfter } from './reprice.js'
import { makeTapStore } from './tapStore.js'
import { searchOfLink } from './session.js'

const SIBLINGS = new Map()       // the same search under other price filters (memory only, 5 minutes)
const PRICES_TTL_MS = 5 * 60_000
// Every tap event lands in its window's page at once, listened to or not: a reloaded window's search can finish
// before its <webview> reports its id to this view (packaged app, 2026-10-03).
const TAP = makeTapStore()
let prices = { P: null, at: 0 }
let tapOn = false

function loadPrices() {
  if (prices.P && Date.now() - prices.at < PRICES_TTL_MS) return
  prices.at = Date.now()
  api.stratPrices().then(r => {
    if (!r?.prices || !Object.keys(r.prices).length) return
    prices = { P: r.prices, at: Date.now() }
    TAP.setPrices(r.prices)
    for (const { page, at } of TAP.freshPages()) remember(SIBLINGS, page, at, r.prices)   // rows that loaded before the prices did, aged from when they were seen
  }).catch(() => { prices.at = 0 })
}

function listen() {
  const onTap = window.poe2desktop?.trade?.onTap
  if (tapOn || !onTap) return
  tapOn = true
  onTap((e) => {
    if (e?.wcId == null) return
    if (e.kind === 'search') loadPrices()
    TAP.ingest(e, prices.P)
    if (e.kind === 'fetch') remember(SIBLINGS, TAP.pageOf(e.wcId), TAP.seenAtOf(e.wcId) ?? Date.now(), prices.P)   // evidence ages from the search
  })
}

export function useReprice({ wv, node, navUrl, inHistory, remountKey, league, visible = true }) {
  const offered = useRef(null)    // the search id an offer was last logged for
  const verify = useRef(null)     // { currency, after: search id }: the next search should filter on it
  const deeper = useRef({ id: null, sample: 'todo', gap: 'todo' })   // per search: the sample, then one fill-in
  const [tick, setTick] = useState(0)
  const [checking, setChecking] = useState(null)   // the search key a "Find cheapest" is running for

  useEffect(() => { listen(); return TAP.subscribe(() => setTick(t => t + 1)) }, [])
  // Moving on (another row, ↻, a hidden sub-tab, leaving Trading) drops every fetch still waiting, so the new
  // search gets the room (owner, 2026-10-03).
  useEffect(() => () => { window.poe2desktop?.trade?.listingsCancel?.() }, [remountKey, visible])

  let wcId = null
  try { wcId = wv.current?.getWebContentsId() ?? null } catch {}
  const own = wcId == null ? null : TAP.pageOf(wcId)
  // A window that is gone (another row, ↻) leaves the store: its rows are not evidence any more.
  useEffect(() => (wcId == null ? undefined : () => TAP.drop(wcId)), [wcId])

  // The row's own query, from its link (a run search's slug is its query): the page counts only once it holds it.
  const [rowQuery, setRowQuery] = useState(null)
  useEffect(() => {
    let live = true
    setRowQuery(null)
    searchOfLink(navUrl || '').then(j => { if (live) setRowQuery(j?.query || null) }).catch(() => {})
    return () => { live = false }
  }, [navUrl])
  // The window's own page, or — when the site redrew a search it ran moments ago from its own cache, with no
  // request the tap could see — the last page seen for that exact search (5 minutes).
  const page = own && pageIsRows(own, rowQuery) ? own : (rowQuery && TAP.recentFor(league, rowQuery)) || own
  const shown = !!page && visible && applies({ node, inHistory, navUrl }) && pageIsRows(page, rowQuery)
  const offer = useMemo(() => (shown ? verdict(page, prices.P, { siblings: SIBLINGS }) : null), [tick, shown, page])

  // Beta telemetry: did the page run the repriced search?
  useEffect(() => {
    const v = verify.current, s = page?.search
    if (v && s && s.id !== v.after) { diag('ws', `reprice-verify ${ranRepriced(s.body?.query, v.currency) ? 'ok' : 'mismatch'}`); verify.current = null }
  }, [page])

  // Search once, click once: look deeper than the page has loaded, with ids the search already returned
  // (trade/listings.js, budgeted, headroom only; never a new search). Only for the row's own search, once per search.
  useEffect(() => {
    const target = sampleTarget(own, rowQuery)   // only the window's own page (review 2026-10-03)
    const s = target?.search
    const fetchIds = window.poe2desktop?.trade?.listings
    if (!shown || !s || !fetchIds) return
    if (deeper.current.id !== s.id) deeper.current = { id: s.id, sample: 'todo', gap: 'todo' }
    const d = deeper.current
    const run = (ids, step) => {
      d[step] = 'pending'
      fetchIds({ league: s.league, searchId: s.id, ids }).then((r) => {
        d[step] = stepAfter(r)   // a cancel (moved away and back) is tried again; a refusal is final
        if (!r?.ok) { if (r?.error !== 'cancelled') diag('ws', `reprice-${step} fail=${r?.error}`); return }
        TAP.merge(wcId, s.id, r.rows)
        remember(SIBLINGS, TAP.pageOf(wcId), TAP.seenAtOf(wcId) ?? Date.now(), prices.P, { sampled: true })
      }).catch(() => { d[step] = 'done' })   // an IPC failure: give up on this search
    }
    if (d.sample === 'todo' && sampledRecently(SIBLINGS, s.league, s.body?.query)) { d.sample = 'done'; d.gap = 'done'; return }   // cached
    if (d.sample === 'todo') {
      const ids = samplePlan(target)
      if (ids.length) run(ids, 'sample'); else d.sample = 'done'
      return
    }
    const top = Object.values(target.rows).find(r => r.rank === 0)
    if (d.sample === 'done' && d.gap === 'todo' && top && (target.prices || prices.P)) {
      const ids = gapPlan(target, prices.P)
      if (ids.length) run(ids, 'gap'); else d.gap = 'done'
    }
  }, [tick, shown, own, rowQuery])

  useEffect(() => {
    const id = page?.search?.id
    if (offer && id && offered.current !== id) {
      offered.current = id
      diag('ws', `reprice-offer lead=${offer.lead} best=${offer.currency} gap=${Math.round(offer.gap * 100)}%`)
    }
  }, [offer])

  const apply = useCallback(async () => {
    const p = page
    if (!offer || !node || !p?.search) return
    const q = repriceQuery(p.search.body, offer.currency, p.prices || prices.P)
    const slug = await encodeSlug(JSON.parse(q).query)
    const prev = useWorkspace.getState().repriceSearch(node.id, { slug, q })
    if (!prev) return
    verify.current = { currency: offer.currency, after: p.search.id }
    diag('ws', `reprice-click to=${offer.currency}`)
    undoToast('ws-reprice', `Repriced “${node.name}” in ${offer.text}`, () => useWorkspace.getState().restoreSearch(node.id, prev))
  }, [offer, node, page])

  // "Find cheapest" (owner, 2026-10-03): the check on demand — the page's search without its currency filter, run in
  // the background (desktop trade:recheck: one budgeted search + two fetches); its listings become evidence for this
  // search and the ordinary rule decides. Moving on cancels it (listingsCancel).
  const key = page?.search ? siblingKey(page.search.league, page.search.body?.query) : null
  const find = useCallback(async () => {
    const s = page?.search
    const recheck = window.poe2desktop?.trade?.recheck
    if (!s || !recheck || checking) return
    const k = siblingKey(s.league, s.body?.query)
    setChecking(k)
    const t0 = Date.now()
    const r = await recheck({ league: s.league, query: equivalentQuery(s.body?.query) }).catch(() => null)
    setChecking(null)
    if (!r?.ok) { if (r?.error !== 'cancelled') diag('ws', `reprice-find fail=${r?.error} ms=${Date.now() - t0}`); return }
    remember(SIBLINGS, pageFromRecheck(r, s.league, s.body?.query, page.options, prices.P), Date.now(), prices.P, { sampled: true })
    setTick(t => t + 1)
    diag('ws', `reprice-find rows=${r.rows.length} ms=${Date.now() - t0}`)   // how long the user saw "Checking…"
  }, [page, checking])
  const known = key != null && sampledRecently(SIBLINGS, page.search.league, page.search.body?.query)
  const state = findState({ shown, filtered: !!page?.search && currencyFiltered(page.search.body), judgeable: !!page && judgeable(page, prices.P), empty: !!page?.search && !page.search.ids?.length, offer, checking: checking != null && checking === key, known })

  return { offer, apply, state, find }
}
