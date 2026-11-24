// Pure domain logic for Stash → Merchant: valuation in Divines/reference, actionable verdicts
// (reprice | cut | vendor | fresh), currency-drop summary, PoE 2-safe highlight & batch regexes,
// waterfall price-cut suggestions, inline floor summary, Workspace/EE2 reuse, and sales matching.
import { INSTANT_BUYOUT, baseQuery, uniqueQuery } from './regex/trade.js'
import { escapeRe } from './regex/shortest.js'
import { LIMIT } from './regex/defaults.js'
import { matching } from './search.js'
import { relativeTime, rarityOf } from './sales.js'
import { compareAmountOrder, compareAmounts, makeExchange } from './price.js'
import { parseNodeQuery } from './relaxQuery.js'
import { TAU } from './reprice.js'
import { flatten } from './tree.js'

export const STALE_DAYS = 3
export const STALE_MS = STALE_DAYS * 24 * 3600 * 1000
export const BLEED_PCT = 0.15
export const DUST_CHAOS = 2
const DUST_DIV_FALLBACK = 0.02
export const HARD_CURRENCIES = new Set(['divine', 'mirror', 'hinekoras-lock'])
export const MAX_REGEX_LEN = LIMIT - 1   // 249 chars — strictly inside PoE 2's 250-char stash box
const VERDICT_RANK = { reprice: 0, cut: 1, vendor: 2, fresh: 3 }

// Linear interpolation on a sorted [{ t, v }] series (t in epoch seconds).
function sampleSeries(points, tSec) {
  if (!Array.isArray(points) || points.length < 2) return null
  const first = points[0], last = points[points.length - 1]
  if (!(first?.v > 0) || !(last?.v > 0)) return null
  if (tSec <= first.t) return first.v
  if (tSec >= last.t) return last.v
  let lo = 0, hi = points.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (points[mid].t <= tSec) lo = mid
    else hi = mid
  }
  const a = points[lo], b = points[hi]
  if (!(a?.v > 0) || !(b?.v > 0)) return a?.v > 0 ? a.v : (b?.v > 0 ? b.v : null)
  const span = b.t - a.t
  if (span <= 0) return a.v
  const frac = (tSec - a.t) / span
  return a.v + (b.v - a.v) * frac
}

// Compute fractional loss of Divine value since `indexedMs` for a soft currency using /api/inflation.
// When `indexedMs` predates the earliest point in the inflation series (by >1h), the figure
// reflects only the available window (`capped: true`, `windowDays`) rather than the full listing age.
function computeBleed(currency, indexedMs, inflation, inflMap) {
  if (!currency || HARD_CURRENCIES.has(currency) || !Number.isFinite(indexedMs) || !inflMap) {
    return { pct: null, capped: false, windowDays: null }
  }
  const soft = inflMap.get(currency)
  if (!soft || !Array.isArray(soft.points) || soft.points.length < 2) {
    return { pct: null, capped: false, windowDays: null }
  }

  const tSec = indexedMs / 1000
  const firstT = soft.points[0]?.t
  const lastT = soft.points[soft.points.length - 1]?.t
  const vThen = sampleSeries(soft.points, tSec)
  const vNow = Number(soft.current) > 0 ? Number(soft.current) : soft.points[soft.points.length - 1]?.v
  if (!(vThen > 0) || !(vNow > 0)) return { pct: null, capped: false, windowDays: null }

  let dThen = 1, dNow = 1, effFirstT = firstT, effLastT = lastT
  if (inflation.anchor !== 'divine') {
    const div = inflMap.get('divine')
    if (!div || !Array.isArray(div.points) || div.points.length < 2) {
      return { pct: null, capped: false, windowDays: null }
    }
    dThen = sampleSeries(div.points, tSec)
    dNow = Number(div.current) > 0 ? Number(div.current) : div.points[div.points.length - 1]?.v
    if (!(dThen > 0) || !(dNow > 0)) return { pct: null, capped: false, windowDays: null }
    effFirstT = Math.max(firstT, div.points[0]?.t)
    effLastT = Math.min(lastT, div.points[div.points.length - 1]?.t)
  }
  const capped = Number.isFinite(effFirstT) && tSec < effFirstT - 3600
  const windowDays = capped && Number.isFinite(effLastT)
    ? Math.max(1, Math.round((effLastT - effFirstT) / 86400))
    : null
  return { pct: 1 - ((vThen / dThen) / (vNow / dNow)), capped, windowDays }
}

