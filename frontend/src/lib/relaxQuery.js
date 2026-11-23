// Feature 3: "Close-enough" fuzzy rare finder — pure query relaxation and real-rate currency selection.
// Operates on EE2 History's stored `node.q` JSON or a Workspace search's query object without mutating it.
import { INSTANT_BUYOUT } from './regex/trade.js'
import { pageFromRecheck, repriceQuery, verdict } from './reprice.js'

const LEVELS = {
  1: { drop: 1, lo: 0.85, hi: 1.15, keepPct: 85, minMods: 2 },
  2: { drop: 2, lo: 0.75, hi: 1.25, keepPct: 75, minMods: 3 },
}

// Defense and DPS equipment filters relaxed alongside mod rolls (rune_sockets etc. stay untouched).
const RELAXABLE_EQUIP_KEYS = new Set(['es', 'ar', 'ev', 'dps', 'pdps', 'edps'])

const scaled = (v, factor) => Number((v * factor).toPrecision(12))
const isActiveFilter = (f) => !!f && typeof f === 'object' && typeof f.id === 'string' && f.id.length > 0 && !f.disabled

// Extract the trade query object from a Workspace/EE2 node's stored `q` JSON string.
export function parseNodeQuery(node) {
  if (!node || node.degraded || typeof node.q !== 'string' || !node.q.trim()) return null
  try {
    const j = JSON.parse(node.q)
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null
    if (j.query && typeof j.query === 'object' && !Array.isArray(j.query)) return j.query
    return j
  } catch {
    return null
  }
}

function classifyStats(query) {
  const andFilters = []
  const multiCountGroups = []
  const aliasCountGroups = []
  const preserved = []
  if (!query || typeof query !== 'object' || !Array.isArray(query.stats)) {
    return { andFilters, multiCountGroups, aliasCountGroups, preserved }
  }
  for (const g of query.stats) {
    if (!g || typeof g !== 'object' || g.disabled) {
      if (g) preserved.push(g)
      continue
    }
    if (g.type === 'and' && Array.isArray(g.filters)) {
      for (const f of g.filters) if (isActiveFilter(f)) andFilters.push(f)
      continue
    }
    if (g.type === 'count' && Array.isArray(g.filters)) {
      const active = g.filters.filter(isActiveFilter)
      const gMin = Number(g.value?.min)
      if (Number.isFinite(gMin) && gMin >= 2 && active.length >= 2) {
        multiCountGroups.push({ group: g, active, min: Math.min(active.length, gMin) })
      } else if (active.length > 0) {
        aliasCountGroups.push({ group: g, active })
      } else {
        preserved.push(g)
      }
      continue
    }
    preserved.push(g)
  }
  return { andFilters, multiCountGroups, aliasCountGroups, preserved }
}

function relaxPlan(query) {
  const cls = classifyStats(query)
  if (cls.andFilters.length >= 2) {
    return { mode: 'and', total: cls.andFilters.length, minBase: cls.andFilters.length, cls }
  }
  if (cls.andFilters.length === 0 && cls.multiCountGroups.length >= 1) {
    const total = cls.multiCountGroups.reduce((a, mg) => a + mg.active.length, 0)
    const minBase = Math.max(...cls.multiCountGroups.map(mg => mg.min))
    return { mode: 'multiCount', total, minBase, cls }
  }
  const logical = cls.andFilters.length + cls.aliasCountGroups.length
  if (cls.aliasCountGroups.length >= 1 && logical >= 2) {
    return { mode: 'alias', total: logical, minBase: logical, cls }
  }
  return null
}

// Eligible iff `query.stats` has >= 2 enabled stat filters in enabled `and` / `count` groups
// (treating active `count (min: 1)` dual-ID alias groups as 1 logical mod each).
export function canRelax(query) {
  return !!relaxPlan(query)
}

