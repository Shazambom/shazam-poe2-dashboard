// Trading → Mods → "Search on trade": one family of one pool → what the trade site needs to
// find items of that kind carrying that mod. Nothing is hand-listed: the stat ids come from the
// trade site's stat catalogue and an item kind's category from its bases, both in EE2's data
// (desktop/src/vendor/ee2-query/data, synced every release by scripts/sync-ee2.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { lookup, groupsFor } = require('../src/trade/modsearch.js')

test('a prefix or suffix is listed on trade as explicit or desecrated; a corrupted mod or its upgrade as enchant (measured 2026-09-25 on every pool)', () => {
  assert.deepEqual(groupsFor('prefix'), ['explicit', 'desecrated'])
  assert.deepEqual(groupsFor('suffix'), ['explicit', 'desecrated'])
  assert.deepEqual(groupsFor('corrupted'), ['enchant'])
  assert.deepEqual(groupsFor('enchant'), ['enchant'])
})

test('a family text finds its stat ids in each group, the leading plus dropped as the site prints it', () => {
  const r = lookup({ text: '+# to maximum Life', affix: 'prefix', bases: ['Gold Ring', 'Iron Ring'] })
  assert.deepEqual(r.stats, [['explicit.stat_3299347043', 'desecrated.stat_3299347043']])
  assert.equal(r.category, 'accessory.ring')
  const c = lookup({ text: '+# to maximum Mana', affix: 'corrupted', bases: ['Gold Ring'] })
  const explicitMana = lookup({ text: '+# to maximum Mana', affix: 'prefix', bases: [] }).stats[0][0]
  assert.deepEqual(c.stats, [[explicitMana.replace('explicit.', 'enchant.')]], 'the same stat hash under the enchant group')
})

test('a hybrid family is one stat per line: an item must carry both', () => {
  const r = lookup({ text: '#% increased Evasion Rating\n+# to maximum Life', affix: 'prefix', bases: ['Iron Ring'] })
  assert.equal(r.stats.length, 2)
  assert.ok(r.stats[0].some(id => id.startsWith('explicit.')) && r.stats[1].includes('explicit.stat_3299347043'))
})

test('a text the site does not list is reported, not searched', () => {
  const r = lookup({ text: 'Charms gain # charges per Second', affix: 'prefix', bases: ['Iron Ring'] })
  assert.equal(r.stats, null)
  assert.equal(r.category, 'accessory.ring')
})

test("an item kind's category is the one most of its bases fall under; bases the catalogue lacks leave it unset", () => {
  assert.equal(lookup({ text: '+# to maximum Life', affix: 'prefix', bases: ['Gold Ring'] }).category, 'accessory.ring')
  assert.equal(lookup({ text: '+# to maximum Life', affix: 'prefix', bases: ['Armoured Vest', 'Not A Base'] }).category, 'armour.chest')
  assert.equal(lookup({ text: '+# to maximum Life', affix: 'prefix', bases: ['Not A Base'] }).category, null)
  assert.equal(lookup({ text: '+# to maximum Life', affix: 'prefix', bases: [] }).category, null)
})