function dustThresholdDiv(prices = {}, wealthPrices = null, exchangeFn = null) {
  const ex = exchangeFn || makeExchange(prices, wealthPrices)
  const dust = ex(DUST_CHAOS, 'chaos', 'divine')
  return dust != null ? dust : DUST_DIV_FALLBACK
}

export function enrichMerchantRows(rows, { prices = {}, inflation = null, now = Date.now(), ref = 'exalted', wealthPrices = null, exchange = null, workspaceIndex = null } = {}) {
  if (!Array.isArray(rows) || !rows.length) return []
  const ex = exchange || makeExchange(prices, wealthPrices)
  const list = Array.isArray(inflation?.currencies) ? inflation.currencies : null
  const inflMap = list ? new Map(list.map(c => [c.id, c])) : null
  const dustDiv = dustThresholdDiv(prices, wealthPrices, ex)

  return rows.map(row => {
    const amount = Number(row?.amount)
    const currency = String(row?.currency || '')
    const validAmount = Number.isFinite(amount) && amount >= 0 && currency !== ''
    const divValue = validAmount ? ex(amount, currency, 'divine') : null
    const refValue = validAmount ? ex(amount, currency, ref) : null

    const indexedMs = Date.parse(row?.indexed)
    const ageMs = Number.isFinite(indexedMs) ? Math.max(0, now - indexedMs) : null
    const ageLabel = relativeTime(row?.indexed, now)
    const stale = ageMs != null && ageMs >= STALE_MS
    const bleed = computeBleed(currency, indexedMs, inflation, inflMap)
    const bleedPct = bleed.pct
    const bled = bleedPct != null && bleedPct >= BLEED_PCT

    const title = row?.name || row?.typeLine || row?.baseType || 'Item'
    const baseOrType = row?.typeLine || row?.baseType || ''
    const subBase = row?.name && baseOrType && row.name !== baseOrType ? baseOrType : ''
    const rarity = rarityOf(row?.item || { rarity: row?.rarity })
    const vendorVerb = rarity === 'unique' ? 'Disenchant' : 'Vendor'

    // Single actionable verdict: never classify unpriced items (divValue == null) as vendor dust.
    let verdict = 'fresh'
    if (stale && divValue != null && divValue <= dustDiv) verdict = 'vendor'
    else if (bled) verdict = 'reprice'
    else if (stale) verdict = 'cut'

    const wsMatch = findWorkspaceMatch(row, rarity, workspaceIndex)
    const hasWsQuery = !!wsMatch?.query
    const hasModQuery = !!(row?.matchedMods?.mods?.length > 0)
    const regex = merchantHighlightRegex(row)
    const floorQueryObj = merchantFloorQueryObj(row, wsMatch)
    const floorQuery = JSON.stringify(floorQueryObj)
    const canInlinePriceCheck = rarity !== 'rare' || hasWsQuery || hasModQuery
    const querySource = hasWsQuery
      ? 'workspace'
      : (rarity === 'rare' && hasModQuery ? 'mods' : (rarity === 'unique' ? 'unique' : 'base'))

    return {
      ...row,
      divValue,
      refValue,
      ageMs,
      ageLabel,
      stale,
      bleedPct,
      bleedCapped: bleed.capped,
      bleedWindowDays: bleed.windowDays,
      bled,
      title,
      subBase,
      rarity,
      vendorVerb,
      verdict,
      regex,
      floorQueryObj,
      floorQuery,
      canInlinePriceCheck,
      workspaceId: wsMatch?.id || null,
      querySource,
    }
  })
}

export function merchantSummary(enriched) {
  const list = enriched || []
  let totalDiv = 0
  let repriceCount = 0
  let cutCount = 0
  let vendorCount = 0
  let freshCount = 0
  for (const r of list) {
    if (Number.isFinite(r?.divValue)) totalDiv += r.divValue
    if (r?.verdict === 'reprice') repriceCount++
    else if (r?.verdict === 'cut') cutCount++
    else if (r?.verdict === 'vendor') vendorCount++
    else freshCount++
  }
  const actionableCount = repriceCount + cutCount + vendorCount
  return { count: list.length, totalDiv, actionableCount, repriceCount, cutCount, vendorCount, freshCount }
}

