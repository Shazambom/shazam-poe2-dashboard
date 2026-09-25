// The Mods tab's pool arithmetic (docs/mods-page-design.md). Pure: plain objects in, plain
// objects out, no React, no I/O. PoE2 spawn weights are 0 or 1, so every tier in a pool is
// equally likely: a family's weight is its tiers in the pool, the overall weight is the column's
// sum, and the chance is the ratio. A tier is in the pool iff floor ≤ level ≤ item level: a
// tier below the floor cannot roll (the orb's Minimum Modifier Level), one above the item level
// cannot either. Strict at both ends.
//
// A base's pool is decided by its tags. Other currencies open further pools on the same item:
// desecration bones add a bone tag, the socketable uniques add theirs, the Genesis Tree its own,
// and a Vaal Orb draws from the corruption implicits. Each is a SECTION: the base tags plus the
// section's key tags, restricted to the families that key on them.

export const AFFIXES = ['prefix', 'suffix', 'corrupted', 'enchant']

const WEAPONS = ['Bows', 'Claws', 'Crossbows', 'Daggers', 'Flails', 'One Hand Axes', 'One Hand Maces', 'One Hand Swords', 'Quarterstaves', 'Sceptres', 'Spears', 'Staves', 'Talismans', 'Traps', 'Two Hand Axes', 'Two Hand Maces', 'Two Hand Swords', 'Wands']

// domain: which families; affixes: the columns; keys: tags the currency adds (a family must key
// on one of them); classes: where the socketable fits (the mods themselves carry no base tag);
// floored: whether the orb's minimum modifier level applies. It does for the base pool and the
// socketable uniques' pools (regular orbs roll them); a bone, the Genesis Tree and a Vaal Orb
// have no such floor (a bone's own floor never bites: every desecrated mod is level 65).
export const SECTIONS = Object.freeze([
  { id: 'base', title: null, domain: null, affixes: ['prefix', 'suffix'], keys: [], floored: true },
  { id: 'desecrated', title: 'Desecrated', domain: 'desecrated', affixes: ['prefix', 'suffix'], keys: ['ulaman_mod', 'amanamu_mod', 'kurgal_mod'], floored: false },
  { id: 'genesis_breach', title: 'Genesis Tree · Breach', domain: 'desecrated', affixes: ['prefix', 'suffix'], keys: ['breach_desecration'], classes: ['Amulets', 'Rings', 'Belts'], floored: false },
  { id: 'genesis_caster', title: 'Genesis Tree · Caster', domain: 'item', affixes: ['prefix', 'suffix'], keys: ['genesis_tree_caster'], classes: ['Amulets', 'Rings', 'Belts'], floored: false },
  { id: 'genesis_minion', title: 'Genesis Tree · Minion', domain: 'item', affixes: ['prefix', 'suffix'], keys: ['genesis_tree_minion'], classes: ['Amulets', 'Rings', 'Belts'], floored: false },
  { id: 'destruction', title: "Thrud's Might", domain: 'item', affixes: ['prefix', 'suffix'], keys: ['destruction'], floored: true, classes: WEAPONS },
  { id: 'marksman', title: "Kolr's Hunt", domain: 'item', affixes: ['prefix', 'suffix'], keys: ['marksman'], floored: true, classes: ['Gloves'] },
  { id: 'berserking', title: "Vorana's Carnage", domain: 'item', affixes: ['prefix', 'suffix'], keys: ['berserking'], floored: true, classes: ['Helmets'] },
  { id: 'decay', title: "Katla's Gloom", domain: 'item', affixes: ['prefix', 'suffix'], keys: ['decay'], floored: true, classes: ['Gloves'] },
  { id: 'soul', title: "Medved's Tending", domain: 'item', affixes: ['prefix', 'suffix'], keys: ['soul'], floored: true, classes: ['Body Armours'] },
  { id: 'chronomancy', title: "Uhtred's Sidereus", domain: 'item', affixes: ['prefix', 'suffix'], keys: ['chronomancy'], floored: true, classes: ['Boots'] },
  { id: 'corrupted', title: 'Corrupted', domain: 'item', affixes: ['corrupted'], keys: [], floored: false },
  { id: 'enchant', title: 'Corrupted upgrade', domain: 'item', affixes: ['enchant'], keys: [], floored: false },
].map(Object.freeze))

// The RePoE rule: walk the tier's spawn weights in order; the first tag the pool carries decides.
export function rollsOn(weights, tags) {
  for (const [tag, w] of weights) if (tags.has(tag)) return w > 0
  return false
}

