// Trading → Mods → "Search on trade": one family of one pool → the stat ids and item category
// the trade site needs (the renderer builds the query, frontend/src/lib/mods/trade.js). Nothing
// is hand-listed: a stat's ids come from the site's stat catalogue and an item kind's category
// from its bases, both EE2's data (vendor/ee2-query/data, synced every release), read once.
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const DATA = path.join(__dirname, '..', 'vendor', 'ee2-query', 'data')
const BUNDLE = path.join(__dirname, '..', 'vendor', 'ee2-query', 'vendor', 'bundle.cjs')

// Where the site lists a mod, measured over every pool (2026-09-25): a rolled prefix/suffix is
// an explicit or, from a bone, a desecrated stat; a Vaal Orb's corrupted mod and its upgrade
// are enchants (89 of 95 texts; implicit carries 33).
const GROUPS = { prefix: ['explicit', 'desecrated'], suffix: ['explicit', 'desecrated'], corrupted: ['enchant'], enchant: ['enchant'] }
const groupsFor = (affix) => GROUPS[affix] || []

let _cat = null
let _byGroupLower = null
function catalogue() {
  if (_cat) return _cat
  // group id → (text → [ids]): a text can sit under two ids in one group.
  const byGroup = new Map()
  for (const g of JSON.parse(fs.readFileSync(path.join(DATA, 'trade', 'stats.json'), 'utf8')).result) {
    const m = new Map()
    for (const e of g.entries) {
      const ids = m.get(e.text) || []; ids.push(e.id); m.set(e.text, ids)
    }
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

function groupLowerIndex() {
  if (_byGroupLower) return _byGroupLower
  const { byGroup } = catalogue()
  const out = new Map()
  for (const [gid, m] of byGroup) {
    const ml = new Map()
    for (const [text, ids] of m) {
      const lk = text.toLowerCase()
      const lids = ml.get(lk)
      if (lids) lids.push(...ids)
      else ml.set(lk, [...ids])
    }
    out.set(gid, ml)
  }
  _byGroupLower = out
  return _byGroupLower
}

// The site prints a stat without its sign: "+# to maximum Life" is listed as "# to maximum Life".
const siteText = (line) => line.replace(/^\+/, '')
const cleanModLine = (t) => String(t ?? '').replace(/\[([^\]|]*)\|([^\]]*)\]/g, '$2').replace(/\[([^\]]*)\]/g, '$1').trim()

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

/** @type {Array<[string, string[]]>} */
const ITEM_MOD_GROUPS = [
  ['fracturedMods', ['fractured', 'explicit']],
  ['explicitMods', ['explicit', 'desecrated']],
  ['implicitMods', ['implicit']],
  ['craftedMods', ['crafted', 'explicit']],
  ['enchantMods', ['enchant']],
]

// A mod line as the site sends it: a string, or an object with a description or text.
const modLineText = (raw) => (typeof raw === 'string' ? raw : (raw?.description ?? raw?.text ?? ''))

// A cleaned mod line → its lower-case template (numbers as #, no leading +) and the numbers taken out.
function modTemplate(cleaned) {
  const nums = []
  const tmpl = cleaned
    .replace(/[+-]?\d+(?:\.\d+)?/g, (m) => { nums.push(Number(m)); return '#' })
    .replace(/^\+/, '')
    .toLowerCase()
  return { tmpl, nums }
}

// The stat ids of the first group (in order) that knows this template, or null.
function statIdsFor(byGroupLower, groups, tmpl) {
  for (const g of groups) {
    const hit = byGroupLower.get(g)?.get(tmpl)
    if (hit && hit.length) return hit
  }
  return null
}

// One number is the roll; several (a range like 10 to 20) average; none or a non-finite average is null.
function rollValue(nums) {
  const val = nums.length === 1
    ? nums[0]
    : nums.length >= 2
      ? nums.reduce((a, b) => a + b, 0) / nums.length
      : null
  return Number.isFinite(val) ? val : null
}

// Resolve a trade2 item JSON's rolled mod lines to trade2 stat ids + numeric roll values + category,
// reusing the already-loaded EE2 stats.json & items.ndjson catalogue (shared with Stash → Merchant).
function lookupItemMods(item) {
  if (!item || typeof item !== 'object') return null
  const { ofBase } = catalogue()
  const byGroupLower = groupLowerIndex()
  const category = ofBase.get(item.baseType) || ofBase.get(item.typeLine) || null
  const mods = []
  const seen = new Set()

  for (const [field, groups] of ITEM_MOD_GROUPS) {
    const lines = Array.isArray(item[field]) ? item[field] : []
    for (const raw of lines) {
      const cleaned = cleanModLine(modLineText(raw))
      if (!cleaned) continue
      const { tmpl, nums } = modTemplate(cleaned)
      const ids = statIdsFor(byGroupLower, groups, tmpl)
      if (!ids) continue
      const sig = ids.join('|')
      if (seen.has(sig)) continue
      seen.add(sig)
      mods.push({ ids, value: rollValue(nums) })
      if (mods.length >= 8) break
    }
    if (mods.length >= 8) break
  }

  if (!category && !mods.length) return null
  return { category, mods }
}

module.exports = { lookup, lookupItemMods, groupsFor }
