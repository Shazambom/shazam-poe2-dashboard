// Trading → Sales pure helpers + ItemCard rendering from fixtures.
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
const { saleValueRef, salesStats, relativeTime, itemCardProps, rarityOf } = await import('../src/lib/sales.js')
const { default: ItemCard } = await import('../src/lib/itemCard.js')

const RARE = { name: 'Hate Pelt', typeLine: 'Vaal Regalia', frameType: 2, ilvl: 82, icon: 'https://web.poecdn.com/x.png', corrupted: true,
  properties: [{ name: 'Energy Shield', values: [['512', 1]], displayMode: 0 }, { name: 'Quality', values: [['+20%', 1]] }],
  requirements: [{ name: 'Level', values: [['68', 0]] }, { name: 'Int', values: [['194', 0]] }],
  implicitMods: ['+30 to Intelligence'], explicitMods: ['+120 to maximum Life', '+45% to Fire Resistance', '+40% to Cold Resistance', '12% increased Energy Shield', '+1 to Level of all Spell Skills'] }
const UNIQUE = { name: 'Headhunter', typeLine: 'Heavy Belt', frameType: 3, explicitMods: [{ description: 'When you kill a Rare monster, you gain its Modifiers for 60 seconds' }], runeMods: ['+20 to Strength'] }
const CURRENCY = { name: '', typeLine: 'Divine Orb', frameType: 5, properties: [{ name: 'Stack Size', values: [['5/10', 0]] }] }

test('saleValueRef and salesStats convert through the reference prices and count windows', () => {
  const prices = { divine: 180, chaos: 0.5 }
  assert.equal(saleValueRef({ amount: 3, currency: 'divine' }, 'exalted', prices), 540)
  assert.equal(saleValueRef({ amount: 12, currency: 'exalted' }, 'exalted', prices), 12)
  assert.equal(saleValueRef({ amount: 1, currency: 'mirror' }, 'exalted', prices), null)
  const now = Date.parse('2026-09-16T12:00:00Z')
  const rows = [{ time: '2026-09-16T10:00:00Z', price: { amount: 3, currency: 'divine' } }, { time: '2026-09-12T10:00:00Z', price: { amount: 2, currency: 'exalted' } }, { time: '2026-08-01T10:00:00Z', price: { amount: 1, currency: 'mirror' } }]
  assert.deepEqual(salesStats(rows, 'exalted', prices, now), { count: 3, today: 1, week: 2, totalRef: 542, unpriced: 1 })
  assert.equal(relativeTime('2026-09-16T11:30:00Z', now), '30m ago'); assert.equal(relativeTime('nope'), '')
})

test('itemCardProps: rarity from frameType, property lines with augmented flags, requirements, mod groups, flags', () => {
  const p = itemCardProps(RARE)
  assert.equal(p.rarity, 'rare'); assert.equal(p.name, 'Hate Pelt'); assert.equal(p.icon, RARE.icon)
  assert.deepEqual(p.blocks.map(b => b.kind), ['properties', 'ilvl', 'requirements', 'implicit', 'explicit', 'flags'])
  assert.deepEqual(p.blocks[0].lines[0], { text: 'Energy Shield: 512', augmented: true })
  assert.equal(p.blocks[2].lines[0].text, 'Requires Level: 68, Int: 194')
  assert.equal(p.blocks[4].lines.length, 5); assert.deepEqual(p.blocks[5].lines, [{ text: 'Corrupted' }])
  const u = itemCardProps(UNIQUE)
  assert.equal(u.rarity, 'unique'); assert.deepEqual(u.blocks.map(b => b.kind), ['rune', 'explicit']); assert.equal(u.blocks[1].lines[0].text, 'When you kill a Rare monster, you gain its Modifiers for 60 seconds')
  assert.equal(rarityOf({ rarity: 'Magic' }), 'magic'); assert.equal(itemCardProps(CURRENCY).rarity, 'currency')
  const g = itemCardProps({ typeLine: 'x', properties: [{ name: '[Evasion|Evasion Rating]', values: [['269', 0]] }], explicitMods: ['12% increased [Evasion|Evasion] Rating', '+41 to [Spirit|Spirit]'] })
  assert.equal(g.blocks[0].lines[0].text, 'Evasion Rating: 269'); assert.deepEqual(g.blocks[1].lines.map(l => l.text), ['12% increased Evasion Rating', '+41 to Spirit'])
})

test('ItemCard renders every block from the fixtures with token-driven rarity classes', () => {
  for (const [item, rarity, must] of [[RARE, 'rare', ['Hate Pelt', 'Vaal Regalia', 'Energy Shield: 512', 'Item Level: 82', 'Requires Level: 68', '+30 to Intelligence', '+120 to maximum Life', 'Corrupted']], [UNIQUE, 'unique', ['Headhunter', 'Heavy Belt', '+20 to Strength', 'Rare monster']], [CURRENCY, 'currency', ['Divine Orb', 'Stack Size: 5/10']]]) {
    const html = renderToStaticMarkup(React.createElement(ItemCard, { item }))
    assert.ok(html.includes(`item-card ${rarity}`), rarity)
    for (const s of must) assert.ok(html.includes(s), `${rarity}: ${s}`)
    assert.ok(!/#[0-9a-f]{6}/i.test(html), 'no raw hex in the card markup')
  }
  const html = renderToStaticMarkup(React.createElement(ItemCard, { item: RARE }))
  assert.ok(html.includes('ic-augmented'), 'augmented values are marked')
})
