// The Mods tab's pure library (docs/mods-page-design.md): the server builds each item type's
// pools; here a pool is the tiers whose level lies between the floor and the item level, every
// tier equally likely (PoE2 spawn weights are 0/1), so weight = tiers in the pool, overall
// weight = the column's sum, chance = the ratio.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepare, atLevel, visible, shownChance, bandOf, inPool, tagLabel } from '../src/lib/mods/pool.js'

const tier = (tier, name, ilvl, text) => ({ tier, name, ilvl, text })
const fam = (id, text, tags, tiers) => ({ id, text, tags, tiers })
// A pool as the server sends it: tiers best first.
const POOL = () => prepare({ id: 'ring', name: 'Rings', tags: [{ id: 'life', label: 'Life', count: 1 }, { id: 'attack', label: 'Attack', count: 1 }, { id: 'energy_shield', label: 'Energy Shield', count: 1 }], sections: [
  { id: 'base', title: null, floored: true,
    prefix: [
      fam('prefix:Life', '+# to maximum Life', ['life'], [tier(1, 'Virile', 54, '+(100–119) to maximum Life'), tier(2, 'Rotund', 46, '+(85–99) to maximum Life'), tier(3, 'Stout', 33, '+(60–69) to maximum Life'), tier(4, 'Sanguine', 16, '+(30–39) to maximum Life'), tier(5, 'Healthy', 6, '+(20–29) to maximum Life'), tier(6, 'Hale', 1, '+(10–19) to maximum Life')]),
      fam('prefix:Mana', '+# to maximum Mana', ['mana'], [tier(1, 'Blue', 70, '+(70–84) to maximum Mana'), tier(2, 'Cobalt', 40, '+(40–49) to maximum Mana'), tier(3, 'Beryl', 1, '+(10–14) to maximum Mana')]),
      fam('prefix:Fire', 'Adds # to # Fire damage to Attacks', ['attack', 'fire'], [tier(1, 'Smoking', 90, 'Adds 6 to 10 Fire damage to Attacks'), tier(2, 'Heated', 1, 'Adds 1 to 3 Fire damage to Attacks')]),
    ],
    suffix: [fam('suffix:Str', '+# to Strength', ['attribute'], [tier(1, 'of the Bear', 22, '+(13–16) to Strength'), tier(2, 'of the Brute', 1, '+(5–8) to Strength')])] },
  { id: 'corrupted', title: 'Corrupted', floored: false, corrupted: [fam('corrupted:Mana', '+# to maximum Mana', ['mana'], [tier(1, '', 1, '+(20–30) to maximum Mana')])] },
], grants: { essences: [], alloys: [], augments: [] } })

test('atLevel: a tier is in the pool iff floor ≤ level ≤ item level, k / n, N = Σk, chance = k / N', () => {
  const base = POOL().sections[0]
  const at82 = atLevel(base, 82, 0)
  const life = at82.prefix.rows[0]
  assert.equal(life.k, 6); assert.equal(life.n, 6)
  assert.equal(at82.prefix.rows[1].k, 3, 'mana: all three tiers')
  assert.equal(at82.prefix.rows[2].k, 1, 'fire: T1 needs 90')
  assert.equal(at82.prefix.total, 10)
  assert.equal(life.chance, 0.6)
  assert.ok(Math.abs(at82.prefix.rows.reduce((s, r) => s + r.chance, 0) - 1) < 1e-9)
  assert.deepEqual(at82.prefix.rows[2].family.tiers.map(t => bandOf(t, 82, 0)), ['above', 'in'])
  assert.equal(at82.suffix.total, 2)
  const greater = atLevel(base, 50, 35)
  assert.equal(greater.prefix.rows[0].k, 1, 'Rotund (46) only: Virile is above 50, Stout (33) is below 35')
  assert.equal(greater.prefix.total, 2, 'Rotund, and Cobalt (40); Beryl is below, Blue above; both fire tiers are out')
  assert.equal(greater.prefix.rows[2].k, 0)
  assert.equal(greater.prefix.rows[2].chance, 0)
})