// Group already-enriched bleeding listings by currency so the banner matches table badges 1:1.
export function merchantCurrencyAlerts(enriched) {
  const byCur = new Map()
  for (const r of enriched || []) {
    if (!r?.bled || !r.currency) continue
    const cur = byCur.get(r.currency) || {
      currency: r.currency,
      count: 0,
      maxBleedPct: 0,
      capped: false,
      windowDays: null,
    }
    cur.count++
    if (r.bleedPct > cur.maxBleedPct) {
      cur.maxBleedPct = r.bleedPct
      cur.capped = !!r.bleedCapped
      cur.windowDays = r.bleedWindowDays ?? null
    }
    byCur.set(r.currency, cur)
  }
  return [...byCur.values()].sort((a, b) => b.count - a.count || b.maxBleedPct - a.maxBleedPct)
}

function escapeName(raw) {
  // Replace literal double quotes with '.' so quoted PoE 2 stash terms never terminate early.
  return escapeRe(raw).replace(/"/g, '.')
}

function escapeTruncated(raw, maxBodyLen) {
  const escaped = escapeName(raw)
  if (escaped.length <= maxBodyLen) return { text: escaped, truncated: false }
  let out = ''
  for (const ch of raw) {
    const piece = ch === '"' ? '.' : escapeRe(ch)
    if (out.length + piece.length > maxBodyLen) break
    out += piece
  }
  return { text: out, truncated: true }
}

// PoE 2 stash-search highlight regex: ^<escaped name>$ capped safely under 250 chars
// without ever splitting an escape sequence. Terms containing whitespace are wrapped
// in double quotes so PoE 2's whitespace tokenizer does not split them into separate terms.
export function merchantHighlightRegex(row) {
  const raw = String(row?.name || row?.typeLine || row?.baseType || '').trim()
  if (!raw) return ''
  const esc = escapeName(raw)
  const needsQuotes = /\s/.test(raw)
  const full = needsQuotes ? `"^${esc}$"` : `^${esc}$`
  if (full.length <= MAX_REGEX_LEN) return full
  const overhead = needsQuotes ? 3 : 1   // `"^` + `"` vs `^`
  const { text } = escapeTruncated(raw, MAX_REGEX_LEN - overhead)
  return /\s/.test(text) ? `"^${text}"` : `^${text}`
}

// Pack deduplicated item names into PoE 2 stash-search regex chunks, each <= MAX_REGEX_LEN (249).
// Single-item chunks use ^name$ (quoted if whitespace); multi-item chunks use ^(a|b|c)$ (quoted if any entry has whitespace).
export function merchantBatchRegexes(rows) {
  const seen = new Set()
  const unique = []
  for (const r of rows || []) {
    const raw = String(r?.name || r?.typeLine || r?.baseType || '').trim()
    if (!raw) continue
    const key = raw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ raw, esc: escapeName(raw), hasSpace: /\s/.test(raw) })
  }
  if (!unique.length) return []

  const chunks = []
  let cur = []
  let curBodyLen = 0   // sum of escaped lengths + '|' separators
  let curHasSpace = false

  const flush = () => {
    if (!cur.length) return
    if (cur.length === 1) {
      chunks.push({ regex: merchantHighlightRegex({ name: cur[0].raw }), count: 1, names: [cur[0].raw] })
    } else {
      const inner = `^(${cur.map(x => x.esc).join('|')})$`
      chunks.push({
        regex: curHasSpace ? `"${inner}"` : inner,
        count: cur.length,
        names: cur.map(x => x.raw),
      })
    }
    cur = []
    curBodyLen = 0
    curHasSpace = false
  }

  for (const item of unique) {
    // Wrapper overhead for a multi-item chunk: `"^(` + `)$"` = 6 if quoted, else `^(` + `)$` = 4.
    const soloMultiOverhead = item.hasSpace ? 6 : 4
    if (item.esc.length + soloMultiOverhead > MAX_REGEX_LEN) {
      flush()
      chunks.push({ regex: merchantHighlightRegex({ name: item.raw }), count: 1, names: [item.raw] })
      continue
    }
    if (cur.length) {
      const nextHasSpace = curHasSpace || item.hasSpace
      const nextOverhead = nextHasSpace ? 6 : 4
      if (curBodyLen + 1 + item.esc.length + nextOverhead > MAX_REGEX_LEN) flush()
    }
    cur.push(item)
    curBodyLen += cur.length === 1 ? item.esc.length : item.esc.length + 1
    curHasSpace = curHasSpace || item.hasSpace
  }
  flush()
  return chunks
}

