import { ignoredError } from '../lib/ignoredError.js'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/shallow'
import { api, bus, copyText, fmt, toast, undoToast } from '../lib/api.js'
import { useStatus, ensureSettings } from '../lib/statusStore.js'
import { useSync } from '../lib/syncStore.js'
import { useWorkspace, loadWorkspace } from '../lib/workspaceStore.js'
import { useCurrencies } from '../lib/icons.js'
import { hasMerchant, connectSession } from '../lib/session.js'
import { nav } from '../lib/nav.js'
import { relativeTime } from '../lib/sales.js'
import { makeExchange } from '../lib/price.js'
import { stashUnit } from '../lib/wealth.js'
import { canRelax, relaxQuery, relaxSummary } from '../lib/relaxQuery.js'
import { isTyping } from '../lib/stratcalc.js'
import {
  enrichMerchantRows,
  indexWorkspaceSearches,
  matchRecentSale,
  merchantSummary,
  merchantCurrencyAlerts,
  merchantBatchRegexes,
  merchantWaterfallSteps,
  filterMerchantRows,
  sortMerchantRows,
  summarizeFloorCheck,
} from '../lib/merchant.js'
import { useAssetModal } from './CardDetail.jsx'
import Cur from './Cur.jsx'
import ItemCard from './ItemCard.jsx'
import Seg from './Seg.jsx'
import Wealth, { Native } from './Wealth.jsx'

// Module caches survive tab switches so returning to Merchant never re-polls GGG automatically.
const shopCache = new Map()      // `${league}|${acctLower}|${sort}` -> shop snapshot (FIFO max 10)
const marketCache = new Map()    // league -> { prices, inflation, sales, fetchedAt }
const marketInFlight = new Map() // league -> Promise<market | null>
const priceCache = new Map()     // `${league}|${floorQuery}` -> { res, at } (FIFO max 200)
const MARKET_TTL_MS = 60_000
const PRICE_TTL_MS = 5 * 60_000
const MAX_SHOP_CACHE = 10
const MAX_PRICE_CACHE = 200
const EMPTY_MARKET = Object.freeze({ prices: {}, inflation: null, sales: [] })
const SORT_COLS = [
  { key: 'item', label: 'Item', num: false },
  { key: 'price', label: 'Ask', num: true },
  { key: 'age', label: 'Age', num: true },
  { key: 'verdict', label: 'Verdict', num: true },
]

export function clearMerchantShopCache() {
  shopCache.clear()
}

export function _resetMerchantCache() {
  shopCache.clear()
  marketCache.clear()
  marketInFlight.clear()
  priceCache.clear()
}

function sumRef(rows) {
  let sum = 0, any = false
  for (const r of rows) {
    if (Number.isFinite(r.refValue)) { sum += r.refValue; any = true }
  }
  return any ? sum : null
}

const shopKeyOf = (league, account, sort) =>
  `${String(league || '').trim()}|${String(account || '').trim().toLowerCase()}|${sort}`
const doneStorageKeyOf = (league, account) =>
  `arbiter:merchant-done:${String(league || '').trim()}|${String(account || '').trim().toLowerCase()}`

function putBounded(map, key, val, max) {
  if (map.has(key)) map.delete(key)
  map.set(key, val)
  while (map.size > max) map.delete(map.keys().next().value)
}

// Refresh local loopback pricing, inflation, and Merchant History sales ledger when stale (zero GGG traffic).
function fetchMarketIfStale(league) {
  if (!league) return Promise.resolve(null)
  const cached = marketCache.get(league)
  if (cached && Date.now() - cached.fetchedAt < MARKET_TTL_MS) return Promise.resolve(null)
  if (marketInFlight.has(league)) return marketInFlight.get(league)
  const p = Promise.all([
    api.stratPrices().catch(() => null),
    api.inflation('divine', 336).catch(() => null),
    api.sales(league).catch(() => null),
  ]).then(([pRes, infl, sl]) => {
    const next = {
      prices: pRes?.prices || cached?.prices || {},
      inflation: infl || cached?.inflation || null,
      sales: Array.isArray(sl?.rows) ? sl.rows : (cached?.sales || []),
      fetchedAt: Date.now(),
    }
    marketCache.set(league, next)
    return next
  }).finally(() => {
    if (marketInFlight.get(league) === p) marketInFlight.delete(league)
  })
  marketInFlight.set(league, p)
  return p
}

function readDoneMap(key) {
  if (!key) return {}
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}

function writeDoneMap(key, map) {
  if (!key) return
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(map))
  } catch { ignoredError('store completed listings') }
}

// When `complete` is true (full shop loaded), drop missing ids too; when partial/truncated,
// preserve done marks for unloaded pages and only prune loaded rows whose ask/indexed changed.
function pruneDoneMap(doneMap, rows, { complete = false } = {}) {
  const keys = Object.keys(doneMap)
  if (!keys.length) return doneMap
  const byId = new Map((rows || []).map(r => [r.id, r]))
  let changed = false
  const next = {}
  for (const id of keys) {
    const row = byId.get(id)
    const sig = doneMap[id]
    if (!row) {
      if (!complete) next[id] = sig
      else changed = true
    } else if (sig && row.amount === sig.amount && row.currency === sig.currency && row.indexed === sig.indexed) {
      next[id] = sig
    } else {
      changed = true
    }
  }
  return changed ? next : doneMap
}

function errorLabel(err) {
  if (err === 'rate') return 'Rate limited — try again shortly'
  if (err === 'auth') return 'Connect your PoE account to load your active listings'
  if (err === 'bad request') return 'Select a league to load your shop'
  if (err === 'expired') return 'Search cursor expired — refresh to load the latest listings'
  return err || 'Shop fetch failed'
}

