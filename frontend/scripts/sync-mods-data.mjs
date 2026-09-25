#!/usr/bin/env node
// Build the Mods tab's tables (frontend/src/data/mods/{pools,mods}.json) from the RePoE PoE2
// export (https://repoe-fork.github.io/poe2/). Run by hand in a reviewed change; the drift test
// in frontend/test/mods-data.test.mjs fails the gate when the tables or their sources are stale.
//
//   node scripts/sync-mods-data.mjs            # fetch the export into ~/.cache/arbiter/repoe
//   node scripts/sync-mods-data.mjs --from DIR # use mods.json, base_items.json, item_classes.json in DIR
//
// pools.json: one pool per distinct spawn-tag set within an item class (poe2db's class ×
//   attribute unit, computed rather than hand-listed): { id, name, class, domain, tags, keywords }.
//   `domain` is where the class's base pool lives (item, misc for jewels, flask, sanctum_relic,
//   area for waystones, tablet, expedition_relic for logbooks).
// mods.json: prefix, suffix and corrupted families of the item domain plus the bone-keyed
//   families of the desecrated domain: { id, affix, domain, group, text, tags, tiers: [{ id, name,
//   ilvl, text, weights: [[tag, 0|1]] }] }, markup stripped, `#` where the roll goes. A family is
//   one mod group printing one text: a group that prints several texts (the five elements of
//   WeaponDamageTypePrefix) is several rows, one per text, each with its own tiers; the group is
//   kept for the game's one-mod-per-group rule.
// augments.json: every rune, soul core and idol with the classes it fits and what it grants there.
// essences.json is written by scripts/mods-essences.mjs (poe2db's essence pages) and only hashed here.
// MANIFEST.json: sha256 of every output and of every source file.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.resolve(HERE, '..', 'src', 'data', 'mods')
const SOURCE = 'https://repoe-fork.github.io/poe2/'
const FILES = ['mods.json', 'base_items.json', 'item_classes.json', 'augments.min.json']
const CACHE = path.join(os.homedir(), '.cache', 'arbiter', 'repoe')

// Every item class with a mod pool: the RePoE item_class id → the mod domain its pool lives in.
const EQUIPMENT = ['Ring', 'Amulet', 'Belt', 'Gloves', 'Boots', 'Body Armour', 'Helmet', 'Shield', 'Buckler', 'Focus', 'Quiver',
  'Wand', 'Sceptre', 'Staff', 'Warstaff', 'Bow', 'Crossbow', 'Spear', 'Flail', 'Claw', 'Dagger', 'Talisman', 'TrapTool',
  'One Hand Axe', 'One Hand Mace', 'One Hand Sword', 'Two Hand Axe', 'Two Hand Mace', 'Two Hand Sword']
const DOMAINS = {
  ...Object.fromEntries(EQUIPMENT.map(c => [c, 'item'])),
  Jewel: 'misc', LifeFlask: 'flask', ManaFlask: 'flask', UtilityFlask: 'flask',
  Relic: 'sanctum_relic', SanctumSpecialRelic: 'sanctum_relic', Map: 'area', TowerAugmentation: 'tablet', ExpeditionLogbook: 'expedition_relic',
}
const CLASSES = Object.keys(DOMAINS)
// A pool named after one tag rather than its bases (a waystone's tier band).
const TAG_NAMES = { map_key_low: 'Low (T1–5)', map_key_medium: 'Mid (T6–10)', map_key_high: 'High (T11–15)', map_key_highest: 'Top (T16)' }

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

// The game's [keyword|display] markup: the printed side.
export const stripMarkup = (text) => text.replace(/\[([^\]|]*)\|([^\]]*)\]/g, '$2').replace(/\[([^\]]*)\]/g, '$1')

// Every number and range → #, so a family's tiers share one text.
export const familyText = (text) => text.replace(/\(-?\d+(?:\.\d+)?--?\d+(?:\.\d+)?\)|\d+(?:\.\d+)?/g, '#')

const tierText = (text) => text.replace(/\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)/g, '($1–$2)')

// The tags a chip is worth: a compound tag whose part is itself a tag (elemental_damage beside
// elemental and damage, flat_life_regen beside life) says nothing the parts do not, and the
// bookkeeping tags (resource groups life and mana, drop is item rarity) filter nothing a crafter
// asks for. Most specific first: a family's chips are its rarest tags.
const GENERIC = new Set(['resource', 'drop', 'default', 'unveiled_mod'])
export function primaryTags(tags, universe, freq = new Map()) {
  const all = new Set(universe)
  return [...new Set(tags)].filter(t => !GENERIC.has(t) && !(t.includes('_') && t.split('_').some(part => all.has(part))))
    .sort((a, b) => (freq.get(a) ?? 0) - (freq.get(b) ?? 0) || (a < b ? -1 : 1))
}