function roundPoEPrice(val, orig) {
  if (!(val > 0)) return null
  if (orig >= 5) return Math.max(1, Math.round(val))
  if (val >= 1) return Math.round(val * 10) / 10
  return Math.max(0.1, Math.round(val * 10) / 10)
}

// Read-only waterfall price-cut suggestions (-15%, -30%, -50%) in the item's native currency.
export function merchantWaterfallSteps(row) {
  const amt = Number(row?.amount)
  const currency = String(row?.currency || '')
  if (!(amt > 0) || !currency) return []
  const steps = []
  const seen = new Set([amt])
  for (const [label, mult] of [['−15%', 0.85], ['−30%', 0.70], ['−50%', 0.50]]) {
    const next = roundPoEPrice(amt * mult, amt)
    if (next == null || next >= amt || seen.has(next)) continue
    seen.add(next)
    steps.push({ label, amount: next, currency })
  }
  return steps
}

export function filterMerchantRows(rows, { verdict = 'all', search = '', hideDone = false, doneIds = null } = {}) {
  let out = rows || []
  if (hideDone && doneIds && doneIds.size > 0) out = out.filter(r => !doneIds.has(r.id))
  if (verdict === 'actionable') out = out.filter(r => r.verdict !== 'fresh')
  else if (verdict !== 'all') out = out.filter(r => r.verdict === verdict)
  const q = String(search || '').trim()
  if (q) {
    out = matching(out, q, r => [r.title, r.subBase, r.rarity, r.stashName, r.currency].filter(Boolean))
  }
  return out
}

// Mixed-currency listings rank pairwise through the shared comparators in price.js (Arbitrage's Profit uses them too).
export const compareMerchantPrices = compareAmounts
const comparePriceOrder = compareAmountOrder

export function sortMerchantRows(rows, { key = 'verdict', dir = 'asc', exchange = null } = {}) {
  const mult = dir === 'desc' ? -1 : 1
  const list = [...(rows || [])]
  list.sort((a, b) => {
    if (key === 'price') {
      const p = comparePriceOrder(a, b, exchange, mult)
      if (p !== 0) return p
      return (b.ageMs ?? -1) - (a.ageMs ?? -1)
    }
    if (key === 'age') {
      const av = a.ageMs ?? -1
      const bv = b.ageMs ?? -1
      if (av !== bv) return (av - bv) * mult
      return comparePriceOrder(a, b, exchange, -1)
    }
    if (key === 'item') {
      return String(a.title || '').localeCompare(String(b.title || '')) * mult
    }
    // Default 'verdict': most urgent action first, tie-break highest real value first.
    const ar = VERDICT_RANK[a.verdict] ?? 9
    const br = VERDICT_RANK[b.verdict] ?? 9
    if (ar !== br) return (ar - br) * mult
    const p = comparePriceOrder(a, b, exchange, -1)
    if (p !== 0) return p
    return (b.ageMs ?? -1) - (a.ageMs ?? -1)
  })
  return list
}

// Index saved Workspace searches and EE2 History entries by lowercase name (and query.name)
// so Merchant reuses existing mod-filtered searches instead of duplicating them (same pattern as StashView).
export function indexWorkspaceSearches(tree) {
  const byName = new Map()
  if (!Array.isArray(tree) || !tree.length) return byName
  const score = (entry) => (entry.query?.stats?.length ? 2 : entry.query ? 1 : 0)
  const record = (key, entry) => {
    const k = String(key || '').trim().toLowerCase()
    if (!k) return
    const prev = byName.get(k)
    if (!prev || score(entry) > score(prev)) byName.set(k, entry)
  }
  for (const n of flatten(tree)) {
    if (n?.kind !== 'search' || n.degraded) continue
    const query = parseNodeQuery(n)
    const entry = { id: n.id, name: n.name || '', query }
    record(n.name, entry)
    if (query?.name) record(query.name, entry)
  }
  return byName
}

