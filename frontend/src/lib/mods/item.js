// Trading → Mods → "Paste item" (docs/mods-page-design.md): the copied item against its pool.
// Main hands over the compact parse (base, rarity, item level, each mod's type, affix, tier name,
// tier and printed lines; never the text). Pure: the pool by the base, each explicit mod's family
// and tier, the affix counts, and the slots the rarity allows.

const ROLLED = new Set(['explicit', 'fractured', 'desecrated'])
const SLOTS = { Rare: { prefix: 3, suffix: 3 }, Magic: { prefix: 1, suffix: 1 }, Normal: { prefix: 0, suffix: 0 } }

// The pool whose bases name the item's base, else null.
export const poolFor = (pools, item) => (item && (pools || []).find(p => (p.keywords || []).includes(item.baseType))) || null

// The affix slots a rarity holds; null for a unique (its mods are not a pool's).
export const slotsFor = (rarity) => SLOTS[rarity] || null

// A printed line as the pool prints it: the leading sign dropped (the game prints "+39 to
// maximum Life" as the site does, "# to maximum Life"; the pool says "+# to maximum Life").
const bare = (line) => String(line).replace(/^[+-]/, '')
const key = (lines) => lines.map(bare).sort().join('\n')

// Each rolled mod's family in the pool: by tier name (the family whose tiers carry it), the
// printed text breaking a tie or standing in when the name is unknown; the base section wins
// over another section holding the same family. The rest of the rolled mods are loose (an
// essence-only mod, a mod of another pool); `count` is every rolled mod per affix.
export function matchItem(pool, item) {
  const out = { rolled: [], loose: [], count: { prefix: 0, suffix: 0 } }
  if (!pool || !item) return out
  const fams = []
  for (const s of pool.sections || []) for (const affix of ['prefix', 'suffix']) for (const f of s[affix] || []) fams.push({ family: f, section: s.id, affix, text: key(f.text.split('\n')) })
  const seen = new Set()
  for (const m of item.mods || []) {
    if (!ROLLED.has(m.type) || !m.affix) continue
    if (m.affix in out.count) out.count[m.affix] += 1
    const ofAffix = fams.filter(c => c.affix === m.affix && !seen.has(c.family.id))
    let hits = m.name ? ofAffix.filter(c => c.family.tiers.some(t => t.name === m.name)) : []
    if (hits.length > 1) hits = hits.filter(c => c.text === key(m.lines))
    if (!hits.length) hits = ofAffix.filter(c => c.text === key(m.lines))
    const hit = hits.find(c => c.section === 'base') || hits[0]
    if (!hit) { out.loose.push(m); continue }
    // The same family under another section's id (the Genesis Tree twin) is on the item too.
    const ids = hits.map(c => c.family.id)
    for (const id of ids) seen.add(id)
    // The tier comes from the name alone: the game prints its tiers on the other scale (higher
    // is better), the pool's are best first, so a printed tier is never carried over.
    const named = m.name ? hit.family.tiers.find(t => t.name === m.name) : null
    out.rolled.push({ family: hit.family, ids, section: hit.section, affix: m.affix, tier: named ? named.tier : null, name: m.name })
  }
  return out
}