function relaxValue(val, lo, hi) {
  if (!val || typeof val !== 'object') return val
  const out = { ...val }
  if (typeof out.min === 'number' && Number.isFinite(out.min)) {
    if (out.min > 0) out.min = Math.max(1, Math.floor(scaled(out.min, lo)))
    else if (out.min < 0) out.min = Math.floor(scaled(out.min, hi))
  }
  if (typeof out.max === 'number' && Number.isFinite(out.max)) {
    if (out.max > 0) out.max = Math.ceil(scaled(out.max, hi))
    else if (out.max < 0) out.max = Math.min(-1, Math.ceil(scaled(out.max, lo)))
  }
  return out
}

function relaxFilter(f, lo, hi) {
  const copy = structuredClone(f)
  delete copy.disabled
  if (copy.value && typeof copy.value === 'object') copy.value = relaxValue(copy.value, lo, hi)
  return copy
}

function relaxGroup(group, active, min, lo, hi) {
  const g = { ...group }
  delete g.disabled
  g.type = 'count'
  g.value = { ...(group.value || {}), min }
  g.filters = active.map(f => relaxFilter(f, lo, hi))
  return g
}

function buildSummary(plan, level, cfg) {
  const { mode, total, minBase, cls } = plan
  const required = mode === 'and'
    ? Math.max(1, total - cfg.drop)
    : mode === 'multiCount'
      ? cls.multiCountGroups.reduce((sum, mg) => sum + Math.max(1, mg.min - cfg.drop), 0)
      : total
  return {
    level,
    required,
    total,
    keepPct: cfg.keepPct,
    canRelaxFurther: level === 1 && minBase >= LEVELS[2].minMods,
  }
}

// Lightweight preview of the level-1 relaxation summary without deep-cloning the query.
export function relaxPreview(query, level = 1) {
  const cfg = LEVELS[level]
  if (!cfg) return null
  const plan = relaxPlan(query)
  if (!plan || plan.minBase < cfg.minMods) return null
  return buildSummary(plan, level, cfg)
}

// Relax a multi-mod query into a `count` group with widened roll bounds, Instant Buyout, and no single-currency lock.
export function relaxQuery(query, level = 1) {
  const cfg = LEVELS[level]
  if (!cfg) return null
  const plan = relaxPlan(query)
  if (!plan || plan.minBase < cfg.minMods) return null

  const { mode, cls } = plan
  const summary = buildSummary(plan, level, cfg)
  const q = structuredClone(query)
  q.status = { ...INSTANT_BUYOUT }

  const nextStats = []
  if (mode === 'and') {
    nextStats.push({
      type: 'count',
      value: { min: summary.required },
      filters: cls.andFilters.map(f => relaxFilter(f, cfg.lo, cfg.hi)),
    })
  } else if (mode === 'alias' && cls.andFilters.length) {
    nextStats.push({
      type: 'and',
      filters: cls.andFilters.map(f => relaxFilter(f, cfg.lo, cfg.hi)),
    })
  }
  for (const mg of cls.multiCountGroups) {
    nextStats.push(relaxGroup(mg.group, mg.active, Math.max(1, mg.min - cfg.drop), cfg.lo, cfg.hi))
  }
  for (const ag of cls.aliasCountGroups) {
    const aliasMin = Number.isFinite(Number(ag.group.value?.min)) ? Number(ag.group.value.min) : 1
    nextStats.push(relaxGroup(ag.group, ag.active, aliasMin, cfg.lo, cfg.hi))
  }
  for (const pg of cls.preserved) nextStats.push(structuredClone(pg))
  q.stats = nextStats

  // Relax defense/DPS equipment filters (es, ar, ev, dps, pdps, edps); leave rune_sockets etc. untouched.
  const ef = q.filters?.equipment_filters
  if (ef && !ef.disabled && ef.filters && typeof ef.filters === 'object') {
    for (const k of RELAXABLE_EQUIP_KEYS) {
      if (ef.filters[k] && typeof ef.filters[k] === 'object') {
        ef.filters[k] = relaxValue(ef.filters[k], cfg.lo, cfg.hi)
      }
    }
  }

  // Drop any single-currency lock while preserving trade_filters.collapse and other non-price trade filters.
  const tf = q.filters?.trade_filters
  if (tf?.filters?.price) {
    const opt = tf.filters.price.option
    if (opt && opt !== 'exalted_divine') {
      delete tf.filters.price
    } else if (opt === 'exalted_divine') {
      delete tf.filters.price.option
      if (!Object.keys(tf.filters.price).length) delete tf.filters.price
    }
    if (!Object.keys(tf.filters).length) delete q.filters.trade_filters
    if (!Object.keys(q.filters).length) delete q.filters
  }

  return { query: q, summary }
}

