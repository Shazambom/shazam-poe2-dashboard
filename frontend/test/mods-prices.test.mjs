// Prices beside mods (docs/mods-page-design.md): a family that an essence or alloy forces shows
// what forcing it costs. The link is the printed text: a grant row's text is exactly one tier's
// text of the family it forces (measured over the pools: every essence row that is in a pool
// matches a tier; the rest are essence-only mods). Prices come from the server, keyed by name.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forcedBy, priceOf } from '../src/lib/mods/prices.js'

const LIFE = { id: 'prefix:Life', text: '+# to maximum Life', tiers: [{ tier: 1, name: 'Virile', ilvl: 54, text: '+(100–119) to maximum Life' }, { tier: 5, name: 'Healthy', ilvl: 6, text: '+(20–29) to maximum Life' }] }
const GRANTS = {
  essences: [
    { name: 'Greater Essence of the Body', kind: 'essence', tier: 2, rows: [{ class: 'Rings', text: '+(100–119) to maximum Life', affix: 'prefix', level: 40 }] },
    { name: 'Lesser Essence of the Body', kind: 'essence', tier: 0, rows: [{ class: 'Rings', text: '+(20–29) to maximum Life', affix: 'prefix', level: 10 }] },
    { name: 'Essence of the Mind', kind: 'essence', tier: 1, rows: [{ class: 'Rings', text: '+(50–59) to maximum Mana', affix: 'prefix', level: 25 }] },
  ],
  alloys: [{ name: 'Runic Alloy', kind: 'alloy', tier: 1, rows: [{ class: 'Rings', text: '+(37–49) to maximum Runic Ward', affix: 'prefix', level: 10 }] }],
  augments: [],
}

test('forcedBy: the grants whose row text is a tier of the family, with the tier they force, best tier first', () => {
  assert.deepEqual(forcedBy(LIFE, GRANTS), [
    { name: 'Greater Essence of the Body', tier: 1, level: 40 },
    { name: 'Lesser Essence of the Body', tier: 5, level: 10 },
  ])
  assert.deepEqual(forcedBy({ ...LIFE, text: '+# to Strength', tiers: [{ tier: 1, name: '', ilvl: 1, text: '+(5–8) to Strength' }] }, GRANTS), [])
  assert.deepEqual(forcedBy(LIFE, null), [])
})

test('priceOf: the server price for a grant name, null when the exchange does not trade it', () => {
  const prices = { reference: 'exalted', prices: { 'Greater Essence of the Body': 12.5 } }
  assert.equal(priceOf('Greater Essence of the Body', prices), 12.5)
  assert.equal(priceOf('Lesser Essence of the Body', prices), null)
  assert.equal(priceOf('Runic Alloy', null), null)
})
