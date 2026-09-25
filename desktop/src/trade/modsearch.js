// Trading → Mods → "Search on trade": one family of one pool → the stat ids and item category
// the trade site needs (the renderer builds the query, frontend/src/lib/mods/trade.js). Nothing
// is hand-listed: a stat's ids come from the site's stat catalogue and an item kind's category
// from its bases, both EE2's data (vendor/ee2-query/data, synced every release), read once.
'use strict'
const fs = require('fs')
const path = require('path')

const DATA = path.join(__dirname, '..', 'vendor', 'ee2-query', 'data')
const BUNDLE = path.join(__dirname, '..', 'vendor', 'ee2-query', 'vendor', 'bundle.cjs')

// Where the site lists a mod, measured over every pool (2026-09-25): a rolled prefix/suffix is
// an explicit or, from a bone, a desecrated stat; a Vaal Orb's corrupted mod and its upgrade
// are enchants (89 of 95 texts; implicit carries 33).
const GROUPS = { prefix: ['explicit', 'desecrated'], suffix: ['explicit', 'desecrated'], corrupted: ['enchant'], enchant: ['enchant'] }
const groupsFor = (affix) => GROUPS[affix] || []

let _cat = null
function catalogue() {
  if (_cat) return _cat
  // group id → (text → [ids]): a text can sit under two ids in one group.
  const byGroup = new Map()
  for (const g of JSON.parse(fs.readFileSync(path.join(DATA, 'trade', 'stats.json'), 'utf8')).result) {
    const m = new Map()
    for (const e of g.entries) { const ids = m.get(e.text) || []; ids.push(e.id); m.set(e.text, ids) }
    byGroup.set(g.id, m)
  }
  // EE2's own category → trade category table, read out of its bundle.
  const src = fs.readFileSync(BUNDLE, 'utf8')
  const table = src.slice(src.indexOf('CATEGORY_TO_TRADE_ID = /* @__PURE__ */ new Map(['), src.indexOf(']);', src.indexOf('CATEGORY_TO_TRADE_ID')))
  const tradeId = new Map([...table.matchAll(/\["([^"]+)"[^,]*,\s*"([^"]+)"\]/g)].map(m => [m[1], m[2]]))
  // base name → trade category, through EE2's category of the base.
  const ofBase = new Map()
  for (const line of fs.readFileSync(path.join(DATA, 'en', 'items.ndjson'), 'utf8').split('\n')) {
    if (!line) continue
    const it = JSON.parse(line)
    const cat = it.namespace === 'ITEM' && it.craftable && it.craftable.category
    if (cat && tradeId.has(cat)) ofBase.set(it.refName, tradeId.get(cat))
  }
  _cat = { byGroup, ofBase }
  return _cat
}

// The site prints a stat without its sign: "+# to maximum Life" is listed as "# to maximum Life".
const siteText = (line) => line.replace(/^\+/, '')

// { stats: [[ids of line 1], [ids of line 2], …] | null, category: 'accessory.ring' | null }
function lookup({ text, affix, bases }) {
  const { byGroup, ofBase } = catalogue()
  const groups = groupsFor(affix)
  const stats = String(text || '').split('\n').map(line => groups.flatMap(g => byGroup.get(g)?.get(siteText(line)) || []))
  const votes = new Map()
  for (const b of bases || []) { const c = ofBase.get(b); if (c) votes.set(c, (votes.get(c) || 0) + 1) }
  const category = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] || null
  return { stats: stats.every(ids => ids.length) ? stats : null, category }
}

module.exports = { lookup, groupsFor }