function whyFlagged(row, curName) {
  if (row.verdict === 'vendor') {
    const verb = row.vendorVerb === 'Disenchant' ? 'Disenchant or vendor it' : 'Vendor it'
    return `Sitting ${row.ageLabel || '3d+'} at low value. ${verb} to clear a slot in Ange's shop.`
  }
  if (row.verdict === 'reprice') {
    const pct = Math.round((row.bleedPct || 0) * 100)
    if (row.bleedCapped && row.bleedWindowDays) {
      return `${curName} dropped ${pct}% vs Divine over the last ${row.bleedWindowDays}d (listed ${row.ageLabel || 'earlier'}). Update your ask so you don't undersell.`
    }
    return `${curName} dropped ${pct}% vs Divine since you listed this (${row.ageLabel || 'earlier'}). Update your ask.`
  }
  if (row.verdict === 'cut') {
    return `Sitting ${row.ageLabel || '3d+'} with no buyer. Drop the price using the steps below or check the current floor.`
  }
  return `Listed ${row.ageLabel || 'recently'} — no action needed yet.`
}

const RARITY_LABELS = {
  normal: 'Normal',
  magic: 'Magic',
  rare: 'Rare',
  unique: 'Unique',
  gem: 'Gem',
  currency: 'Currency',
  divination: 'Divination',
  prophecy: 'Prophecy',
  relic: 'Relic',
}

