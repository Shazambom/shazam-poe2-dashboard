// Trading → Mods → "Paste item" (docs/mods-page-design.md): the copied item against its pool.
// Main hands the renderer the compact parse (base, rarity, item level, each mod's affix, tier
// name, tier, lines); here the pool is found by the base, each explicit mod finds its family
// (tier name first, the printed text to break a tie or when the name is unknown; measured over
// the EE2 fixtures 2026-09-25), and the open affix slots follow from the rarity.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { poolFor, matchItem, slotsFor } from '../src/lib/mods/item.js'
import { prepare, atLevel } from '../src/lib/mods/pool.js'

const tier = (tier, name, ilvl, text) => ({ tier, name, ilvl, text })
const fam = (id, text, tags, tiers) => ({ id, text, tags, tiers })
const LIFE = fam('prefix:IncreasedLife', '+# to maximum Life', ['life'], [tier(1, 'Virile', 54, '+(100–119) to maximum Life'), tier(2, 'Rotund', 46, '+(85–99) to maximum Life')])
const ARMOUR = fam('prefix:ArmourHybrid', '+#% increased Armour\n+# to Armour', ['defences'], [tier(1, 'Hardened', 60, '+(20–30)% increased Armour\n+(10–20) to Armour')])
const STR = fam('suffix:Strength', '+# to Strength', ['attribute'], [tier(1, 'of the Bear', 22, '+(13–16) to Strength'), tier(2, 'of the Brute', 1, '+(5–8) to Strength')])
const SPELL = fam('suffix:SpellDamage', '#% increased Spell Damage', ['caster'], [tier(1, "Incanter's", 50, '(20–30)% increased Spell Damage')])
const SPELL2 = fam('suffix:SpellDamage@genesis', '#% increased Spell Damage', ['caster'], [tier(1, "Incanter's", 50, '(20–30)% increased Spell Damage')])
const POOL = () => prepare({ id: 'ring', name: 'Rings', class: 'Rings', tags: [], grants: { essences: [], alloys: [], augments: [] }, sections: [
  { id: 'base', title: null, floored: true, prefix: [LIFE, ARMOUR], suffix: [STR, SPELL] },
  { id: 'genesis_tree_caster', title: 'Genesis Tree Caster', floored: true, prefix: [], suffix: [SPELL2] },
] })
const POOLS = [{ id: 'ring', name: 'Rings', class: 'Rings', keywords: ['Gold Ring', 'Sapphire Ring'] }, { id: 'amulet', name: 'Amulets', class: 'Amulets', keywords: ['Gold Amulet'] }]
const mod = (affix, name, tier, lines, type = 'explicit') => ({ type, affix, name, tier, lines })
const ITEM = { name: 'Havoc Twirl', baseType: 'Sapphire Ring', itemClass: 'Ring', rarity: 'Rare', itemLevel: 68, corrupted: false, mods: [
  mod(null, null, null, ['#% to Cold Resistance'], 'implicit'),
  mod('prefix', 'Virile', 1, ['# to maximum Life']),
  mod('prefix', 'Hardened', 1, ['# to Armour', '#% increased Armour']),
  mod('suffix', 'of the Brute', 2, ['# to Strength']),
  mod('suffix', "Incanter's", 1, ['#% increased Spell Damage']),
  mod('suffix', 'of the Essence', null, ['Hits against you have #% reduced Critical Damage Bonus']),
] }

test('poolFor: the pool whose bases name the item, else null', () => {
  assert.equal(poolFor(POOLS, ITEM).id, 'ring')
  assert.equal(poolFor(POOLS, { ...ITEM, baseType: 'Amber Amulet' }), null)
  assert.equal(poolFor(POOLS, null), null)
})