const ATTR = /^((?:str|dex|int)(?:_(?:str|dex|int))*)_(?:armour|shield|special_relic)$/
const attrsOf = (tags) => { for (const t of tags) { const m = t.match(ATTR); if (m) return m[1].split('_').map(a => a.charAt(0).toUpperCase() + a.slice(1)) } return null }

// A pool's name: the class, `Class · Str/Int` from its attribute tags, or (a split with no
// attribute tag) the class and its bases with the shared class word dropped.
export function variantName(className, tags, baseNames, split = false) {
  const attrs = attrsOf(tags)
  if (attrs) return `${className} · ${attrs.join('/')}`
  if (!split) return className
  const named = tags.find(t => TAG_NAMES[t])
  if (named) return `${className} · ${TAG_NAMES[named]}`
  const words = baseNames.map(n => n.split(' '))
  const last = words[0][words[0].length - 1]
  // Bases that share their last word drop it (Bone Wand, Offering Wand → Bone, Offering); a lone
  // base drops it only when that word is the class itself (Breach Tablet → Breach, not Ruby → nothing).
  const shared = words.every(w => w.length > 1 && w[w.length - 1] === last) && (words.length > 1 || last === className || last === className.replace(/s$/, ''))
  const short = shared ? words.map(w => w.slice(0, -1).join(' ')) : baseNames
  const head = [...short].sort().slice(0, 3).join(', ')
  return `${className} · ${head}${short.length > 3 ? ` +${short.length - 3}` : ''}`
}

const ARMOUR = ['Body Armours', 'Helmets', 'Gloves', 'Boots', 'Shields', 'Bucklers', 'Foci']
const MARTIAL = ['Bows', 'Claws', 'Crossbows', 'Daggers', 'Flails', 'One Hand Axes', 'One Hand Maces', 'One Hand Swords', 'Quarterstaves', 'Spears', 'Talismans', 'Traps', 'Two Hand Axes', 'Two Hand Maces', 'Two Hand Swords']
const CASTER = ['Wands', 'Staves', 'Sceptres']
const JEWELLERY = ['Rings', 'Amulets', 'Belts', 'Quivers']
const GROUPS = { 'Martial Weapon': MARTIAL, 'Caster Weapon': CASTER, 'Weapon': [...MARTIAL, ...CASTER], 'Armour': ARMOUR, 'All Equipment': [...ARMOUR, ...MARTIAL, ...CASTER, ...JEWELLERY] }
const PLURAL = { Wand: 'Wands', Staff: 'Staves', Shield: 'Shields', Buckler: 'Bucklers', Crossbow: 'Crossbows', Bow: 'Bows', Spear: 'Spears', 'One Hand Mace': 'One Hand Maces', 'Two Hand Mace': 'Two Hand Maces', Quarterstaff: 'Quarterstaves', Talisman: 'Talismans', Sceptre: 'Sceptres', Focus: 'Foci' }

// A socketable's target (a class list, or a phrase such as "Wand or Staff") → our class names.
export function classesOf(target) {
  if (Array.isArray(target)) return target
  const out = []
  for (const part of stripMarkup(target).split(/,\s*|\s+(?:or|and)\s+/)) {
    const p = part.trim()
    if (GROUPS[p]) out.push(...GROUPS[p])
    else if (PLURAL[p]) out.push(PLURAL[p])
    else if (/s$/.test(p) && p.length > 3) out.push(p)
    else throw new Error(`unknown socketable target "${part}" in "${target}"`)
  }
  return [...new Set(out)]
}

// Lesser 0, plain 1, Greater 2, Perfect 3.
export const essenceTier = (name) => (name.startsWith('Lesser ') ? 0 : name.startsWith('Greater ') ? 2 : name.startsWith('Perfect ') ? 3 : 1)

function fetchSources(dir) {
  fs.mkdirSync(dir, { recursive: true })
  for (const f of FILES) {
    const p = path.join(dir, f)
    if (fs.existsSync(p) && fs.statSync(p).size > 0) continue
    console.log(`fetching ${SOURCE}${f}`)
    execFileSync('curl', ['-sSL', '--fail', '-o', p, SOURCE + f], { stdio: 'inherit' })
  }
  return dir
}

