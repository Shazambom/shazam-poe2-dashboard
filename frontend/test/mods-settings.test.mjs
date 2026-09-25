// The Mods tab's settings shape (persisted under `mods_tools`) and the index of currencies that
// bound the pool (docs/mods-page-design.md → "Currencies that bound the pool").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaults, merge } from '../src/lib/mods/defaults.js'
import { CURRENCIES, currencyFor, floorOf, FLOORS } from '../src/lib/mods/currency.js'

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

test('the currency index: sixteen items with a level rule, the six floors, grouped by orb', () => {
  assert.equal(CURRENCIES.length, 16)
  const byName = Object.fromEntries(CURRENCIES.map(c => [c.name, c]))
  assert.deepEqual([byName['Greater Orb of Transmutation'].floor, byName['Perfect Orb of Transmutation'].floor], [44, 70])
  assert.deepEqual([byName['Greater Orb of Augmentation'].floor, byName['Perfect Orb of Augmentation'].floor], [44, 70])
  assert.deepEqual([byName['Greater Regal Orb'].floor, byName['Perfect Regal Orb'].floor], [35, 50])
  assert.deepEqual([byName['Greater Exalted Orb'].floor, byName['Perfect Exalted Orb'].floor], [35, 50])
  assert.deepEqual([byName['Greater Chaos Orb'].floor, byName['Perfect Chaos Orb'].floor], [35, 50])
  for (const bone of ['Jawbone', 'Rib', 'Collarbone']) {
    assert.equal(byName[`Ancient ${bone}`].floor, 40)
    assert.equal(byName[`Gnawed ${bone}`].cap, 64)
    assert.equal(byName[`Gnawed ${bone}`].floor, 0)
  }
  assert.equal(new Set(CURRENCIES.map(c => c.id)).size, 16, 'ids are unique')
  assert.deepEqual(FLOORS, [35, 40, 44, 50, 70])
  for (const c of CURRENCIES) {
    assert.ok(typeof c.group === 'string' && c.group, c.name)
    assert.ok(c.cap === null || Number.isInteger(c.cap), c.name)
    assert.ok(Number.isInteger(c.floor) && c.floor >= 0, c.name)
  }
  assert.deepEqual([...new Set(CURRENCIES.map(c => c.group))], ['transmutation', 'augmentation', 'regal', 'exalted', 'chaos', 'bone'], 'grouped in orb order')
})

test('currencyFor reads the orb back from a floor (first of a tie), floorOf writes it', () => {
  assert.equal(currencyFor(0), null)
  assert.equal(currencyFor(35).name, 'Greater Regal Orb', 'the first 35 in orb order')
  assert.equal(currencyFor(44).name, 'Greater Orb of Transmutation')
  assert.equal(currencyFor(50).name, 'Perfect Regal Orb')
  assert.equal(currencyFor(70).name, 'Perfect Orb of Transmutation')
  assert.equal(currencyFor(40).name, 'Ancient Jawbone')
  assert.equal(currencyFor(60), null)
  assert.equal(floorOf('greater-exalted'), 35)
  assert.equal(floorOf('perfect-chaos'), 50)
  assert.equal(floorOf('gnawed-rib'), 0)
  assert.equal(floorOf('nope'), 0)
})