test('matchItem: each explicit mod finds its family by tier name, text breaks a tie and stands in for an unknown name; the rest are loose', () => {
  const m = matchItem(POOL(), ITEM)
  assert.deepEqual(m.rolled.map(r => [r.family.id, r.section, r.affix, r.tier, r.name]), [
    ['prefix:IncreasedLife', 'base', 'prefix', 1, 'Virile'],
    ['prefix:ArmourHybrid', 'base', 'prefix', 1, 'Hardened'],
    ['suffix:Strength', 'base', 'suffix', 2, 'of the Brute'],
    ['suffix:SpellDamage', 'base', 'suffix', 1, "Incanter's"],
  ], 'a hybrid matches whatever the line order; the same family in two sections is the base one')
  assert.deepEqual(m.loose.map(x => x.name), ['of the Essence'], 'an essence-only mod is on the item but in no pool')
  assert.deepEqual(m.count, { prefix: 2, suffix: 3 }, 'the item carries three suffixes: the loose one counts')
  const noName = matchItem(POOL(), { ...ITEM, mods: [mod('prefix', null, null, ['# to maximum Life'])] })
  assert.deepEqual(noName.rolled.map(r => [r.family.id, r.tier]), [['prefix:IncreasedLife', null]], 'text alone finds the family; the tier is unknown')
  assert.deepEqual(matchItem(POOL(), null), { rolled: [], loose: [], count: { prefix: 0, suffix: 0 } })
})

test('slotsFor: a rare holds three of each affix, a magic one, a normal none, a unique is not a pool item', () => {
  assert.deepEqual(slotsFor('Rare'), { prefix: 3, suffix: 3 })
  assert.deepEqual(slotsFor('Magic'), { prefix: 1, suffix: 1 })
  assert.deepEqual(slotsFor('Normal'), { prefix: 0, suffix: 0 })
  assert.equal(slotsFor('Unique'), null)
})

test('atLevel with the rolled families excluded: they show their tier, count for nothing, and the chances are over what can still land', () => {
  const base = POOL().sections[0]
  const plain = atLevel(base, 68, 0)
  assert.equal(plain.prefix.total, 3, 'Life 2 + Armour 1')
  const level = atLevel(base, 68, 0, new Map([['prefix:IncreasedLife', 1], ['suffix:SpellDamage', 1]]))
  const life = level.prefix.rows.find(r => r.family.id === 'prefix:IncreasedLife')
  assert.equal(life.onItem, 1); assert.equal(life.chance, null)
  assert.equal(level.prefix.total, 1, 'only Armour can still land')
  assert.equal(level.prefix.rows.find(r => r.family.id === 'prefix:ArmourHybrid').chance, 1)
  assert.equal(level.suffix.rows.find(r => r.family.id === 'suffix:Strength').onItem, undefined)
})

test('a tier comes from the tier name only: the game prints tiers on the other scale, so an unknown name has no tier', () => {
  const m = matchItem(POOL(), { ...ITEM, mods: [mod('prefix', 'Not a name', 4, ['# to maximum Life'])] })
  assert.deepEqual(m.rolled.map(r => [r.family.id, r.tier, r.name]), [['prefix:IncreasedLife', null, 'Not a name']])
})

test('a rolled family names every section id it appears under, so no section keeps counting it', () => {
  const m = matchItem(POOL(), ITEM)
  assert.deepEqual(m.rolled.find(r => r.family.id === 'suffix:SpellDamage').ids, ['suffix:SpellDamage', 'suffix:SpellDamage@genesis'])
  assert.deepEqual(m.rolled.find(r => r.family.id === 'prefix:IncreasedLife').ids, ['prefix:IncreasedLife'])
  const onItem = new Map(m.rolled.flatMap(r => r.ids.map(id => [id, r.tier])))
  const genesis = atLevel(POOL().sections[1], 68, 0, onItem)
  assert.equal(genesis.suffix.total, 0)
  assert.equal(genesis.suffix.rows[0].onItem, 1)
})

test('the pasted item lives for the session: a hop to another tab and back finds it, a new paste replaces it', async () => {
  const { pasted } = await import('../src/lib/mods/index.js')
  pasted.set(null)
  assert.equal(pasted.get(), null)
  pasted.set(ITEM)
  assert.equal(pasted.get(), ITEM)
  pasted.set(null)
})