test('bands: above the item level, in the pool, below the floor, in that order; no keep-the-top-tier exception', () => {
  const base = POOL().sections[0]
  const r = atLevel(base, 50, 35).prefix.rows[0]
  assert.deepEqual(r.family.tiers.map(t => [t.name, bandOf(t, 50, 35)]), [['Virile', 'above'], ['Rotund', 'in'], ['Stout', 'below'], ['Sanguine', 'below'], ['Healthy', 'below'], ['Hale', 'below']])
  const strict = atLevel(base, 82, 60).prefix.rows[0]
  assert.equal(strict.k, 0, 'Virile is 54 < 60')
  assert.equal(strict.chance, 0)
  const tiers = base.prefix[0].tiers
  for (let L = 0; L <= 100; L += 7) for (const F of [0, 1, 6, 16, 33, 46, 54, 55, 100]) assert.equal(inPool(tiers, L, F), tiers.filter(t => F <= t.ilvl && t.ilvl <= L).length, `L=${L} F=${F}`)
})

test('atLevel: an empty pool has total 0 and null chances, never NaN; a one-column section works', () => {
  const pool = POOL()
  const empty = atLevel(pool.sections[0], 40, 60)
  assert.equal(empty.prefix.total, 0)
  assert.ok(empty.prefix.rows.every(r => r.k === 0 && r.chance === null))
  assert.equal(atLevel(pool.sections[0], 0, 0).prefix.total, 0)
  assert.equal(atLevel(pool.sections[0], 1, 0).prefix.total, 3, 'Hale, Beryl, Heated')
  const cor = atLevel(pool.sections[1], 82, 0)
  assert.equal(cor.corrupted.total, 1)
  assert.equal(cor.prefix, undefined)
})

test('rows keep order and family identity across levels (rows are keyed by family id)', () => {
  const base = POOL().sections[0]
  const a = atLevel(base, 10, 0), b = atLevel(base, 90, 0)
  assert.deepEqual(a.prefix.rows.map(r => r.family.id), b.prefix.rows.map(r => r.family.id))
  assert.equal(a.prefix.rows[0].family, base.prefix[0], 'the family object is the section\'s own')
})

test('prepare builds the search text from the family text and the pool\'s tag labels; visible never changes a number', () => {
  const pool = POOL()
  assert.equal(pool.sections[0].prefix[2].search, 'adds # to # fire damage to attacks attack fire')
  assert.equal(tagLabel('energy_shield'), 'Energy Shield')
  assert.equal(tagLabel('ulaman_mod'), 'Ulaman')
  const { rows } = atLevel(pool.sections[0], 82, 0).prefix
  assert.equal(visible(rows, { tags: new Set(), q: '' }).length, 3)
  assert.deepEqual(visible(rows, { tags: new Set(['life', 'fire']), q: '' }).map(r => r.family.id), ['prefix:Life', 'prefix:Fire'])
  assert.deepEqual(visible(rows, { tags: new Set(), q: 'MANA' }).map(r => r.family.id), ['prefix:Mana'])
  assert.deepEqual(visible(rows, { tags: new Set(), q: 'attack' }).map(r => r.family.id), ['prefix:Fire'], 'the tag label matches too')
  assert.deepEqual(visible(rows, { tags: new Set(['life']), q: 'mana' }), [])
  const shown = visible(rows, { tags: new Set(['life']), q: '' })
  assert.equal(shown[0].chance, 0.6, 'the denominator rule: filtering never moves a number')
  assert.ok(Math.abs(shownChance(shown) - 0.6) < 1e-9)
  assert.ok(Math.abs(shownChance(rows) - 1) < 1e-9)
  assert.equal(shownChance([]), 0)
  assert.equal(shownChance(atLevel(pool.sections[0], 40, 60).prefix.rows), null, 'an empty pool has no share to sum')
})