function findWorkspaceMatch(row, rarity, workspaceIndex) {
  if (!workspaceIndex || !(workspaceIndex instanceof Map) || workspaceIndex.size === 0) return null
  const name = String(row?.name || '').trim().toLowerCase()
  if (name && workspaceIndex.has(name)) return workspaceIndex.get(name)
  // Never match a named Rare onto a generic base search (e.g. "Gold Ring").
  if (rarity === 'rare' && name) return null
  const type = String(row?.typeLine || row?.baseType || '').trim().toLowerCase()
  if (type && workspaceIndex.has(type)) return workspaceIndex.get(type)
  return null
}

// Build trade2 stat groups from resolved desktop modsearch.lookupItemMods entries.
// Single-ID mods go in one `and` group; multi-ID mods use `count (min: 1)` alias groups
// (matching frontend/src/lib/mods/trade.js and natively relaxable by relaxQuery.js).
function buildModStats(matchedMods) {
  const mods = Array.isArray(matchedMods?.mods) ? matchedMods.mods.slice(0, 6) : []
  const andFilters = []
  const aliasGroups = []
  for (const m of mods) {
    const ids = Array.isArray(m?.ids) ? m.ids.filter(Boolean) : []
    if (!ids.length) continue
    const rawVal = Number(m.value)
    const min = Number.isFinite(rawVal) && rawVal > 0
      ? (rawVal > 2 ? Math.floor(rawVal * 0.8) : rawVal)
      : null
    const valObj = min != null ? { min } : null
    if (ids.length === 1) {
      andFilters.push(valObj ? { id: ids[0], value: valObj } : { id: ids[0] })
    } else {
      aliasGroups.push({
        type: 'count',
        value: { min: 1 },
        filters: ids.map(id => (valObj ? { id, value: valObj } : { id })),
      })
    }
  }
  const stats = []
  if (andFilters.length) stats.push({ type: 'and', filters: andFilters })
  stats.push(...aliasGroups)
  return stats
}

// Structured trade2 query object shared by inline priceCheck and Workspace handoff.
// Priority: (1) matching Workspace/EE2 History search, (2) mod-filtered Rare query from EE2 stat catalogue,
// (3) shared uniqueQuery / baseQuery from regex/trade.js.
export function merchantFloorQueryObj(row, workspaceMatch = null) {
  if (workspaceMatch?.query && typeof workspaceMatch.query === 'object') {
    const cloned = structuredClone(workspaceMatch.query)
    cloned.status = { ...INSTANT_BUYOUT }
    return { query: cloned, sort: { price: 'asc' } }
  }

  const name = String(row?.name || '').trim()
  const base = String(row?.baseType || row?.typeLine || '').trim()
  const rarity = String(row?.rarity || '').toLowerCase()

  if (rarity === 'unique' && row?.item?.identified === false && name && base) {
    return uniqueQuery(name, base)
  }

  if (rarity === 'rare' && row?.matchedMods?.mods?.length > 0) {
    const stats = buildModStats(row.matchedMods)
    if (stats.length) {
      const typeFilters = {
        rarity: { option: 'rare' },
        ...(row.matchedMods.category ? { category: { option: row.matchedMods.category } } : {}),
      }
      const frame = baseQuery(typeFilters, stats)
      if (!row.matchedMods.category && base) frame.query.type = base
      return frame
    }
  }

  if (rarity === 'unique' || rarity === 'rare') {
    const frame = baseQuery({ rarity: { option: rarity } }, [])
    if (rarity === 'rare') {
      // Rare item titles are random and not searchable as `query.name`; search base + rare rarity.
      if (base) frame.query.type = base
      else if (name) frame.query.name = name
    } else {
      if (name) frame.query.name = name
      if (base && base !== name) frame.query.type = base
    }
    return frame
  }

  const query = { status: INSTANT_BUYOUT }
  if (name && base && name !== base) {
    query.name = name
    query.type = base
  } else if (base) {
    query.type = base
  } else if (name) {
    query.name = name
  }
  return { query, sort: { price: 'asc' } }
}

