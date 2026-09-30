// Our refinement of the search EE2 builds (the vendored port stays EE2-exact). EE2 leaves a waystone's
// properties unticked, so its search was "any rare waystone of that tier". With `waystoneStats` on (the
// default; Settings → Trading → ExiledExchange2 searches) a waystone's search also requires what sets
// its price — pack size, item rarity and waystone drop chance, each `range`% under the item's own value
// (EE2's searchStatRange) — and the item's corrupted state. Validated against the trade API 2026-09-30.
// Returns `q` unchanged when off, for anything that is not a waystone, or when `q` cannot be read.
'use strict'

// Waystone property line → the trade API's map filter (GGG /api/trade2/data/filters, map_filters).
const PROPS = [
  [/^Pack Size: \+?(\d+)%/m, 'map_packsize'],
  [/^Item Rarity: \+?(\d+)%/m, 'map_iir'],
  [/^Waystone Drop Chance: \+?(\d+)%/m, 'map_bonus'],
]

// obj[a][b][c]…, creating each level that is missing.
const branch = (obj, ...keys) => keys.reduce((o, k) => (o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {}), obj)

function refineQuery(q, raw, { waystoneStats = true, range = 10 } = {}) {
  const text = String(raw || '').replace(/\r\n/g, '\n')
  if (!waystoneStats || !/^Item Class: Waystones$/m.test(text)) return q
  let doc
  try { doc = JSON.parse(q) } catch { return q }
  const query = doc && doc.query
  if (!query) return q
  const keep = Math.max(0, 100 - (Number(range) || 0)) / 100
  const map = branch(query, 'filters', 'map_filters', 'filters')
  for (const [re, id] of PROPS) {
    const m = text.match(re)
    if (m) map[id] = { min: Math.floor(Number(m[1]) * keep) }
  }
  branch(query, 'filters', 'misc_filters', 'filters').corrupted = { option: /^Corrupted$/m.test(text) ? 'true' : 'false' }
  return JSON.stringify(doc)
}

module.exports = { refineQuery }
