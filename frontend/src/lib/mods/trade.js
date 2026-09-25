// Trading → Mods → "Search on trade": a family row as a Workspace search for items of the
// pool's kind carrying that mod. The desktop resolves what the site calls the mod and the kind
// (`found` = { stats: [[ids per line]] | null, category }); the query is the Regex tab's frame.
import { baseQuery } from '../regex/trade.js'

export function familyQuery(family, pool, found) {
  if (!found || !found.stats) return null
  const stats = found.stats.map(ids => ({ type: 'count', filters: ids.map(id => ({ id })), value: { min: 1 } }))
  const query = baseQuery(found.category ? { category: { option: found.category } } : {}, stats, null)
  return { query, name: `${family.text.split('\n').join(' / ')} · ${pool.name}` }
}