// Clean trade2 JSON query string for Workspace handoff.
export function merchantFloorQuery(row, workspaceMatch = null) {
  return JSON.stringify(merchantFloorQueryObj(row, workspaceMatch))
}

// Summarize cheapest listings returned by merchant.priceCheck (or trade:recheck) relative to the player's ask.
// Detects when GGG's Exalted-Equivalent rank-0 currency is beaten by a cheaper currency sampled deeper (by > TAU).
export function summarizeFloorCheck(res, row, prices = {}, wealthPrices = null, exchangeFn = null) {
  if (!res?.ok) return null
  const ex = exchangeFn || makeExchange(prices, wealthPrices)
  const raw = Array.isArray(res.listings) ? res.listings : (Array.isArray(res.rows) ? res.rows : [])
  const valued = raw
    .filter(l => l && Number.isFinite(l.amount) && l.amount > 0 && typeof l.currency === 'string')
    .map(l => ({ amount: l.amount, currency: l.currency, div: ex(l.amount, l.currency, 'divine') }))
  const siteFirst = valued[0] || null
  const sorted = [...valued].sort((a, b) => comparePriceOrder(a, b, ex, 1))
  const cheapest = sorted[0] || null
  const floorDiv = cheapest?.div ?? null

  let pctAbove = null
  if (cheapest && row) {
    const rowInFloor = ex(row.amount, row.currency, cheapest.currency)
    if (rowInFloor != null && cheapest.amount > 0) {
      pctAbove = (rowInFloor - cheapest.amount) / cheapest.amount
    } else if (floorDiv > 0 && row.divValue != null) {
      pctAbove = (row.divValue - floorDiv) / floorDiv
    }
  }

  let cheaperCurrency = null
  if (siteFirst && cheapest && cheapest.currency !== siteFirst.currency) {
    const firstInCheapest = ex(siteFirst.amount, siteFirst.currency, cheapest.currency)
    if (firstInCheapest != null && firstInCheapest > cheapest.amount * (1 + TAU)) {
      cheaperCurrency = {
        currency: cheapest.currency,
        vs: siteFirst.currency,
        gap: firstInCheapest / cheapest.amount - 1,
      }
    }
  }

  return {
    total: Number(res.total) || raw.length,
    sampleCount: raw.length,
    cheapest,
    floorDiv,
    pctAbove,
    cheaperCurrency,
    relaxed: !!res.relaxed,
    relaxSummary: typeof res.relaxSummary === 'string' && res.relaxSummary ? res.relaxSummary : null,
  }
}

// Match an active Merchant listing against the player's local Merchant History sales ledger (/api/sales).
export function matchRecentSale(row, salesRows) {
  if (!row || !Array.isArray(salesRows) || !salesRows.length) return null
  const rarity = String(row.rarity || '').toLowerCase()
  const name = String(row.name || '').trim().toLowerCase()
  const type = String(row.typeLine || row.baseType || '').trim().toLowerCase()
  if (!name && !type) return null

  let best = null
  let bestTs = -Infinity
  for (const s of salesRows) {
    if (!s?.price || !(Number(s.price.amount) > 0) || !s.price.currency) continue
    const it = s.item || {}
    const sName = String(it.name || '').trim().toLowerCase()
    const sType = String(it.typeLine || it.baseType || '').trim().toLowerCase()
    let hit
    if (rarity === 'unique') {
      hit = !!name && sName === name
    } else if (name) {
      hit = sName === name && (!type || !sType || sType === type)
    } else {
      hit = !sName && !!type && sType === type
    }
    if (!hit) continue
    const ts = Date.parse(s.time)
    const ord = Number.isFinite(ts) ? ts : 0
    if (!best || ord > bestTs) {
      bestTs = ord
      best = {
        amount: Number(s.price.amount),
        currency: String(s.price.currency),
        time: s.time || null,
        itemName: it.name || it.typeLine || '',
      }
    }
  }
  return best
}
