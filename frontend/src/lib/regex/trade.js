// The same selection as a pathofexile.com/trade2 query object. A row's `trade` lists every stat
// id GGG carries for that text (some texts appear under two ids); a mod with none is left out.
import { normalizePrice } from './number.js'

// Every search is Instant Buyout ("securable"): the app's rule for the trade site, and what
// travel-to-hideout needs. The Workspace forces the site's delivery dropdown only for searches
// typed there; a query it mounts must carry the status itself.
const INSTANT_BUYOUT = { option: 'securable' }
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

export function tabletQuery(s, table) {
  const kinds = table.kinds || []
  const picked = kinds.filter(k => s.type[k.key])
  const rarity = rarityFilter(s.rarity)
  // Always 10 uses remaining, whatever the string asks for (owner, 2026-09-24).
  const stats = [...wantGroups(s.want, s.wantMode, table), { type: 'and', filters: [{ id: USES, value: { min: 10 } }] }]
  const q = baseQuery({ category: { option: 'map.tablet' }, ...(rarity ? { rarity } : {}) }, stats, priceFilter(s.price))
  // The trade site takes one base type; several picked kinds leave the category-only filter.
  if (picked.length === 1) q.query.type = picked[0].base
  return q
}
