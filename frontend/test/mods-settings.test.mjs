// The Mods tab's settings shape (persisted under `mods_tools`) and the orb picker's helpers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaults, merge } from '../src/lib/mods/defaults.js'
import { currencyFor, floorOf, orbOptions } from '../src/lib/mods/orbs.js'

test('defaults: a ring pool at item level 82 with no floor and no tags', () => {
  assert.deepEqual(defaults, { poolId: 'ring', ilvl: 82, floor: 0, tags: [] })
  assert.ok(Object.isFrozen(defaults))
})

test('merge folds a stored partial over the defaults and clamps every value', () => {
  assert.deepEqual(merge(null), defaults)
  assert.deepEqual(merge({}), defaults)
  assert.deepEqual(merge({ ilvl: 65, floor: 35, poolId: 'gloves_str_int', tags: ['life'], junk: 1 }), { poolId: 'gloves_str_int', ilvl: 65, floor: 35, tags: ['life'] })
  assert.equal(merge({ ilvl: 0 }).ilvl, 1)
  assert.equal(merge({ ilvl: 250 }).ilvl, 100)
  assert.equal(merge({ ilvl: 'x' }).ilvl, 82)
  assert.equal(merge({ ilvl: 61.7 }).ilvl, 61)
  assert.equal(merge({ floor: -5 }).floor, 0)
  assert.equal(merge({ floor: 101 }).floor, 100)
  assert.equal(merge({ floor: null }).floor, 0)
  assert.equal(merge({ poolId: 7 }).poolId, 'ring')
  assert.deepEqual(merge({ tags: 'life' }).tags, [])
  assert.deepEqual(merge({ tags: ['life', 3, 'life'] }).tags, ['life'])
  const m = merge({ tags: ['x'] }); m.tags.push('y'); assert.deepEqual(defaults.tags, [])
})

// The currencies as the backend lists them (poe2db's list, in its order): floors and caps.
const CUR = [
  { id: 'greater-chaos-orb', name: 'Greater Chaos Orb', floor: 35, cap: null },
  { id: 'greater-exalted-orb', name: 'Greater Exalted Orb', floor: 35, cap: null },
  { id: 'perfect-exalted-orb', name: 'Perfect Exalted Orb', floor: 50, cap: null },
  { id: 'gnawed-jawbone', name: 'Gnawed Jawbone', floor: 0, cap: 64 },
  { id: 'ancient-jawbone', name: 'Ancient Jawbone', floor: 40, cap: null },
]

test('the orb picker reads the floor back as the first orb with it, writes it from the orb, and lists only orbs that set one', () => {
  assert.equal(currencyFor(CUR, 0), null)
  assert.equal(currencyFor(CUR, 35).name, 'Greater Chaos Orb', 'the first 35 in list order')
  assert.equal(currencyFor(CUR, 50).name, 'Perfect Exalted Orb')
  assert.equal(currencyFor(CUR, 40).name, 'Ancient Jawbone')
  assert.equal(currencyFor(CUR, 60), null)
  assert.equal(floorOf(CUR, 'greater-exalted-orb'), 35)
  assert.equal(floorOf(CUR, 'gnawed-jawbone'), 0)
  assert.equal(floorOf(CUR, 'nope'), 0)
  assert.deepEqual(orbOptions(CUR).map(c => c.id), ['greater-chaos-orb', 'greater-exalted-orb', 'perfect-exalted-orb', 'ancient-jawbone'], 'a bone with only a cap sets no floor')
  assert.deepEqual(orbOptions([]), [])
})
