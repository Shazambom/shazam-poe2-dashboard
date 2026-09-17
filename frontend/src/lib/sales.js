// Pure helpers for Trading → Sales: value conversion, header stats, relative time, item-card props.

// A sale's price in the reference currency (null when the currency has no known price).
export function saleValueRef(price, ref, prices) {
  if (!price || !Number.isFinite(Number(price.amount))) return null
  const cur = String(price.currency || '')
  if (cur === ref) return Number(price.amount)
  const px = prices?.[cur]
  return px > 0 ? Number(price.amount) * px : null
}

const DAY = 86400000
export function salesStats(rows, ref, prices, now = Date.now()) {
  let today = 0, week = 0, totalRef = 0, unpriced = 0
  for (const r of rows || []) {
    const t = Date.parse(r.time)
    if (Number.isFinite(t)) { if (now - t < DAY) today++; if (now - t < 7 * DAY) week++ }
    const v = saleValueRef(r.price, ref, prices)
    if (v == null) unpriced++; else totalRef += v
  }
  return { count: (rows || []).length, today, week, totalRef, unpriced }
}

export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, (now - t) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < DAY / 1000 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / (DAY / 1000))}d ago`
}

// GGG frameType → rarity key (the trade item JSON carries both; frameType is authoritative).
export const FRAME = { 0: 'normal', 1: 'magic', 2: 'rare', 3: 'unique', 4: 'gem', 5: 'currency', 6: 'divination', 8: 'prophecy', 9: 'relic' }
export function rarityOf(item) {
  const f = item?.frameType
  if (f != null && FRAME[f]) return FRAME[f]
  const r = String(item?.rarity || '').toLowerCase()
  return r in { normal: 1, magic: 1, rare: 1, unique: 1, gem: 1, currency: 1 } ? r : 'normal'
}

// One property line: "Energy Shield: 512" with the augmented flag when GGG marks the value mode 1.
export function propertyLine(p) {
  const name = cleanText(p?.name || '')
  const vals = Array.isArray(p?.values) ? p.values : []
  const text = vals.map(v => cleanText(Array.isArray(v) ? v[0] : v)).join(', ')
  const augmented = vals.some(v => Array.isArray(v) && v[1] === 1)
  if (name.includes('%0') || name.includes('%1')) return { text: name.replace(/%(\d)/g, (_, i) => (vals[+i] ? String(vals[+i][0]) : '')), augmented }
  return { text: text ? `${name}: ${text}` : name, augmented }
}

// GGG marks keyword links as "[Evasion|Evasion Rating]" (page|display) — show the display half.
export const cleanText = (t) => String(t ?? '').replace(/\[([^\]|]*)\|([^\]]*)\]/g, '$2').replace(/\[([^\]]*)\]/g, '$1')
const modText = (m) => cleanText(typeof m === 'string' ? m : (m?.description ?? m?.text ?? ''))

// The card's blocks in display order, from the trade item JSON (missing blocks are omitted).
export function itemCardProps(item) {
  const it = item || {}
  const blocks = []
  const props = (it.properties || []).map(propertyLine).filter(p => p.text)
  if (props.length) blocks.push({ kind: 'properties', lines: props })
  if (it.ilvl != null) blocks.push({ kind: 'ilvl', lines: [{ text: `Item Level: ${it.ilvl}` }] })
  const reqs = (it.requirements || []).map(propertyLine).filter(p => p.text)
  if (reqs.length) blocks.push({ kind: 'requirements', lines: [{ text: 'Requires ' + reqs.map(r => r.text).join(', ') }] })
  for (const [key, kind] of [['enchantMods', 'enchant'], ['runeMods', 'rune'], ['implicitMods', 'implicit'], ['explicitMods', 'explicit'], ['craftedMods', 'crafted'], ['fracturedMods', 'fractured']]) {
    const lines = (it[key] || []).map(modText).filter(Boolean)
    if (lines.length) blocks.push({ kind, lines: lines.map(text => ({ text })) })
  }
  const flags = []
  if (it.corrupted) flags.push('Corrupted'); if (it.mirrored) flags.push('Mirrored'); if (it.identified === false) flags.push('Unidentified')
  if (flags.length) blocks.push({ kind: 'flags', lines: flags.map(text => ({ text })) })
  return { name: it.name || '', typeLine: it.typeLine || it.baseType || '', rarity: rarityOf(it), icon: it.icon || null, blocks }
}