export default function MerchantView({ league }) {
  const desktop = hasMerchant()
  const statusLoaded = useStatus(s => s.status !== null)
  const statusLeague = useStatus(s => s.status?.league || '')
  const ref = useStatus(s => s.status?.reference || 'exalted')
  const unitChoice = useStatus(s => s.settings?.stash_unit) ?? null
  const oauthAccount = useStatus(s => (s.status?.oauth?.logged_in ? (s.status?.oauth?.username || '').trim() : ''))
  const sessionConnected = useStatus(s => Boolean(s.status?.session?.connected))
  const sessionSetAt = useStatus(s => s.status?.session?.set_at ?? '')
  const wealthPrices = useStatus(useShallow(s => s.status?.wealth_prices || null))
  const workspaceTree = useWorkspace(s => s.tree)
  const workspaceLoaded = useWorkspace(s => s.loaded)
  const { nameOf } = useCurrencies()
  const assetModal = useAssetModal()

  const sel = league || statusLeague
  const isLoggedIn = Boolean(oauthAccount || sessionConnected)
  const [sessionAccount, setSessionAccount] = useState('')
  const [connecting, setConnecting] = useState(false)
  const searchInputRef = useRef(null)

  const accountSlot = oauthAccount
    ? oauthAccount.toLowerCase()
    : (sessionConnected ? `__session__:${sessionSetAt || 'default'}` : '')

  const [fetchOrder, setFetchOrder] = useState('price_desc')   // 'price_desc' | 'oldest'
  const cacheKey = shopKeyOf(sel, accountSlot, fetchOrder)

  const cachedMarket = sel ? marketCache.get(sel) : null
  const [shop, setShop] = useState(() => (sel && accountSlot ? shopCache.get(cacheKey) || null : null))
  const activeAccount = oauthAccount || shop?.account || sessionAccount
  const doneKey = sel && activeAccount ? doneStorageKeyOf(sel, activeAccount) : ''
  const [market, setMarket] = useState(() => (
    cachedMarket ? { prices: cachedMarket.prices, inflation: cachedMarket.inflation, sales: cachedMarket.sales || [] } : EMPTY_MARKET
  ))
  const { prices, inflation, sales: salesRows } = market
  const [verdictFilter, setVerdictFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [sortCol, setSortCol] = useState({ key: 'verdict', dir: 'asc' })
  const [busyMode, setBusyMode] = useState(null)   // null | 'load' | 'more'
  const [error, setError] = useState(null)         // { message, code } | null
  const [openId, setOpenId] = useState(null)
  const [doneMap, setDoneMap] = useState(() => readDoneMap(doneKey))
  const [showDone, setShowDone] = useState(false)
  const [prevDoneMap, setPrevDoneMap] = useState(null)
  const [pendingPrices, setPendingPrices] = useState(() => new Set())
  const [priceTick, setPriceTick] = useState(0)   // bumps when module priceCache receives a response

  const mountedRef = useRef(true)
  const selRef = useRef(sel)
  selRef.current = sel
  const activeReqRef = useRef(null)
  const busyRef = useRef(null)
  const tick = useSync(s => s.tick)
  const tick0 = useRef(tick)

  useEffect(() => {
    mountedRef.current = true
    ensureSettings().catch(() => ignoredError('load merchant settings'))
    return () => {
      mountedRef.current = false
      useSync.getState().setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (desktop && !workspaceLoaded) loadWorkspace().catch(() => ignoredError('load trading workspace'))
  }, [desktop, workspaceLoaded])

  useEffect(() => {
    if (!sessionConnected) {
      setSessionAccount('')
      for (const k of [...shopCache.keys()]) {
        if (k.includes('|__session__:')) shopCache.delete(k)
      }
    }
  }, [sessionConnected, sessionSetAt])

  const setBusy = useCallback((mode) => {
    busyRef.current = mode
    setBusyMode(mode)
    useSync.getState().setBusy(mode !== null)
  }, [])

  const persistDone = useCallback((nextMap) => {
    setDoneMap(nextMap)
    writeDoneMap(doneKey, nextMap)
  }, [doneKey])

  const runShopFetch = useCallback(async ({ sort = fetchOrder, more = false } = {}) => {
    if (!desktop || !sel || !isLoggedIn) return
    if (more && busyRef.current) return
    if (!more && busyRef.current === 'load') return
    if (!more && busyRef.current === 'more') {
      window.poe2desktop?.merchant?.cancel?.({ scope: 'fetch' })
    }
    const token = {}
    activeReqRef.current = token
    const isCurrent = () => mountedRef.current && activeReqRef.current === token
    setBusy(more ? 'more' : 'load')
    setError(null)
    try {
      const fetchParams = { league: sel, sort, more, ...(oauthAccount ? { account: oauthAccount } : {}) }
      const [res, mkt] = await Promise.all([
        window.poe2desktop.merchant.fetch(fetchParams),
        more ? Promise.resolve(null) : fetchMarketIfStale(sel),
      ])
      if (!isCurrent()) return
      if (mkt) {
        setMarket({ prices: mkt.prices, inflation: mkt.inflation, sales: mkt.sales || [] })
      }
      if (!res?.ok) {
        if (res?.error === 'cancelled') return
        setError({ message: errorLabel(res?.error), code: res?.error || null })
        return
      }
      const resolved = String(res.account || oauthAccount || sessionAccount || '').trim()
      if (resolved && !oauthAccount && resolved !== sessionAccount) setSessionAccount(resolved)

      const incoming = Array.isArray(res.rows) ? res.rows : []
      const existing = more ? shopCache.get(shopKeyOf(sel, accountSlot, sort)) : null
      const mergedRows = more && existing
        ? (() => {
            const seen = new Set(existing.rows.map(r => r.id))
            return [...existing.rows, ...incoming.filter(r => !seen.has(r.id))]
          })()
        : incoming
      const next = {
        account: resolved,
        total: res.total ?? mergedRows.length,
        truncated: !!res.truncated,
        remainingIds: Number.isFinite(res.remainingIds) ? res.remainingIds : 0,
        apiCapReached: !!res.apiCapReached,
        sort: res.sort || sort,
        rows: mergedRows,
        fetchedAt: res.fetchedAt || Date.now(),
        cursorExpiresAt: res.cursorExpiresAt ?? null,
      }
      putBounded(shopCache, shopKeyOf(sel, accountSlot, next.sort), next, MAX_SHOP_CACHE)
      // When the full shop fits in memory (!truncated), seed the opposite fetchOrder too (0 extra GGG calls).
      if (!next.truncated) {
        const other = next.sort === 'price_desc' ? 'oldest' : 'price_desc'
        putBounded(shopCache, shopKeyOf(sel, accountSlot, other), { ...next, sort: other }, MAX_SHOP_CACHE)
      }
      setShop(next)
      if (res.partial && res.rateLimited) {
        toast(`Loaded ${mergedRows.length} listings before rate limit — click Load next 50 shortly`, false)
      }
      if (resolved) {
        const key = doneStorageKeyOf(sel, resolved)
        const complete = !next.truncated && !res.partial
        setDoneMap(prev => {
          const pruned = pruneDoneMap(prev, mergedRows, { complete })
          if (pruned !== prev) writeDoneMap(key, pruned)
          return pruned
        })
      }
    } catch (e) {
      if (isCurrent()) {
        setError({ message: errorLabel(String(e?.message || e)), code: null })
      }
    } finally {
      if (isCurrent()) {
        activeReqRef.current = null
        setBusy(null)
      }
    }
  }, [desktop, sel, isLoggedIn, oauthAccount, sessionAccount, accountSlot, fetchOrder, setBusy])

  const runShopFetchRef = useRef(runShopFetch)
  runShopFetchRef.current = runShopFetch

  // Cancel all merchant calls (shop fetch + inline floor checks) on unmount or league/login change.
  useEffect(() => {
    if (!desktop) return undefined
    return () => { window.poe2desktop?.merchant?.cancel?.({ scope: 'all' }) }
  }, [desktop, sel, accountSlot])

  // Load from in-memory cache when available; otherwise automatically load the logged-in user's shop
  // on tab open, league switch, login, or fetchOrder change (zero extra Load button friction).
  useEffect(() => {
    const cached = sel && accountSlot ? shopCache.get(cacheKey) || null : null
    setShop(cached)
    if (!oauthAccount) setSessionAccount(cached?.account || '')
    setError(null)
    setOpenId(null)
    setBusy(null)
    if (desktop && sel && accountSlot && !cached) {
      runShopFetchRef.current({ sort: fetchOrder, more: false })
    }
    if (!desktop) return undefined
    return () => {
      activeReqRef.current = null
      busyRef.current = null
      window.poe2desktop?.merchant?.cancel?.({ scope: 'fetch' })
    }
  }, [desktop, cacheKey, sel, accountSlot, fetchOrder, oauthAccount, setBusy])

  // Reload session done-state when league or logged-in account changes.
  useEffect(() => {
    setDoneMap(readDoneMap(doneKey))
    setPrevDoneMap(null)
    setShowDone(false)
    bus.emit({ id: 'merchant-done', dismiss: true })
    return () => bus.emit({ id: 'merchant-done', dismiss: true })
  }, [doneKey])

  // `/` focuses inline search box (matches StashView.jsx).
  useEffect(() => {
    if (!shop) return undefined
    const onKey = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return
      e.preventDefault()
      searchInputRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shop])

  // Load local loopback pricing, inflation series, and Merchant History sales with a short module cache (no GGG traffic).
  useEffect(() => {
    if (!desktop || !sel) return undefined
    const cached = marketCache.get(sel)
    if (cached) {
      setMarket({ prices: cached.prices, inflation: cached.inflation, sales: cached.sales || [] })
    } else {
      setMarket(prev => ({ ...prev, sales: [] }))
    }
    let alive = true
    fetchMarketIfStale(sel).then(next => {
      if (!alive || !next) return
      setMarket({ prices: next.prices, inflation: next.inflation, sales: next.sales || [] })
    }).catch(() => ignoredError('refresh merchant prices'))
    return () => { alive = false }
  }, [desktop, sel])

  const doConnect = async () => {
    const prevSlot = accountSlot
    setConnecting(true)
    setError(null)
    try {
      const r = await connectSession()
      if (!mountedRef.current) return
      if (r.ok) {
        clearMerchantShopCache()
        setSessionAccount('')
        await useStatus.getState().refresh()
        toast('Connected Path of Exile account')
        const st = useStatus.getState().status
        const nextOauth = st?.oauth?.logged_in ? (st?.oauth?.username || '').trim() : ''
        const nextSlot = nextOauth
          ? nextOauth.toLowerCase()
          : (st?.session?.connected ? `__session__:${st?.session?.set_at || 'default'}` : '')
        if (prevSlot && nextSlot === prevSlot && mountedRef.current) {
          runShopFetchRef.current({ sort: fetchOrder, more: false })
        }
      } else {
        setError({ message: r.message || 'Could not connect Path of Exile account', code: null })
      }
    } finally {
      if (mountedRef.current) setConnecting(false)
    }
  }

  const refresh = useCallback(() => {
    runShopFetch({ sort: fetchOrder, more: false })
  }, [runShopFetch, fetchOrder])

  // Top-bar ⟳ refreshes the shop on demand.
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    if (tick !== tick0.current) {
      tick0.current = tick
      refreshRef.current()
    }
  }, [tick])

  const exchangeFn = useMemo(
    () => makeExchange(prices, wealthPrices),
    [prices, wealthPrices],
  )

  const workspaceIndex = useMemo(
    () => indexWorkspaceSearches(workspaceTree),
    [workspaceTree],
  )

  const now = shop?.fetchedAt ?? 0
  const enriched = useMemo(
    () => enrichMerchantRows(shop?.rows || [], { prices, inflation, now, ref, wealthPrices, exchange: exchangeFn, workspaceIndex }),
    [shop?.rows, prices, inflation, now, ref, wealthPrices, exchangeFn, workspaceIndex],
  )
  const summary = useMemo(() => merchantSummary(enriched), [enriched])
  const doneIds = useMemo(() => new Set(Object.keys(doneMap)), [doneMap])
  const doneCount = doneIds.size
  const activeSummary = useMemo(
    () => (doneCount === 0 ? summary : merchantSummary(enriched.filter(r => !doneIds.has(r.id)))),
    [enriched, doneIds, doneCount, summary],
  )
  const pillSummary = showDone ? summary : activeSummary
  const currencyAlerts = useMemo(() => merchantCurrencyAlerts(enriched), [enriched])

  const filtered = useMemo(
    () => filterMerchantRows(enriched, { verdict: verdictFilter, search, hideDone: !showDone, doneIds }),
    [enriched, verdictFilter, search, showDone, doneIds],
  )
  const shown = useMemo(
    () => sortMerchantRows(filtered, { ...sortCol, exchange: exchangeFn }),
    [filtered, sortCol, exchangeFn],
  )

  const isFilteredView = verdictFilter !== 'all' || search.trim() !== '' || (!showDone && doneCount > 0)

  const shopTotalRef = useMemo(
    () => (shop && summary.count ? sumRef(enriched) : null),
    [shop, summary.count, enriched],
  )

  const displayRef = useMemo(
    () => (!shop || !summary.count ? null : (!isFilteredView ? shopTotalRef : sumRef(shown))),
    [shop, summary.count, isFilteredView, shown, shopTotalRef],
  )

  // Honor Stash's stash_unit preference and keep one common scale across Ask comparisons (CLAUDE.md).
  const pairUnit = stashUnit(shopTotalRef, ref, wealthPrices, unitChoice)
  const commonUnit = pairUnit || 'divine'

  const floorById = useMemo(() => {
    const map = new Map()
    const nowMs = Date.now()
    for (const r of enriched) {
      const cached = priceCache.get(`${sel}|${r.floorQuery}`)
      if (cached && nowMs - cached.at < PRICE_TTL_MS) {
        map.set(r.id, summarizeFloorCheck(cached.res, r, prices, wealthPrices, exchangeFn))
      }
    }
    return map
  }, [enriched, sel, prices, wealthPrices, exchangeFn, priceTick])

  const openRecentSale = useMemo(() => {
    if (!openId) return null
    const row = enriched.find(r => r.id === openId)
    return row ? matchRecentSale(row, salesRows) : null
  }, [openId, enriched, salesRows])

  // Contextual batch Ange regex target: active filtered rows on actionable tabs, or Vendor rows on All.
  const batchContext = useMemo(() => {
    if (!shop || !enriched.length) return null
    if (verdictFilter === 'vendor' || verdictFilter === 'cut' || verdictFilter === 'reprice') {
      const target = shown.filter(r => !doneIds.has(r.id))
      if (!target.length) return null
      const label = verdictFilter === 'vendor' ? 'Vendor' : verdictFilter === 'cut' ? 'Cut price' : 'Reprice'
      return { label, rows: target, chunks: merchantBatchRegexes(target), canMarkAll: true }
    }
    if (verdictFilter === 'all' && search.trim()) {
      const target = shown.filter(r => !doneIds.has(r.id))
      if (!target.length) return null
      return { label: 'Filtered', rows: target, chunks: merchantBatchRegexes(target), canMarkAll: false }
    }
    if (verdictFilter === 'all') {
      const vendors = enriched.filter(r => r.verdict === 'vendor' && !doneIds.has(r.id))
      if (!vendors.length) return null
      return { label: 'Vendor', rows: vendors, chunks: merchantBatchRegexes(vendors), canMarkAll: false }
    }
    return null
  }, [shop, enriched, shown, verdictFilter, search, doneIds])

  const markRowsDone = (rowsToMark, label) => {
    if (!rowsToMark.length) return
    const prev = doneMap
    const next = { ...prev }
    for (const r of rowsToMark) {
      next[r.id] = { amount: r.amount, currency: r.currency, indexed: r.indexed }
    }
    persistDone(next)
    setPrevDoneMap(prev)
    undoToast('merchant-done', label, () => {
      persistDone(prev)
      setPrevDoneMap(null)
    })
  }

  const toggleRowDone = (row) => {
    const prev = doneMap
    if (doneIds.has(row.id)) {
      const next = { ...prev }
      delete next[row.id]
      persistDone(next)
      setPrevDoneMap(prev)
      bus.emit({ id: 'merchant-done', dismiss: true })
      return
    }
    markRowsDone([row], `Marked ${row.title} done`)
  }

  const runInlinePriceCheck = async (row) => {
    if (!desktop || !sel || !row.canInlinePriceCheck) return
    const priceKey = `${sel}|${row.floorQuery}`
    const cached = priceCache.get(priceKey)
    if (cached && Date.now() - cached.at < PRICE_TTL_MS) {
      setPriceTick(t => t + 1)
      return
    }
    if (pendingPrices.has(priceKey)) return
    setPendingPrices(prev => { const n = new Set(prev); n.add(priceKey); return n })
    const leagueAtCall = sel
    try {
      const fn = window.poe2desktop?.merchant?.priceCheck
      if (!fn) {
        toast('Inline price check requires the desktop app', false)
        return
      }
      let res = await fn({ league: leagueAtCall, query: row.floorQueryObj })
      // When an exact mod-filtered Rare search finds 0 comps, reuse relaxQuery (Close-enough) automatically.
      if (res?.ok && !(res.listings?.length > 0) && row.rarity === 'rare' && canRelax(row.floorQueryObj?.query)) {
        const relaxed = relaxQuery(row.floorQueryObj.query, 1)
        if (relaxed?.query) {
          const r2 = await fn({ league: leagueAtCall, query: { query: relaxed.query, sort: { price: 'asc' } } })
          if (r2?.ok) res = { ...r2, relaxed: true, relaxSummary: relaxSummary(relaxed.summary) }
        }
      }
      if (res?.ok) {
        putBounded(priceCache, priceKey, { res, at: Date.now() }, MAX_PRICE_CACHE)
      } else if (res?.error && res.error !== 'cancelled' && mountedRef.current && selRef.current === leagueAtCall) {
        toast(errorLabel(res.error), false)
      }
    } catch (e) {
      if (mountedRef.current && selRef.current === leagueAtCall) {
        toast(errorLabel(String(e?.message || e)), false)
      }
    } finally {
      if (mountedRef.current) {
        setPendingPrices(prev => { const n = new Set(prev); n.delete(priceKey); return n })
        setPriceTick(t => t + 1)
      }
    }
  }

  const openInWorkspace = (row) => {
    const st = useWorkspace.getState()
    if (!st.loaded) loadWorkspace().catch(() => ignoredError('load trading workspace'))
    if (row.workspaceId) {
      st.setActive(row.workspaceId)
    } else {
      st.ingest({ source: 'merchant', q: row.floorQuery, name: row.title })
    }
    nav.goTrading('workspace')
  }

  const toggleSort = (key) => {
    setSortCol(prev => (
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'price' || key === 'age' ? 'desc' : 'asc' }
    ))
  }

  const sortArrow = (key) => (sortCol.key === key ? (sortCol.dir === 'asc' ? ' ▴' : ' ▾') : '')

  if (!desktop) {
    return (
      <div className="merchant-view">
        <div className="notice">
          Merchant shop tracking is desktop-only — it queries your active Instant Buyout listings through your local PoE session.
        </div>
      </div>
    )
  }

  const canLoadMore = !!(shop && shop.remainingIds > 0 && (!shop.cursorExpiresAt || Date.now() < shop.cursorExpiresAt))
  const orderLabel = (shop?.sort || fetchOrder) === 'price_desc' ? 'highest price first' : 'oldest first'
  const oppositeOrder = (shop?.sort || fetchOrder) === 'price_desc' ? 'oldest' : 'price_desc'
  const oppositeLabel = oppositeOrder === 'oldest' ? 'Fetch oldest instead' : 'Fetch highest-priced instead'

  if (!shop) {
    if (!statusLoaded) {
      return <div className="merchant-view"><div className="hint">Loading your shop…</div></div>
    }
    if (!isLoggedIn) {
      return (
        <div className="merchant-view">
          {error && <div className="notice error" role="alert">{error.message}</div>}
          <div className="merchant-setup">
            <h2>Review Ange&apos;s shop</h2>
            <p className="muted">
              Connect your Path of Exile account to scan your active Instant Buyout listings and see what lost value, sat too long, or can be vendored.
            </p>
            <div className="merchant-setup-actions">
              <button
                type="button"
                className="btn primary"
                disabled={connecting}
                onClick={doConnect}
              >
                {connecting ? 'Connecting…' : 'Connect PoE account'}
              </button>
            </div>
          </div>
        </div>
      )
    }
    if (error) {
      return (
        <div className="merchant-view">
          <div className="notice error merchant-alert" role="alert">
            <span>{error.message}</span>
            {error.code === 'auth' ? (
              <button type="button" className="btn primary small" disabled={connecting} onClick={doConnect}>
                {connecting ? 'Connecting…' : 'Connect PoE account'}
              </button>
            ) : (
              <button type="button" className="btn small" disabled={busyMode !== null || !sel} onClick={refresh}>
                Retry
              </button>
            )}
          </div>
        </div>
      )
    }
    return <div className="merchant-view"><div className="hint">Loading your shop…</div></div>
  }

  return (
    <div className="merchant-view">
      {/* Toolbar: single 4-option verdict switcher, inline search (/), and last-updated timestamp */}
      <div className="merchant-head">
        <Seg
          value={verdictFilter}
          onChange={setVerdictFilter}
          options={[
            ['all', `All (${pillSummary.count})`],
            ['reprice', `Reprice (${pillSummary.repriceCount})`],
            ['cut', `Cut (${pillSummary.cutCount})`],
            ['vendor', `Vendor (${pillSummary.vendorCount})`],
          ]}
        />
        <label className="stash-search">
          <input
            ref={searchInputRef}
            data-cmd="merchant-find"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Find item, base, tab"
            aria-label="Find in shop"
            onKeyDown={e => { if (e.key === 'Escape') { setSearch(''); e.currentTarget.blur() } }}
          />
          <span className="cmdk-k" aria-hidden="true">/</span>
        </label>
        <span className="spacer" />
        {shop.fetchedAt && (
          <span className="muted merchant-updated">{relativeTime(new Date(shop.fetchedAt).toISOString())}</span>
        )}
      </div>

      {/* Macro summary strip: 3 non-redundant stats with explicit loaded scope */}
      <div className="merchant-summary">
        <div className="stash-stat">
          <span className="stat-label">{isFilteredView ? 'Shown ask total' : 'Listed ask total'}</span>
          <span className="stat-val">
            {displayRef != null ? (
              <Wealth v={displayRef} cur={ref} unit={pairUnit} size={22} />
            ) : !isFilteredView && summary.totalDiv > 0 ? (
              <Native v={summary.totalDiv} cur="divine" size={22} />
            ) : (
              <span className="muted">–</span>
            )}
          </span>
          <span className="muted merchant-stat-sub">
            {isFilteredView
              ? `${shown.length} of ${summary.count} loaded${shop.truncated ? ` (${shop.total} total)` : ''}`
              : shop.truncated
                ? `Across ${summary.count} of ${shop.total} listed`
                : 'Unsold asking prices'}
          </span>
        </div>
        <div className="stash-stat">
          <span className="stat-label">Loaded</span>
          <span className="stat-val">
            {summary.count}
            {shop.truncated && <span className="muted merchant-total-cap"> / {shop.total}</span>}
          </span>
          <span className="muted merchant-stat-sub">
            {shop.truncated ? orderLabel : 'All active listings'}
          </span>
        </div>
        <div className="stash-stat">
          <span className="stat-label">Needs action</span>
          <span className="stat-val">{activeSummary.actionableCount}</span>
          <span className="muted merchant-stat-sub">
            {activeSummary.actionableCount > 0
              ? [
                  activeSummary.repriceCount ? `${activeSummary.repriceCount} reprice` : null,
                  activeSummary.cutCount ? `${activeSummary.cutCount} cut` : null,
                  activeSummary.vendorCount ? `${activeSummary.vendorCount} vendor` : null,
                ].filter(Boolean).join(' · ')
              : doneCount > 0
                ? 'All caught up'
                : 'All listings look fresh'}
          </span>
        </div>
      </div>

      {/* Currency watch banner: lifts macro inflation off every row and links to CardDetail + Economy → Inflation */}
      {currencyAlerts.length > 0 && (
        <div className="notice merchant-alert">
          <span className="merchant-alert-copy">
            {currencyAlerts.map((a, idx) => (
              <React.Fragment key={a.currency}>
                {idx > 0 && ' · '}
                <button
                  type="button"
                  className="link-btn merchant-alert-cur"
                  title={`Inspect ${nameOf(a.currency)} price chart vs Divine`}
                  onClick={() => assetModal.open(nameOf(a.currency), 'divine')}
                >
                  <Cur id={a.currency} text size={14} />
                </button>{' '}
                dropped {Math.round(a.maxBleedPct * 100)}% vs Divine
                {a.capped && a.windowDays ? ` (${a.windowDays}d)` : ''} ({a.count} {a.count === 1 ? 'listing' : 'listings'})
              </React.Fragment>
            ))}
          </span>
          <span className="merchant-alert-actions">
            {verdictFilter !== 'reprice' && summary.repriceCount > 0 && (
              <button type="button" className="btn small" onClick={() => setVerdictFilter('reprice')}>
                Show Reprice
              </button>
            )}
            <button type="button" className="link-btn" onClick={() => nav.goEconomy('inflation')}>
              Inflation ↗
            </button>
          </span>
        </div>
      )}

      {/* Contextual action bar: 250-char Ange batch regexes + session done controls */}
      {(batchContext || doneCount > 0 || prevDoneMap !== null) && (
        <div className="merchant-bar">
          {batchContext && (
            <div className="merchant-batch">
              {batchContext.chunks.length === 1 ? (
                <button
                  type="button"
                  className="btn small"
                  title={batchContext.chunks[0].regex}
                  onClick={() => copyText(batchContext.chunks[0].regex, `${batchContext.label} Ange regex (${batchContext.chunks[0].count} items)`)}
                >
                  Copy {batchContext.label} regex ({batchContext.chunks[0].count})
                </button>
              ) : (
                <>
                  <span className="muted merchant-batch-label">{batchContext.label} Ange regex:</span>
                  {batchContext.chunks.map((c, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className="btn small"
                      title={c.regex}
                      onClick={() => copyText(c.regex, `${batchContext.label} regex part ${idx + 1} of ${batchContext.chunks.length}`)}
                    >
                      Part {idx + 1} ({c.count})
                    </button>
                  ))}
                </>
              )}
              {batchContext.canMarkAll && (
                <button
                  type="button"
                  className="btn small"
                  onClick={() => markRowsDone(batchContext.rows, `Marked ${batchContext.rows.length} ${batchContext.label.toLowerCase()} items done`)}
                >
                  Mark all done
                </button>
              )}
            </div>
          )}
          <span className="spacer" />
          {(doneCount > 0 || prevDoneMap !== null) && (
            <div className="merchant-done-ctrl">
              {doneCount > 0 && (
                <>
                  <span className="muted">{doneCount} done</span>
                  <button type="button" className="link-btn" onClick={() => setShowDone(v => !v)}>
                    {showDone ? 'Hide done' : 'Show done'}
                  </button>
                </>
              )}
              {prevDoneMap !== null && (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    persistDone(prevDoneMap)
                    setPrevDoneMap(null)
                    bus.emit({ id: 'merchant-done', dismiss: true })
                  }}
                >
                  Undo
                </button>
              )}
              {doneCount > 0 && (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    const prev = doneMap
                    persistDone({})
                    setPrevDoneMap(prev)
                    undoToast('merchant-done', 'Cleared done list', () => {
                      persistDone(prev)
                      setPrevDoneMap(null)
                    })
                  }}
                >
                  Reset
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className={`notice error${error.code === 'auth' ? ' merchant-alert' : ''}`} role="alert">
          <span>{error.message}</span>
          {error.code === 'auth' && (
            <button type="button" className="btn primary small" disabled={connecting} onClick={doConnect}>
              {connecting ? 'Connecting…' : 'Connect PoE account'}
            </button>
          )}
        </div>
      )}

      {shown.length === 0 ? (
        <div className="empty small">
          {summary.count === 0
            ? `No active Instant Buyout listings found in ${sel || 'this league'}.`
            : doneCount > 0 && !showDone && verdictFilter === 'all' && !search.trim()
              ? 'Every loaded listing is marked done.'
              : 'No listings match the current filter.'}
        </div>
      ) : (
        <div className="merchant-table-wrap">
          <table className="merchant-table">
            <thead>
              <tr>
                {SORT_COLS.map(col => (
                  <th
                    key={col.key}
                    className={`${col.num ? 'num ' : ''}sortable ${sortCol.key === col.key ? 'sorted' : ''}`}
                    aria-sort={sortCol.key === col.key ? (sortCol.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    onClick={() => toggleSort(col.key)}
                  >
                    {col.label}{sortArrow(col.key)}
                  </th>
                ))}
                <th className="num">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(r => {
                const isOpen = openId === r.id
                const isDone = doneIds.has(r.id)
                const curName = nameOf(r.currency)
                const askTitle = `${fmt.n(r.amount, r.amount >= 1 ? 2 : 3)} ${curName}${r.divValue != null && r.currency !== 'divine' ? ` (~${fmt.n(r.divValue, 2)} div)` : ''}`
                const priceKey = `${sel}|${r.floorQuery}`
                const floorInfo = floorById.get(r.id) || null
                const checkingFloor = pendingPrices.has(priceKey)
                const steps = isOpen ? merchantWaterfallSteps(r) : []
                const recentSale = isOpen ? openRecentSale : null
                const reason = whyFlagged(r, curName)

                return (
                  <React.Fragment key={r.id}>
                    <tr className={`${isOpen ? 'merchant-row-open' : ''} ${isDone ? 'merchant-row-done' : ''}`}>
                      <td>
                        <button
                          type="button"
                          className="merchant-item-btn"
                          aria-expanded={isOpen}
                          onClick={() => setOpenId(isOpen ? null : r.id)}
                        >
                          <svg
                            className={`stash-chev merchant-chev ${isOpen ? 'open' : ''}`}
                            viewBox="0 0 10 10"
                            width="10"
                            height="10"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            aria-hidden="true"
                          >
                            <path d="M3.5 2 6.5 5 3.5 8" />
                          </svg>
                          {r.icon ? <img className="sale-icon" src={r.icon} alt="" loading="lazy" /> : <span className="sale-icon" />}
                          <span className="merchant-item-text">
                            <span className="merchant-item-name">
                              <span className={`sale-glyph ${r.rarity}`} aria-hidden="true">◆</span>
                              {r.title}
                              <span className={`merchant-rarity ${r.rarity}`}>{RARITY_LABELS[r.rarity] || r.rarity}</span>
                            </span>
                            {(r.subBase || r.ilvl != null || r.stashName) && (
                              <span className="muted merchant-item-meta">
                                {[r.subBase, r.ilvl != null ? `iLvl ${r.ilvl}` : null, r.stashName || null].filter(Boolean).join(' · ')}
                              </span>
                            )}
                          </span>
                        </button>
                      </td>
                      <td className="num merchant-price-cell">
                        <div className="merchant-ask-stack">
                          <Native v={r.amount} cur={r.currency} vRef={r.refValue} size={14} title={askTitle} />
                          {r.refValue != null && r.currency !== commonUnit && (
                            <span className="merchant-ask-equiv muted">
                              ≈ <Wealth v={r.refValue} cur={ref} unit={commonUnit} size={12} />
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="num">
                        <span className="muted" title={r.indexed || ''}>{r.ageLabel || '–'}</span>
                      </td>
                      <td className="num">
                        {r.verdict === 'reprice' ? (
                          <span className="merchant-badge reprice" title={reason}>
                            Reprice −{Math.round((r.bleedPct || 0) * 100)}%
                          </span>
                        ) : r.verdict === 'cut' ? (
                          <span className="merchant-badge cut" title={reason}>
                            Cut price
                          </span>
                        ) : r.verdict === 'vendor' ? (
                          <span className="merchant-badge vendor" title={reason}>
                            {r.vendorVerb}
                          </span>
                        ) : (
                          <span className="muted" title={reason}>–</span>
                        )}
                      </td>
                      <td className="num">
                        <div className="merchant-actions">
                          <button
                            type="button"
                            className="btn small"
                            disabled={!r.regex}
                            aria-label={`Find ${r.title} in Ange`}
                            title={r.regex ? `Copy ${r.regex} for Ange's Ctrl+F` : undefined}
                            onClick={() => copyText(r.regex, 'Item name for Ange Ctrl+F')}
                          >
                            Find
                          </button>
                          {r.canInlinePriceCheck ? (
                            floorInfo ? (
                              <button
                                type="button"
                                className="btn small merchant-floor-pill"
                                title={floorInfo.cheapest
                                  ? `${floorInfo.relaxed ? 'Close-enough ' : ''}cheapest Instant Buyout (${floorInfo.total} listed) — click to inspect`
                                  : 'No other Instant Buyout listings found'}
                                onClick={() => setOpenId(r.id)}
                              >
                                {floorInfo.cheapest ? (
                                  <>
                                    {floorInfo.relaxed ? 'Close ' : 'Floor '}
                                    <Native v={floorInfo.cheapest.amount} cur={floorInfo.cheapest.currency} size={13} />
                                  </>
                                ) : (
                                  'No comps'
                                )}
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="btn small"
                                disabled={checkingFloor}
                                aria-label={`Check floor for ${r.title}`}
                                title={r.querySource === 'workspace'
                                  ? 'Check floor using your matching Workspace / EE2 search'
                                  : r.querySource === 'mods'
                                    ? 'Check mod-filtered floor for this rare'
                                    : undefined}
                                onClick={() => runInlinePriceCheck(r)}
                              >
                                {checkingFloor ? 'Checking…' : 'Check'}
                              </button>
                            )
                          ) : (
                            <button
                              type="button"
                              className="btn small"
                              aria-label={`Open ${r.title} in Workspace`}
                              title="Rare items need mod matching — open in Workspace"
                              onClick={() => openInWorkspace(r)}
                            >
                              Workspace ↗
                            </button>
                          )}
                          <button
                            type="button"
                            className={`btn small merchant-done-btn ${isDone ? 'on' : ''}`}
                            aria-label={isDone ? `Restore ${r.title}` : `Mark ${r.title} done`}
                            aria-pressed={isDone}
                            title={isDone ? 'Restore to active list' : 'Mark done for this session'}
                            onClick={() => toggleRowDone(r)}
                          >
                            ✓
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isOpen && r.item && (
                      <tr className="merchant-detail-row">
                        <td colSpan={5}>
                          <div className="two-col merchant-drawer">
                            <ItemCard item={r.item} />
                            <div className="merchant-triage">
                              <div className="merchant-triage-sec">
                                <span className="merchant-triage-label">Why flagged</span>
                                <p className="merchant-triage-text">{reason}</p>
                                {r.verdict === 'reprice' && (
                                  <button
                                    type="button"
                                    className="link-btn merchant-inline-link"
                                    onClick={() => assetModal.open(curName, 'divine')}
                                  >
                                    Inspect {curName} chart vs Divine
                                  </button>
                                )}
                              </div>
                              <div className="merchant-triage-sec">
                                <span className="merchant-triage-label">Market floor</span>
                                {!r.canInlinePriceCheck ? (
                                  <p className="muted merchant-triage-text">
                                    Rare prices depend on mod rolls. Open in Workspace to filter matching stats.
                                  </p>
                                ) : floorInfo ? (
                                  <div className="merchant-floor-block">
                                    <div className="merchant-floor-summary">
                                      {floorInfo.cheapest ? (
                                        <>
                                          <Native v={floorInfo.cheapest.amount} cur={floorInfo.cheapest.currency} size={15} />
                                          <span className="muted">
                                            cheapest of {floorInfo.total} Instant Buyout
                                            {floorInfo.pctAbove != null && (
                                              floorInfo.pctAbove > 0.05
                                                ? ` · your ask is +${Math.round(floorInfo.pctAbove * 100)}% above`
                                                : floorInfo.pctAbove < -0.05
                                                  ? ` · your ask is ${Math.round(Math.abs(floorInfo.pctAbove) * 100)}% below`
                                                  : ' · right at floor'
                                            )}
                                          </span>
                                        </>
                                      ) : (
                                        <span className="muted">No other Instant Buyout listings found.</span>
                                      )}
                                    </div>
                                    {floorInfo.relaxed && (
                                      <span className="muted merchant-floor-note">
                                        Close-enough match{floorInfo.relaxSummary ? ` (${floorInfo.relaxSummary})` : ''} — exact rolls had 0 listings.
                                      </span>
                                    )}
                                    {floorInfo.cheaperCurrency && (
                                      <span className="muted merchant-floor-note">
                                        Cheaper in {nameOf(floorInfo.cheaperCurrency.currency)} ({Math.round(floorInfo.cheaperCurrency.gap * 100)}% below GGG&apos;s rank-1 {nameOf(floorInfo.cheaperCurrency.vs)}).
                                      </span>
                                    )}
                                  </div>
                                ) : (
                                  <div className="merchant-floor-block">
                                    <button
                                      type="button"
                                      className="btn small"
                                      disabled={checkingFloor}
                                      onClick={() => runInlinePriceCheck(r)}
                                    >
                                      {checkingFloor ? 'Checking floor…' : 'Check current floor'}
                                    </button>
                                    {(r.querySource === 'workspace' || r.querySource === 'mods') && (
                                      <span className="muted merchant-floor-note">
                                        {r.querySource === 'workspace'
                                          ? 'Uses your matching Workspace / EE2 search filters.'
                                          : `Uses ${r.matchedMods?.mods?.length || 0} matched mod filters (falls back to Close-enough if 0 comps).`}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                              {recentSale && (
                                <div className="merchant-triage-sec">
                                  <span className="merchant-triage-label">Your sales history</span>
                                  <div className="merchant-floor-summary">
                                    <span>Sold for</span>
                                    <Native v={recentSale.amount} cur={recentSale.currency} size={14} />
                                    {recentSale.time && <span className="muted">· {relativeTime(recentSale.time)}</span>}
                                  </div>
                                </div>
                              )}
                              {steps.length > 0 && (
                                <div className="merchant-triage-sec">
                                  <span className="merchant-triage-label">Cut steps</span>
                                  <div className="merchant-waterfall">
                                    {steps.map(s => (
                                      <span key={s.label} className="merchant-step">
                                        <span className="muted">{s.label}</span>{' '}
                                        <Native v={s.amount} cur={s.currency} size={13} />
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                              <div className="merchant-triage-foot">
                                <button type="button" className="btn small" onClick={() => openInWorkspace(r)}>
                                  {r.workspaceId ? 'Open saved search ↗' : 'Open in Workspace ↗'}
                                </button>
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Truncation footer: visible only when shop exceeds loaded slice */}
      {(shop.truncated || canLoadMore) && (
        <div className="merchant-foot">
          <span className="muted">
            Showing {summary.count} of {shop.total} listings ({orderLabel})
            {shop.apiCapReached ? ' — PoE trade caps one search at 100; switch order to inspect the other end' : ''}
          </span>
          <span className="spacer" />
          {canLoadMore && (
            <button
              type="button"
              className="btn small"
              disabled={busyMode !== null}
              onClick={() => runShopFetch({ sort: shop.sort || fetchOrder, more: true })}
            >
              {busyMode === 'more' ? 'Loading…' : `Load next ${Math.min(50, shop.remainingIds)}`}
            </button>
          )}
          <button
            type="button"
            className="link-btn"
            disabled={busyMode !== null}
            onClick={() => setFetchOrder(oppositeOrder)}
          >
            {oppositeLabel}
          </button>
        </div>
      )}
      {assetModal.node}
    </div>
  )
}