const keysOn = (family, keys) => !keys.length || family.tiers.some(t => t.weights.some(([tag, w]) => w > 0 && keys.includes(tag)))

// The families that roll on a tag set, each with only the tiers that roll there, best (highest
// level) first and numbered T1..Tn. Families with no rolling tier are dropped. Game order kept.
function build(def, families, tags, section) {
  const out = { id: def.id, name: def.name, section: section.id }
  const domain = section.domain || def.domain || 'item'
  for (const affix of section.affixes) out[affix] = []
  for (const f of families) {
    if ((f.domain || 'item') !== domain || !section.affixes.includes(f.affix) || !keysOn(f, section.keys)) continue
    const tiers = f.tiers.filter(t => rollsOn(t.weights, tags))
    if (!tiers.length) continue
    tiers.sort((a, b) => b.ilvl - a.ilvl)
    out[f.affix].push({ id: f.id, affix: f.affix, text: f.text, tags: [...f.tags], tiers: tiers.map((t, i) => ({ id: t.id, tier: i + 1, name: t.name, ilvl: t.ilvl, text: t.text })) })
  }
  return out
}

// The base pool of an item type.
export const poolFor = (def, families) => build(def, families, new Set(def.tags), SECTIONS[0])

// Every pool the item type has, the base first, then each currency's pool that has anything in
// it. The currency pools are equipment's: a jewel, flask, relic, waystone, tablet or logbook has
// its base pool only.
export function sectionsFor(def, families) {
  const out = []
  for (const section of SECTIONS) {
    if (section.id !== 'base' && (def.domain || 'item') !== 'item') continue
    if (section.classes && !section.classes.includes(def.class)) continue
    const pool = build(def, families, new Set([...def.tags, ...section.keys]), section)
    if (section.id !== 'base' && !section.affixes.some(a => pool[a].length)) continue
    out.push({ id: section.id, title: section.title, floored: section.floored, pool })
  }
  return out
}

const stateOf = (t, ilvl, floor) => (t.ilvl > ilvl ? 'above' : t.ilvl < floor ? 'below' : 'in')

// The pool between the floor and the item level: per column the rows (one per family, in pool
// order, keyed by the pool's own family object) and the total; chance is null when the column
// is empty so nothing ever reads NaN.
export function atLevel(pool, ilvl, floor) {
  const out = {}
  for (const affix of AFFIXES) {
    if (!Array.isArray(pool[affix])) continue
    const rows = pool[affix].map(family => {
      const tiers = family.tiers.map(t => ({ ...t, state: stateOf(t, ilvl, floor) }))
      const k = tiers.filter(t => t.state === 'in').length
      return { family, k, n: tiers.length, chance: null, tiers }
    })
    const total = rows.reduce((s, r) => s + r.k, 0)
    for (const r of rows) r.chance = total ? r.k / total : null
    out[affix] = { rows, total }
  }
  return out
}

const LABELS = { dot_multi: 'Damage over Time', gem: 'Skill Gems', ulaman_mod: 'Ulaman', amanamu_mod: 'Amanamu', kurgal_mod: 'Kurgal', genesis_tree_caster: 'Caster', genesis_tree_minion: 'Minion', breach_desecration: 'Breach' }
export const tagLabel = (id) => LABELS[id] || id.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

// The pool's own tags with how many families carry each, most common first, then by id.
export function tagsOf(pool) {
  const count = new Map()
  for (const affix of AFFIXES) for (const f of pool[affix] || []) for (const t of f.tags) count.set(t, (count.get(t) || 0) + 1)
  return [...count].map(([id, n]) => ({ id, label: tagLabel(id), count: n })).sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1))
}

// Which rows show: any picked tag (OR) and the text (family text or a tag label). Never a number.
export function visible(rows, { tags, q }) {
  const needle = (q || '').trim().toLowerCase()
  return rows.filter(({ family }) => {
    if (tags && tags.size && !family.tags.some(t => tags.has(t))) return false
    if (!needle) return true
    return family.text.toLowerCase().includes(needle) || family.tags.some(t => tagLabel(t).toLowerCase().includes(needle))
  })
}

// The chance the orb adds any of these rows; null when the pool is empty.
export function shownChance(rows) {
  if (!rows.length) return 0
  if (rows.every(r => r.chance === null)) return null
  return rows.reduce((s, r) => s + (r.chance || 0), 0)
}