export function relaxSummary(summary) {
  if (!summary) return ''
  return `Relaxed ${summary.required}/${summary.total} · ${summary.keepPct}%`
}

// Apply a chosen filterable currency to a relaxed query via repriceQuery (preserves/converts price bounds without mutating input).
export function applyRelaxedCurrency(query, currency, prices = null) {
  if (!query || !currency) return query
  return JSON.parse(repriceQuery({ query, sort: { price: 'asc' } }, currency, prices)).query
}

// Rank fetched relaxed rows by real Divine-equivalent price (ascending; unpriced rows last).
export function rankRelaxedRows(rows, prices) {
  if (!Array.isArray(rows) || !rows.length) return []
  return rows
    .map((r, idx) => {
      const unit = prices?.[r?.currency]
      const divPrice = r?.amount > 0 && unit > 0 ? r.amount * unit : null
      return { ...r, divPrice, _idx: idx }
    })
    .sort((a, b) => {
      if (a.divPrice == null && b.divPrice == null) return a._idx - b._idx
      if (a.divPrice == null) return 1
      if (b.divPrice == null) return -1
      return a.divPrice - b.divPrice || a._idx - b._idx
    })
    .map(({ _idx, ...rest }) => rest)
}

// Evaluate fetched relaxed rows at real Divine-equivalent rates via reprice.js's shared rule.
// If another filterable currency beats the first listing's real price by > TAU (5%), return it.
export function bestRelaxedCurrency(rows, prices, options) {
  const rowsRanked = rankRelaxedRows(rows, prices)
  if (!Array.isArray(rows) || !rows.length || !prices) {
    return { currency: null, text: null, amount: null, divPrice: null, rowsRanked }
  }
  const first = rows[0]
  const leadUnit = prices[first?.currency]
  const leadDiv = first?.amount > 0 && leadUnit > 0 ? first.amount * leadUnit : null
  if (leadDiv == null || !Array.isArray(options) || !options.length) {
    return { currency: null, text: null, amount: first?.amount ?? null, divPrice: leadDiv, rowsRanked }
  }

  const filterable = []
  for (const o of options) {
    const id = typeof o === 'string' ? o : o?.id
    if (id && id !== 'exalted_divine') filterable.push({ id, text: (typeof o === 'object' && o?.text) || id })
  }
  if (!filterable.length) {
    return { currency: null, text: null, amount: first.amount, divPrice: leadDiv, rowsRanked }
  }

  const normalized = rows.map((r, i) => ({ ...r, id: r?.id || `r${i}` }))
  const page = pageFromRecheck({ searchId: 'relax', ids: normalized.map(r => r.id), rows: normalized }, '_', {}, filterable, prices)
  const v = verdict(page, prices)
  if (v) {
    const best = rowsRanked.find(r => r.currency === v.currency && r.divPrice != null)
    return {
      currency: v.currency,
      text: v.text,
      amount: best?.amount ?? null,
      divPrice: best?.divPrice ?? null,
      rowsRanked,
    }
  }
  return { currency: null, text: null, amount: first.amount, divPrice: leadDiv, rowsRanked }
}
