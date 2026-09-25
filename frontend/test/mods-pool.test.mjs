// The Mods tab's pure library (docs/mods-page-design.md): a pool is the tiers whose level lies
// between the floor and the item level, every tier equally likely (PoE2 spawn weights are 0/1),
// so weight = tiers in the pool, overall weight = the column's sum, chance = the ratio.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rollsOn, poolFor, atLevel, tagsOf, visible, shownChance } from '../src/lib/mods/pool.js'

const W = (...pairs) => pairs
const tier = (id, name, ilvl, text, weights) => ({ id, name, ilvl, text, weights })
const FAMILIES = [
  { id: 'prefix:Life', affix: 'prefix', text: '+# to maximum Life', tags: ['life'], tiers: [
    tier('Life1', 'Hale', 1, '+(10–19) to maximum Life', W(['ring', 1], ['default', 0])),
    tier('Life2', 'Healthy', 6, '+(20–29) to maximum Life', W(['ring', 1], ['default', 0])),
    tier('Life3', 'Sanguine', 16, '+(30–39) to maximum Life', W(['ring', 1], ['default', 0])),
    tier('Life4', 'Stout', 33, '+(60–69) to maximum Life', W(['ring', 1], ['default', 0])),
    tier('Life5', 'Rotund', 46, '+(85–99) to maximum Life', W(['ring', 1], ['default', 0])),
    tier('Life6', 'Virile', 54, '+(100–119) to maximum Life', W(['ring', 1], ['default', 0])),
  ] },
  { id: 'prefix:Mana', affix: 'prefix', text: '+# to maximum Mana', tags: ['mana'], tiers: [
    tier('Mana1', 'Beryl', 1, '+(10–14) to maximum Mana', W(['default', 1])),
    tier('Mana2', 'Cobalt', 40, '+(40–49) to maximum Mana', W(['default', 1])),
    tier('Mana3', 'Blue', 70, '+(70–84) to maximum Mana', W(['no_mana', 0], ['default', 1])),
  ] },
  { id: 'prefix:Fire', affix: 'prefix', text: 'Adds # to # Fire damage to Attacks', tags: ['attack', 'fire'], tiers: [
    tier('Fire1', 'Heated', 1, 'Adds 1 to 3 Fire damage to Attacks', W(['ring', 1], ['default', 0])),
    tier('Fire2', 'Smoking', 90, 'Adds 6 to 10 Fire damage to Attacks', W(['ring', 1], ['default', 0])),
  ] },
  { id: 'suffix:Str', affix: 'suffix', text: '+# to Strength', tags: ['attribute'], tiers: [
    tier('Str1', 'of the Brute', 1, '+(5–8) to Strength', W(['default', 1])),
    tier('Str2', 'of the Bear', 22, '+(13–16) to Strength', W(['default', 1])),
  ] },
  { id: 'suffix:Wandonly', affix: 'suffix', text: '#% increased Cast Speed', tags: ['caster', 'speed'], tiers: [
    tier('Cast1', 'of Talent', 2, '(5–7)% increased Cast Speed', W(['wand', 1], ['default', 0])),
  ] },
]
const RING = { id: 'ring', name: 'Rings', tags: ['default', 'ring'] }
const WAND = { id: 'wand', name: 'Wands', tags: ['default', 'wand', 'no_mana'] }

test('rollsOn: the first spawn-weight tag the pool carries decides, no match is no roll', () => {
  const tags = new Set(['default', 'ring'])
  assert.equal(rollsOn(W(['ring', 1], ['default', 0]), tags), true)
  assert.equal(rollsOn(W(['default', 0], ['ring', 1]), tags), false, 'order matters: default comes first and says 0')
  assert.equal(rollsOn(W(['wand', 1]), tags), false, 'no tag in common')
  assert.equal(rollsOn(W(['no_mana', 0], ['default', 1]), new Set(['default', 'wand', 'no_mana'])), false)
  assert.equal(rollsOn([], tags), false)
})

test('poolFor keeps the tiers that roll on the pool, best tier first, numbered T1..Tn, and drops empty families', () => {
  const ring = poolFor(RING, FAMILIES)
  assert.equal(ring.id, 'ring')
  assert.deepEqual(ring.prefix.map(f => f.id), ['prefix:Life', 'prefix:Mana', 'prefix:Fire'], 'game order is kept')
  assert.deepEqual(ring.suffix.map(f => f.id), ['suffix:Str'], 'a wand-only family is not in the ring pool')
  const life = ring.prefix[0]
  assert.deepEqual(life.tiers.map(t => [t.tier, t.name, t.ilvl]), [[1, 'Virile', 54], [2, 'Rotund', 46], [3, 'Stout', 33], [4, 'Sanguine', 16], [5, 'Healthy', 6], [6, 'Hale', 1]])
  assert.equal(life.text, '+# to maximum Life')
  assert.deepEqual(life.tags, ['life'])
  const wand = poolFor(WAND, FAMILIES)
  assert.deepEqual(wand.prefix.map(f => f.id), ['prefix:Mana'])
  assert.deepEqual(wand.prefix[0].tiers.map(t => t.name), ['Cobalt', 'Beryl'], 'the no_mana tier is out and the rest renumber')
  assert.deepEqual(wand.prefix[0].tiers.map(t => t.tier), [1, 2])
  assert.deepEqual(wand.suffix.map(f => f.id), ['suffix:Str', 'suffix:Wandonly'])
  assert.notEqual(ring.prefix[0].tiers, FAMILIES[0].tiers, 'the input is not mutated')
})

