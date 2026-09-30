// refineQuery: when "Match waystone stats" is on (the default), a waystone's search also requires what
// sets its price — pack size, item rarity and waystone drop chance, each at the EE2 roll range below
// the item's own value — and the item's corrupted state. Everything else EE2 built stays as it was.
// Validated 2026-09-30 against the trade API: this search returned only matching waystones.
import test from 'node:test'
import assert from 'node:assert/strict'
const { refineQuery } = await import('../src/ee2-history/refine.js')

const ARID = `Item Class: Waystones
Rarity: Rare
Arid Vector
Waystone (Tier 15)
--------
Revives Available: 0 (augmented)
Item Rarity: +12% (augmented)
Pack Size: +29% (augmented)
Monster Rarity: +18% (augmented)
Monster Effectiveness: +13% (augmented)
Waystone Drop Chance: +105% (augmented)
--------
Item Level: 81
--------
{ Prefix Modifier "Fleeting" (Tier: 1) }
Monsters have 10(10-15)% increased Attack, Cast and Movement Speed
--------
Can be used in a Map Device, allowing you to enter a Map. Waystones can only be used once.
--------
Corrupted
`
// What the app built for it (beta telemetry, trimmed to one stat): every filter off, no properties.
const BUILT = JSON.stringify({ query: { status: { option: 'securable' },
  stats: [{ type: 'and', filters: [{ id: 'explicit.stat_3909654181', value: { min: 10 }, disabled: true }] }],
  filters: { trade_filters: { filters: { collapse: { option: 'true' } } },
    type_filters: { filters: { category: { option: 'map' }, rarity: { option: 'nonunique' } } },
    map_filters: { filters: { map_tier: { min: 15, max: 15 } } },
    misc_filters: { filters: { mirrored: { option: 'false' }, sanctified: { option: 'false' } } } } },
  sort: { price: 'asc' } })

const filtersOf = (q) => JSON.parse(q).query.filters

test('a waystone search requires its pack size, rarity and drop chance, 10% under, and its corrupted state', () => {
  const f = filtersOf(refineQuery(BUILT, ARID, { waystoneStats: true, range: 10 }))
  assert.deepEqual(f.map_filters.filters, { map_tier: { min: 15, max: 15 }, map_packsize: { min: 26 }, map_iir: { min: 10 }, map_bonus: { min: 94 } })
  assert.deepEqual(f.misc_filters.filters.corrupted, { option: 'true' })
  assert.deepEqual(f.misc_filters.filters.mirrored, { option: 'false' }, 'what EE2 set is kept')
  assert.equal(JSON.parse(refineQuery(BUILT, ARID, { waystoneStats: true, range: 10 })).query.stats[0].filters[0].disabled, true, 'mod filters untouched')
})

test('the EE2 roll range sets the leeway; 0 means the exact values', () => {
  const f = filtersOf(refineQuery(BUILT, ARID, { waystoneStats: true, range: 0 }))
  assert.deepEqual([f.map_filters.filters.map_packsize, f.map_filters.filters.map_iir, f.map_filters.filters.map_bonus], [{ min: 29 }, { min: 12 }, { min: 105 }])
})

test('an uncorrupted waystone searches uncorrupted ones; a property it lacks adds no filter', () => {
  const clean = ARID.replace('Corrupted\n', '').replace('Item Rarity: +12% (augmented)\n', '')
  const f = filtersOf(refineQuery(BUILT, clean, { waystoneStats: true, range: 10 }))
  assert.deepEqual(f.misc_filters.filters.corrupted, { option: 'false' })
  assert.equal(f.map_filters.filters.map_iir, undefined)
})

test('off, not a waystone, or unreadable: the query is returned unchanged', () => {
  assert.equal(refineQuery(BUILT, ARID, { waystoneStats: false, range: 10 }), BUILT)
  const ring = 'Item Class: Rings\nRarity: Rare\nDoom Loop\nSapphire Ring\n--------\nItem Level: 79\n--------\nCorrupted\n'
  assert.equal(refineQuery(BUILT, ring, { waystoneStats: true, range: 10 }), BUILT)
  assert.equal(refineQuery('not json', ARID, { waystoneStats: true, range: 10 }), 'not json')
})

test('the renderer can switch it: preload → ee2:set-search → the consumer', async () => {
  const { readFileSync } = await import('node:fs')
  const preload = readFileSync(new URL('../src/preload.js', import.meta.url), 'utf8')
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  assert.match(preload, /setSearchPrefs: \(p\) => ipcRenderer\.send\('ee2:set-search', \{ waystoneStats: p\?\.waystoneStats !== false \}\)/)
  assert.match(main, /ipcMain\.on\('ee2:set-search', \(_e, p\) => \{ _history\?\.setSearchPrefs\(p\) \}\)/)
})
