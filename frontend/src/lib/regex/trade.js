// The same selection as a pathofexile.com/trade2 query object. A row's `trade` lists every stat
// id GGG carries for that text (some texts appear under two ids); a mod with none is left out.
import { normalizePrice } from './number.js'

// Every search is Instant Buyout ("securable"): the app's rule for the trade site, and what
// travel-to-hideout needs. The Workspace forces the site's delivery dropdown only for searches
// typed there; a query it mounts must carry the status itself.
export const INSTANT_BUYOUT = { option: 'securable' }
const DELIRIOUS = 'enchant.stat_1715784068'
const USES = 'pseudo.pseudo_number_of_uses_remaining'

const minOf = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? { min: n } : undefined }

// One filter per id of one mod, carrying the selection's minimum when it has one.
function filtersOf(mod, sel) {
  const min = mod.num && typeof sel === 'object' ? minOf(sel.min) : undefined
  return mod.trade.map(id => (min ? { id, value: min } : { id }))
}

// Wanted mods as stat groups. "any": one count group over every id, at least one. "all": one
// count group per mod, so a text GGG lists under two ids still needs only one of them.
function wantGroups(want, wantMode, table) {
  const byId = new Map(table.mods.map(m => [m.id, m]))
  const picked = (want || []).map(sel => { const m = byId.get(sel.id); return m && m.trade.length ? filtersOf(m, sel) : null }).filter(Boolean)
  if (!picked.length) return []
  if (wantMode === 'all') return picked.map(filters => ({ type: 'count', filters, value: { min: 1 } }))
  return [{ type: 'count', filters: picked.flat(), value: { min: 1 } }]
}

function avoidGroup(avoid, table) {
  const byId = new Map(table.mods.map(m => [m.id, m]))
  const filters = (avoid || []).flatMap(id => (byId.get(id)?.trade || []).map(tid => ({ id: tid })))
  return filters.length ? [{ type: 'not', filters }] : []
}

// Exactly one rarity picked is a filter; none or several is no filter.
function rarityFilter(r) {
  const on = ['normal', 'magic', 'rare'].filter(k => r?.[k])
  return on.length === 1 ? { option: on[0] } : undefined
}

const priceFilter = (price) => {
  if (!price?.trade) return null
  const r = normalizePrice(price.min, price.max)
  return r ? { filters: { price: { option: price.currency, ...r } } } : null
}

// The shared frame: instant buyout, sorted by price, the type filter, optional stat groups and
// price filter, plus whatever the kind adds under `filters`.
export function baseQuery(typeFilters, stats, price, extraFilters = {}) {
  const q = {
    query: { status: INSTANT_BUYOUT, filters: { type_filters: { disabled: false, filters: typeFilters }, ...extraFilters } },
    sort: { price: 'asc' },
  }
  if (stats.length) q.query.stats = stats
  if (price) q.query.filters.trade_filters = price
  return q
}

export function waystoneQuery(s, table) {
  const stats = [...wantGroups(s.want, s.wantMode, table), ...avoidGroup(s.avoid, table)]
  if (s.state.delirious) stats.push({ type: 'and', filters: [{ id: DELIRIOUS }] })

  const map = {}
  const { min, max } = s.tier
  if (min > 1 || (max > 0 && max < 16)) map.map_tier = { ...(min > 1 ? { min } : {}), ...(max > 0 && max < 16 ? { max } : {}) }
  const iir = minOf(s.itemRarity), pack = minOf(s.packSize), bonus = minOf(s.dropChance)
  if (iir) map.map_iir = iir
  if (pack) map.map_packsize = pack
  if (bonus) map.map_bonus = bonus

  const misc = {}
  if (s.state.corrupted && !s.state.uncorrupted) misc.corrupted = { option: 'true' }
  else if (s.state.uncorrupted && !s.state.corrupted) misc.corrupted = { option: 'false' }

  const rarity = rarityFilter(s.rarity)
  return baseQuery({ category: { option: 'map.waystone' }, ...(rarity ? { rarity } : {}) }, stats, priceFilter(s.price), {
    ...(Object.keys(map).length ? { map_filters: { disabled: false, filters: map } } : {}),
    ...(Object.keys(misc).length ? { misc_filters: { disabled: false, filters: misc } } : {}),
  })
}

// A tablet search only ever sees full tablets: any uses filter it had is replaced by "at least the
// tablet's full uses" (owner, 2026-09-24 and 2026-10-01: never a used-up tablet passed off as whole).
// 10 for a normal tablet; a unique's own (kv_ops tablet_uses).
export function withFullUses(stats, uses) {
  const kept = (stats || []).map(g => ({ ...g, filters: (g.filters || []).filter(f => f.id !== USES) }))
    .filter(g => g.filters.length || g.type !== 'and')
  return [...kept, { type: 'and', filters: [{ id: USES, value: { min: uses } }] }]
}

// A linked tablet search as the Strat Calculator prices it: the user's filters, held to full uses,
// uncorrupted (owner, 2026-10-01), Instant Buyout, cheapest first. null when it cannot be priced.
export function fullTabletQuery(linked, uses) {
  if (!linked?.query || typeof linked.query !== 'object' || !(uses > 0)) return null
  const q = linked.query
  const misc = q.filters?.misc_filters?.filters ?? {}
  return {
    query: {
      ...q, status: INSTANT_BUYOUT, stats: withFullUses(q.stats, uses),
      filters: { ...q.filters, misc_filters: { ...q.filters?.misc_filters, filters: { ...misc, corrupted: { option: 'false' } } } },
    },
    sort: { price: 'asc' },
  }
}

// A unique's price floor (owner, 2026-10-01): by name and base, unidentified (the baseline copy every
// unique trades as), no corrupted filter (some uniques, Voices, only come corrupted).
export const uniqueQuery = (name, type) => ({
  query: { status: INSTANT_BUYOUT, name, type, filters: { misc_filters: { filters: { identified: { option: 'false' } } } } },
  sort: { price: 'asc' },
})

// A linked waystone search as the Strat Calculator prices it: the user's filters as they are (no uses on
// a waystone; a corrupted one is ordinary stock), Instant Buyout, cheapest first. null when unusable.
export function waystonePriceQuery(linked) {
  if (!linked?.query || typeof linked.query !== 'object') return null
  return { query: { ...JSON.parse(JSON.stringify(linked.query)), status: INSTANT_BUYOUT }, sort: { price: 'asc' } }
}

export function tabletQuery(s, table) {
  const kinds = table.kinds || []
  const picked = kinds.filter(k => s.type[k.key])
  const rarity = rarityFilter(s.rarity)
  // Always 10 uses remaining, whatever the string asks for (owner, 2026-09-24).
  const stats = withFullUses(wantGroups(s.want, s.wantMode, table), 10)
  const q = baseQuery({ category: { option: 'map.tablet' }, ...(rarity ? { rarity } : {}) }, stats, priceFilter(s.price))
  // The trade site takes one base type; several picked kinds leave the category-only filter.
  if (picked.length === 1) q.query.type = picked[0].base
  return q
}
