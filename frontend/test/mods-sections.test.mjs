// The pools other currencies open on an item (docs/mods-page-design.md): desecration bones, the
// socketable uniques (Thrud's Might and friends), the Genesis Tree, Vaal corruption. Each is a
// section: the base pool's tags plus the section's key tags, restricted to the families that key
// on them, run through the same atLevel arithmetic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SECTIONS, sectionsFor, atLevel } from '../src/lib/mods/pool.js'

const W = (...pairs) => pairs
const tier = (id, name, ilvl, text, weights) => ({ id, name, ilvl, text, weights })
const fam = (id, affix, domain, text, tags, tiers) => ({ id, affix, domain, group: id.split(':')[1], text, tags, tiers })
const FAMILIES = [
  fam('prefix:Life', 'prefix', 'item', '+# to maximum Life', ['life'], [tier('Life1', 'Hale', 1, '+(10–19) to maximum Life', W(['ring', 1], ['default', 0]))]),
  fam('suffix:KurgalRes', 'suffix', 'desecrated', '+#% to Cold and Chaos Resistances', ['kurgal_mod', 'resistance'], [tier('K1', 'of Kurgal', 65, '+(13–17)% to Cold and Chaos Resistances', W(['armour', 1], ['ring', 1], ['default', 0], ['kurgal_mod', 1]))]),
  fam('prefix:UlamanFlask', 'prefix', 'desecrated', 'Life Flasks gain # charges per Second', ['ulaman_mod'], [tier('U1', "Ulaman's", 65, 'Life Flasks gain (0.1–0.2) charges per Second', W(['belt', 1], ['default', 0], ['ulaman_mod', 1]))]),
  fam('suffix:Destruction', 'suffix', 'item', '#% increased Explicit Fire Modifier magnitudes', ['destruction'], [tier('D1', 'of Destruction', 65, '(15–20)% increased Explicit Fire Modifier magnitudes', W(['destruction', 1], ['default', 0]))]),
  fam('prefix:GenesisES', 'prefix', 'item', '+# to maximum Energy Shield', ['genesis_tree_caster', 'energy_shield'], [tier('G1', 'Shining', 1, '+(8–14) to maximum Energy Shield', W(['amulet', 1], ['ring', 0], ['genesis_tree_caster', 1], ['default', 0]))]),
  fam('corrupted:Mana', 'corrupted', 'item', '+# to maximum Mana', ['mana'], [tier('C1', '', 1, '+(20–30) to maximum Mana', W(['ring', 1], ['default', 0]))]),
  fam('corrupted:Armour', 'corrupted', 'item', '#% increased Armour', ['defences'], [tier('C2', '', 1, '(15–25)% increased Armour', W(['str_armour', 1], ['default', 0]))]),
]
const RING = { id: 'ring', name: 'Rings', class: 'Rings', tags: ['default', 'ring'] }
const AMULET = { id: 'amulet', name: 'Amulets', class: 'Amulets', tags: ['amulet', 'default'] }
const BELT = { id: 'belt', name: 'Belts', class: 'Belts', tags: ['belt', 'default'] }
const WAND = { id: 'wand', name: 'Wands', class: 'Wands', tags: ['default', 'wand'] }
const GLOVES = { id: 'gloves_str', name: 'Gloves · Str', class: 'Gloves', tags: ['armour', 'default', 'gloves', 'str_armour'] }