export function build(srcDir) {
  const read = (f) => fs.readFileSync(path.join(srcDir, f))
  const raw = Object.fromEntries(FILES.map(f => [f, read(f)]))
  const mods = JSON.parse(raw['mods.json'].toString('utf8'))
  const bases = JSON.parse(raw['base_items.json'].toString('utf8'))
  const classes = JSON.parse(raw['item_classes.json'].toString('utf8'))

  // Families: item-domain prefix/suffix mods grouped by affix + group + normalised text.
  const spawnTags = new Set()
  const byKey = new Map()
  let dropped = 0
  // The Watcher and Kulemak desecration sets belong to uniques the export does not name a base for; left out.
  const KEYS = ['ulaman_mod', 'amanamu_mod', 'kurgal_mod', 'breach_desecration']
  const POOL_DOMAINS = new Set(Object.values(DOMAINS))
  for (const [id, m] of Object.entries(mods)) {
    const weights = (m.spawn_weights || []).map(w => [w.tag, w.weight])
    let affix = m.generation_type
    const rolled = POOL_DOMAINS.has(m.domain) && ['prefix', 'suffix', 'corrupted'].includes(affix) && !m.is_essence_only
    const keyed = m.domain === 'desecrated' && ['prefix', 'suffix'].includes(affix) && weights.some(([t, w]) => w > 0 && KEYS.includes(t))
    // A Vaal Orb can also upgrade an implicit: the CorruptionUpgrade mods, filed as uniques.
    const upgrade = m.domain === 'item' && affix === 'unique' && id.startsWith('CorruptionUpgrade')
    if (upgrade) affix = 'enchant'
    if (!rolled && !keyed && !upgrade) continue
    if (!m.text || !weights.some(([, w]) => w > 0)) { dropped++; continue }
    for (const [t] of weights) spawnTags.add(t)
    const text = stripMarkup(m.text)
    const group = (m.groups && m.groups[0]) || m.type
    const key = `${m.domain}:${affix}:${group}\u0000${familyText(text)}`
    if (!byKey.has(key)) byKey.set(key, { affix, domain: m.domain, group, text: familyText(text), tags: new Set(), tiers: [] })
    const fam = byKey.get(key)
    for (const t of m.implicit_tags || []) fam.tags.add(t)
    fam.tiers.push({ id, name: m.name || '', ilvl: m.required_level || 0, text: tierText(text), weights })
  }
  // Ids: affix:group, numbered when one group prints as several families.
  const universe = new Set(), freq = new Map()
  for (const f of byKey.values()) for (const t of f.tags) { universe.add(t); freq.set(t, (freq.get(t) || 0) + 1) }
  const seen = new Map()
  const families = [...byKey.values()].map(f => {
    const base = `${f.affix}:${f.group}${f.domain === 'item' ? '' : '@' + f.domain}`
    const n = (seen.get(base) || 0) + 1; seen.set(base, n)
    return { id: n === 1 ? base : `${base}#${n}`, affix: f.affix, domain: f.domain, group: f.group, text: f.text, tags: primaryTags(f.tags, universe, freq), tiers: f.tiers.sort((a, b) => b.ilvl - a.ilvl || (a.id < b.id ? -1 : 1)) }
  })
  const splits = [...seen.values()].filter(n => n > 1).length

  // Pools: released equipment bases grouped by class and spawn-tag set.
  const groups = new Map()   // class id → Map(tagKey → { tags, bases })
  for (const b of Object.values(bases)) {
    if (!CLASSES.includes(b.item_class) || b.release_state !== 'released') continue
    const tags = [...new Set((b.tags || []).filter(t => spawnTags.has(t)))].sort()
    const key = tags.join(',')
    if (!groups.has(b.item_class)) groups.set(b.item_class, new Map())
    const g = groups.get(b.item_class)
    if (!g.has(key)) g.set(key, { tags, bases: [] })
    g.get(key).bases.push(b.name)
  }
  const pools = []
  for (const cls of CLASSES) {
    const g = groups.get(cls)
    if (!g) { console.warn(`no released bases for class ${cls}`); continue }
    let variants = [...g.values()]
    // A class split by attribute has unique-only "golden" bases with no attribute tag: not a pool.
    if (variants.some(v => attrsOf(v.tags))) variants = variants.filter(v => attrsOf(v.tags))
    const className = classes[cls]?.name || cls
    const split = variants.length > 1 && !variants.some(v => attrsOf(v.tags))
    // In a split without attribute tags the generic variant keeps the class name (the plain wands
    // beside the element-locked ones); a split into peers (jewels, waystone bands) names every one.
    const big = split ? variants.reduce((a, b) => (b.bases.length > a.bases.length ? b : a)) : null
    const largest = big && big.bases.length >= 3 && variants.every(v => v === big || big.bases.length > 2 * v.bases.length) ? big : null
    // A logbook's mods key on the areas it can hold, not on the base: its pool is every tag its domain uses.
    if (variants.every(v => !v.tags.some(t => families.some(f => f.domain === DOMAINS[cls] && f.tiers.some(tr => tr.weights.some(([tag, w]) => w > 0 && tag === t)))))) {
      const all = [...new Set(families.filter(f => f.domain === DOMAINS[cls]).flatMap(f => f.tiers.flatMap(tr => tr.weights.filter(([, w]) => w > 0).map(([tag]) => tag))))].sort()
      for (const v of variants) v.tags = all
    }
    for (const v of variants) {
      const attrs = attrsOf(v.tags)
      const name = v === largest ? className : variantName(className, v.tags, v.bases, split)
      const id = attrs ? `${slug(cls)}_${attrs.join('_').toLowerCase()}` : v === largest || !split ? slug(cls) : `${slug(cls)}_${slug(v.bases[0])}`
      pools.push({ id, name, class: className, domain: DOMAINS[cls], tags: v.tags, keywords: [...new Set(v.bases)].sort() })
    }
  }
  // A pool nothing rolls on (sanctified relics: no mod keys on their tags) is not a pool.
  const tagSet = (p) => new Set(p.tags)
  const rolls = (p) => families.some(f => ['prefix', 'suffix'].includes(f.affix) && (f.domain === DOMAINS[CLASSES.find(c => (classes[c]?.name || c) === p.class)]) && f.tiers.some(t => { for (const [tag, w] of t.weights) if (tagSet(p).has(tag)) return w > 0; return false }))
  for (const p of pools.filter(p => !rolls(p))) console.warn(`no mods roll on ${p.id}; dropped`)
  const kept = pools.filter(rolls)
  pools.length = 0; pools.push(...kept)
  if (new Set(pools.map(p => p.id)).size !== pools.length) throw new Error('pool ids collide')

  // Socketables: name from the base, type from the markup, each category → the classes it fits.
  const augmentsRaw = JSON.parse(raw['augments.min.json'].toString('utf8'))
  const augments = Object.entries(augmentsRaw).map(([mid, a]) => ({
    id: slug(mid.split('/').pop()),
    name: bases[mid]?.name || mid.split('/').pop(),
    type: stripMarkup(a.type_name || ''),
    level: a.required_level ?? null,
    limit: a.limit ? stripMarkup(a.limit) : null,
    fits: Object.values(a.categories || {}).map(c => ({ classes: classesOf(c.target), text: (c.stat_text || []).map(stripMarkup), bonded: (c.bonded_stat_text || []).map(stripMarkup) })),
  })).filter(a => a.fits.length && a.name).sort((a, b) => (a.name < b.name ? -1 : 1))

  fs.mkdirSync(DATA, { recursive: true })
  fs.writeFileSync(path.join(DATA, 'pools.json'), JSON.stringify({ pools }, null, 1) + '\n')
  fs.writeFileSync(path.join(DATA, 'mods.json'), JSON.stringify({ families }) + '\n')
  fs.writeFileSync(path.join(DATA, 'augments.json'), JSON.stringify({ augments }) + '\n')
  const files = {}
  for (const f of fs.readdirSync(DATA).filter(f => f !== 'MANIFEST.json').sort()) { const buf = fs.readFileSync(path.join(DATA, f)); files[f] = { sha256: sha(buf), bytes: buf.length } }
  const sources = Object.fromEntries(FILES.map(f => [f, sha(raw[f])]))
  fs.writeFileSync(path.join(DATA, 'MANIFEST.json'), JSON.stringify({ source: SOURCE, sources, files }, null, 2) + '\n')
  console.log(`${pools.length} pools, ${families.length} families (${splits} groups split by text, ${dropped} mods dropped), ${augments.length} augments, ${files['mods.json'].bytes} bytes of mods`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf('--from')
  build(i > 0 ? path.resolve(process.argv[i + 1]) : fetchSources(CACHE))
}
