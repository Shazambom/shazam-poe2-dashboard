// Trading → Mods → "Find in stash": a waystone or tablet family becomes a wanted modifier in
// the Regex tab (its in-game search string). The Regex tab's table lists a modifier per printed
// line (a form per " ~ " alternative); a pool family is the game's mod, often several lines, so
// the family finds every table modifier one of its lines prints.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stashKind, stashMods, withWanted } from '../src/lib/mods/stash.js'
import { merge } from '../src/lib/regex/defaults.js'

const TABLE = { mods: [
  { id: 'res', text: '-#% maximum Player Resistances', regex: '% ma' },
  { id: 'fire', text: 'Monsters deal #% of Damage as Extra Fire', regex: 'a Fi' },
  { id: 'box', text: 'Map contains an additional Strongbox ~ Map contains # additional Strongboxes', regex: 'ongb' },
] }

test('the kind: waystone pools and tablet pools go to the Regex tab, nothing else does', () => {
  assert.equal(stashKind({ id: 'map_t16', class: 'Waystones', domain: 'area' }), 'waystone')
  assert.equal(stashKind({ id: 'toweraugmentation_abyss', class: 'Tablet', domain: 'tablet' }), 'tablet')
  assert.equal(stashKind({ id: 'ring', class: 'Rings', domain: 'item' }), null)
  assert.equal(stashKind(null), null)
})

test('a family finds the table modifiers any of its lines prints, in table order, once each', () => {
  const hybrid = { text: 'Monsters deal #% of Damage as Extra Fire\n#% more Waystones found in Area\nMonsters have #% more Effectiveness' }
  assert.deepEqual(stashMods(hybrid, TABLE), ['fire'])
  assert.deepEqual(stashMods({ text: 'Map contains # additional Strongboxes' }, TABLE), ['box'], 'a form of the table text counts')
  assert.deepEqual(stashMods({ text: '-#% maximum Player Resistances\nMonsters deal #% of Damage as Extra Fire' }, TABLE), ['res', 'fire'])
  assert.deepEqual(stashMods({ text: '#% more Pack size' }, TABLE), [], 'a line the table lacks finds nothing')
})

test('wanting adds the modifiers to the kind, switches the tab to it, and never doubles one', () => {
  const stored = merge({ kind: 'tablet', waystone: { want: [{ id: 'res', min: 30 }], tier: { min: 12, max: 16 } } })
  const next = withWanted(stored, 'waystone', ['res', 'fire'])
  assert.equal(next.kind, 'waystone')
  assert.deepEqual(next.waystone.want, [{ id: 'res', min: 30 }, { id: 'fire', min: 0 }], 'the one already wanted keeps its minimum')
  assert.deepEqual(next.waystone.tier, { min: 12, max: 16 }, 'the rest of the kind is untouched')
  assert.deepEqual(stored.waystone.want, [{ id: 'res', min: 30 }], 'the stored blob is not mutated')
  assert.deepEqual(withWanted(merge(null), 'tablet', ['box']).tablet.want, [{ id: 'box', min: 0 }])
})