test('atLevel: a tier is in the pool iff floor ≤ level ≤ item level, k / n, N = Σk, chance = k / N', () => {
  const ring = poolFor(RING, FAMILIES)
  const at82 = atLevel(ring, 82, 0)
  const life = at82.prefix.rows[0]
  assert.equal(life.k, 6); assert.equal(life.n, 6)
  assert.equal(at82.prefix.rows[1].k, 3, 'mana: all three tiers')
  assert.equal(at82.prefix.rows[2].k, 1, 'fire: T1 needs 90')
  assert.equal(at82.prefix.total, 10)
  assert.equal(life.chance, 0.6)
  assert.ok(Math.abs(at82.prefix.rows.reduce((s, r) => s + r.chance, 0) - 1) < 1e-9)
  assert.deepEqual(at82.prefix.rows[2].tiers.map(t => t.state), ['above', 'in'])
  assert.equal(at82.suffix.total, 2)

  const greater = atLevel(ring, 50, 35)
  const l = greater.prefix.rows[0]
  assert.equal(l.k, 1, 'Rotund (46) only: Virile is above 50, Stout (33) is below 35')
  assert.equal(greater.prefix.total, 2, 'Rotund, and Cobalt (40); Beryl is below, Blue above; both fire tiers are out')
  assert.equal(greater.prefix.rows[2].k, 0)
  assert.equal(greater.prefix.rows[2].chance, 0)
})

test('atLevel bands: above the item level, in the pool, below the floor, in that order', () => {
  const ring = poolFor(RING, FAMILIES)
  const r = atLevel(ring, 50, 35).prefix.rows[0]
  assert.deepEqual(r.tiers.map(t => [t.name, t.state]), [['Virile', 'above'], ['Rotund', 'in'], ['Stout', 'below'], ['Sanguine', 'below'], ['Healthy', 'below'], ['Hale', 'below']])
  assert.equal(r.k, 1)
  const strict = atLevel(ring, 82, 60).prefix.rows[0]
  assert.equal(strict.k, 0, 'no keep-the-top-tier exception: Virile is 54 < 60')
  assert.equal(strict.chance, 0)
  assert.ok(strict.tiers.every(t => t.state === 'below'))
})

test('atLevel: an empty pool has total 0 and null chances, never NaN; floor above the level is allowed', () => {
  const ring = poolFor(RING, FAMILIES)
  const empty = atLevel(ring, 40, 60)
  assert.equal(empty.prefix.total, 0)
  assert.ok(empty.prefix.rows.every(r => r.k === 0 && r.chance === null))
  const low = atLevel(ring, 0, 0)
  assert.equal(low.prefix.total, 0)
  assert.equal(atLevel(ring, 1, 0).prefix.total, 3, 'Hale, Beryl, Heated')
})

test('atLevel keeps row order and family identity across levels (rows are keyed by family id)', () => {
  const ring = poolFor(RING, FAMILIES)
  const a = atLevel(ring, 10, 0), b = atLevel(ring, 90, 0)
  assert.deepEqual(a.prefix.rows.map(r => r.family.id), b.prefix.rows.map(r => r.family.id))
  assert.equal(a.prefix.rows[0].family, ring.prefix[0], 'the family object is the pool\'s own')
})

test('tagsOf lists the pool\'s tags with a label and a family count, most common first', () => {
  const ring = poolFor(RING, FAMILIES)
  const tags = tagsOf(ring)
  assert.deepEqual(tags.map(t => t.id), ['attack', 'attribute', 'fire', 'life', 'mana'])
  assert.deepEqual(tags.find(t => t.id === 'life'), { id: 'life', label: 'Life', count: 1 })
  assert.equal(tags.some(t => t.id === 'caster'), false, 'a tag only a dropped family carries is absent')
  assert.equal(tagsOf(poolFor({ id: 'x', name: 'x', tags: ['energy_shield'] }, [])).length, 0)
  const es = poolFor({ id: 'y', name: 'y', tags: ['default'] }, [{ id: 'p:a', affix: 'prefix', text: '#', tags: ['energy_shield'], tiers: [tier('a', 'a', 1, '1', W(['default', 1]))] }])
  assert.equal(tagsOf(es)[0].label, 'Energy Shield')
})

test('visible hides rows by tag (OR) and text, matches tag labels, and never changes a chance', () => {
  const ring = poolFor(RING, FAMILIES)
  const { rows } = atLevel(ring, 82, 0).prefix
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
  assert.equal(shownChance(atLevel(ring, 40, 60).prefix.rows), null, 'an empty pool has no share to sum')
})