test('SECTIONS: the base pool first, then the currency pools, each with its key tags and title', () => {
  assert.equal(SECTIONS[0].id, 'base')
  const ids = SECTIONS.map(s => s.id)
  for (const id of ['desecrated', 'genesis_caster', 'genesis_minion', 'destruction', 'marksman', 'berserking', 'decay', 'soul', 'chronomancy', 'corrupted']) assert.ok(ids.includes(id), id)
  assert.equal(SECTIONS.find(s => s.id === 'destruction').title, "Thrud's Might")
  assert.deepEqual(SECTIONS.find(s => s.id === 'desecrated').keys, ['ulaman_mod', 'amanamu_mod', 'kurgal_mod'])
  assert.equal(ids[ids.length - 1], 'corrupted')
  // The orb's floor applies where regular orbs roll the pool, not to a bone, the Genesis Tree or a Vaal Orb.
  assert.deepEqual(SECTIONS.filter(s => s.floored).map(s => s.id), ['base', 'destruction', 'marksman', 'berserking', 'decay', 'soul', 'chronomancy'])
  assert.deepEqual(SECTIONS.filter(s => !s.floored).map(s => s.id), ['desecrated', 'genesis_caster', 'genesis_minion', 'corrupted'])
})

test('sectionsFor: the base pool is always first; a section appears only when a family rolls in it', () => {
  const ring = sectionsFor(RING, FAMILIES)
  assert.deepEqual(ring.map(s => s.id), ['base', 'desecrated', 'corrupted'])
  assert.deepEqual(ring.map(s => s.floored), [true, false, false])
  const base = ring[0]
  assert.deepEqual(base.pool.prefix.map(f => f.id), ['prefix:Life'])
  assert.deepEqual(base.pool.suffix, [], 'the desecrated family is not in the base pool')
  const des = ring[1]
  assert.equal(des.title, 'Desecrated')
  assert.deepEqual(des.pool.suffix.map(f => f.id), ['suffix:KurgalRes'])
  assert.deepEqual(des.pool.prefix, [], 'the Ulaman belt mod does not roll on a ring')
  const cor = ring[2]
  assert.deepEqual(Object.keys(cor.pool).filter(k => Array.isArray(cor.pool[k])), ['corrupted'], 'corruption has one column')
  assert.deepEqual(cor.pool.corrupted.map(f => f.id), ['corrupted:Mana'])
})

test('sectionsFor: key-only pools (socketables) are restricted to the classes the socketable fits', () => {
  const wand = sectionsFor(WAND, FAMILIES)
  assert.deepEqual(wand.map(s => s.id), ['base', 'destruction'], 'a wand takes Thrud\'s Might; nothing else here rolls on it')
  assert.deepEqual(wand[1].pool.suffix.map(f => f.id), ['suffix:Destruction'])
  const gloves = sectionsFor(GLOVES, FAMILIES)
  assert.deepEqual(gloves.map(s => s.id), ['base', 'desecrated', 'corrupted'], 'Thrud\'s does not fit gloves; Kurgal rolls on armour; str armour corrupts')
  assert.deepEqual(gloves[2].pool.corrupted.map(f => f.id), ['corrupted:Armour'])
})

test('sectionsFor: the Genesis Tree pools follow the mods\' own base weights', () => {
  const amulet = sectionsFor(AMULET, FAMILIES)
  assert.deepEqual(amulet.map(s => s.id), ['base', 'genesis_caster'])
  assert.equal(amulet[1].title, 'Genesis Tree · Caster')
  assert.deepEqual(amulet[1].pool.prefix.map(f => f.id), ['prefix:GenesisES'])
  assert.equal(sectionsFor(RING, FAMILIES).some(s => s.id === 'genesis_caster'), false, 'ring weight is 0')
  const belt = sectionsFor(BELT, FAMILIES)
  assert.deepEqual(belt.find(s => s.id === 'desecrated').pool.prefix.map(f => f.id), ['prefix:UlamanFlask'])
})

test('atLevel runs on any section pool, including a one-column corruption pool', () => {
  const ring = sectionsFor(RING, FAMILIES)
  const des = atLevel(ring[1].pool, 82, 0)
  assert.equal(des.suffix.total, 1)
  assert.equal(des.suffix.rows[0].chance, 1)
  assert.equal(atLevel(ring[1].pool, 60, 0).suffix.total, 0, 'desecrated mods need level 65')
  const cor = atLevel(ring[2].pool, 82, 0)
  assert.equal(cor.corrupted.total, 1)
  assert.equal(cor.prefix, undefined)
})
