// The Mods tab's pool arithmetic (docs/mods-page-design.md). Pure: plain objects in, plain
// objects out, no React, no I/O. The server (backend/app/modpool.py) builds each item type's
// pools: sections with prefix/suffix (or corrupted/enchant) families, tiers sorted best first.
// Here: which tiers are in the pool between the two edges, and the numbers that follow.
//
// PoE2 spawn weights are 0 or 1, so every tier in a pool is equally likely: a family's weight
// is its tiers in the pool, the overall weight is the column's sum, and the chance is the
// ratio. A tier is in the pool iff floor ≤ level ≤ item level: a tier below the floor cannot
// roll (the orb's Minimum Modifier Level), one above the item level cannot either. Strict.

export const AFFIXES = ['prefix', 'suffix', 'corrupted', 'enchant']

export const tagLabel = (id) => id.split('_').filter(w => w !== 'mod').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

// A fetched pool, made ready: every family gets `search` (text and tag labels, lower case) so
// the filter box is one `includes` per row.
export function prepare(pool) {
  const labels = new Map((pool.tags || []).map(t => [t.id, t.label]))
  const label = (id) => labels.get(id) || tagLabel(id)
  for (const s of pool.sections) for (const a of AFFIXES) for (const f of s[a] || []) f.search = `${f.text} ${f.tags.map(label).join(' ')}`.toLowerCase()
  return pool
}

// Whether the family's tiers carry names (a corruption implicit and its upgrade never do).
export const namedTiers = (family) => family.tiers.some(t => t.name)

// Where a tier sits against the two edges: above the item level, in the pool, below the floor.
export const bandOf = (tier, ilvl, floor) => (tier.ilvl > ilvl ? 'above' : tier.ilvl < floor ? 'below' : 'in')

// Tiers are sorted by level, best first: the first index whose level is at most `level`.
function firstAtOrBelow(tiers, level) {
  let lo = 0, hi = tiers.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (tiers[mid].ilvl > level) lo = mid + 1; else hi = mid }
  return lo
}

// The tiers of a family inside floor ≤ level ≤ ilvl: two binary searches, no copies.
export const inPool = (tiers, ilvl, floor) => Math.max(0, firstAtOrBelow(tiers, floor - 1) - firstAtOrBelow(tiers, ilvl))

// The pool between the floor and the item level: per column the rows (one per family, in pool
// order, keyed by the section's own family object) and the total; chance is null when the
// column is empty so nothing ever reads NaN. Rows are cheap value objects; a renderer derives
// each tier's band with `bandOf`. With `onItem` (family id → the tier the pasted item carries)
// those families show their tier and count for nothing: a mod already on the item cannot roll
// again, so the chances are over what can still land.
export function atLevel(section, ilvl, floor, onItem = null) {
  const out = {}
  for (const affix of AFFIXES) {
    if (!Array.isArray(section[affix])) continue
    const rows = section[affix].map(family => {
      const row = { family, k: inPool(family.tiers, ilvl, floor), n: family.tiers.length, chance: null }
      if (onItem && onItem.has(family.id)) row.onItem = onItem.get(family.id)
      return row
    })
    const total = rows.reduce((s, r) => s + (r.onItem === undefined ? r.k : 0), 0)
    for (const r of rows) r.chance = total && r.onItem === undefined ? r.k / total : null
    out[affix] = { rows, total }
  }
  return out
}

// Which rows show: any picked tag (OR) and the text (family text or a tag label). Never a number.
export function visible(rows, { tags, q }) {
  const needle = (q || '').trim().toLowerCase()
  return rows.filter(({ family }) => (!tags || !tags.size || family.tags.some(t => tags.has(t))) && (!needle || (family.search || family.text.toLowerCase()).includes(needle)))
}

// The chance the orb adds any of these rows; null when the pool is empty.
export function shownChance(rows) {
  if (!rows.length) return 0
  if (rows.every(r => r.chance === null)) return null
  return rows.reduce((s, r) => s + (r.chance || 0), 0)
}
