// Trading → Mods → "Paste item": the copied item against its pool. The vendored EE2 parser reads
// the clipboard text in the worker (the text never crosses IPC); what crosses is the compact
// parse: base, rarity, item level, and each modifier's affix, tier name, tier and printed lines.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const port = require('../src/vendor/ee2-query')
const { handle } = require('../src/ee2-history/worker.js')

const fixture = (n) => readFileSync(new URL(`./fixtures/ee2/items/${n}`, import.meta.url), 'utf8')

test('a rare bow: base, level, rarity and its explicit mods with affix, tier name, tier and lines', async () => {
  await port.init()
  const item = port.parseItem(fixture('RareItem.txt'))
  assert.equal(item.baseType, 'Rider Bow')
  assert.equal(item.itemClass, 'Bow')
  assert.equal(item.rarity, 'Rare')
  assert.equal(item.itemLevel, 80)
  assert.equal(item.corrupted, false)
  const shocking = item.mods.find(m => m.name === 'Shocking')
  assert.deepEqual(shocking, { type: 'explicit', affix: 'prefix', name: 'Shocking', tier: 4, lines: ['Adds # to # Lightning Damage'] })
  const radiance = item.mods.find(m => m.name === 'of Radiance')
  assert.deepEqual(radiance.lines, ['# to Accuracy Rating', '#% increased Light Radius'], 'a hybrid keeps every line')
  assert.equal(radiance.affix, 'suffix')
  assert.ok(!JSON.stringify(item).includes('Item Class'), 'no raw text leaves the parse')
})

test('every modifier type is kept with its type; an affix only where the game gives one', async () => {
  await port.init()
  const item = port.parseItem(fixture('ItemAllTheModifierTypes.txt'))
  const types = new Set(item.mods.map(m => m.type))
  for (const t of ['enchant', 'rune', 'implicit', 'fractured', 'explicit']) assert.ok(types.has(t), t)
  assert.ok(item.mods.filter(m => m.type === 'fractured').every(m => m.affix && m.name))
  assert.ok(item.mods.filter(m => m.type === 'implicit').every(m => m.affix === null && m.name === null))
})

test('not an item, or a currency stack: null', async () => {
  await port.init()
  assert.equal(port.parseItem('hello'), null)
  assert.equal(port.parseItem(''), null)
  const stack = port.parseItem(fixture('CurrencyStackChaos.txt'))
  assert.ok(stack === null || stack.mods.length === 0)
})

test("the worker's parse message answers with the parse and nothing of the text", async () => {
  const replies = []
  await handle({ t: 'parse', id: 7, raw: fixture('MagicItem.txt') }, (m) => replies.push(m))
  assert.equal(replies.length, 1)
  const [r] = replies
  assert.equal(r.t, 'parsed'); assert.equal(r.id, 7)
  assert.equal(r.item.baseType, 'Temple Maul'); assert.equal(r.item.rarity, 'Magic'); assert.equal(r.item.mods.length, 2)
  assert.ok(!JSON.stringify(r).includes('Item Class'))
  const bad = []
  await handle({ t: 'parse', id: 8, raw: 'nope' }, (m) => bad.push(m))
  assert.deepEqual(bad, [{ t: 'parsed', id: 8, item: null }])
})
