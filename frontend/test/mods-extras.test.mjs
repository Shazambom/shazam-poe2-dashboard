// The shipped essence and socketable tables (docs/mods-page-design.md): what each essence forces
// on each item class (frontend/scripts/mods-essences.mjs, read off poe2db's essence pages) and
// what each rune, soul core and idol grants where it fits (from the export's augments table).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classesOf, essenceTier } from '../scripts/sync-mods-data.mjs'
import { essencesFor, augmentsFor } from '../src/lib/mods/extras.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(HERE, '..', 'src', 'data', 'mods')
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'))

test('classesOf turns a socketable target into our pool class names', () => {
  assert.deepEqual(classesOf(['Helmets']), ['Helmets'])
  assert.deepEqual(classesOf('Wand or Staff'), ['Wands', 'Staves'])
  assert.deepEqual(classesOf('Shields and Bucklers'), ['Shields', 'Bucklers'])
  assert.deepEqual(classesOf('Crossbow, Bow or Spear'), ['Crossbows', 'Bows', 'Spears'])
  assert.deepEqual(classesOf('One Hand Mace, Two Hand Mace or Talisman'), ['One Hand Maces', 'Two Hand Maces', 'Talismans'])
  assert.ok(classesOf('[MartialWeapon|Martial Weapon]').includes('Bows'))
  assert.ok(!classesOf('[MartialWeapon|Martial Weapon]').includes('Wands'))
  assert.ok(classesOf('[CasterWeapon|Caster Weapon]').includes('Sceptres'))
  assert.ok(classesOf('Armour').includes('Body Armours') && classesOf('Armour').includes('Foci'))
  assert.ok(classesOf('All Equipment').includes('Rings') && classesOf('All Equipment').includes('Bows'))
  assert.deepEqual(classesOf('[MartialWeapon|Martial Weapon], Wand or Staff').slice(-2), ['Wands', 'Staves'])
  assert.throws(() => classesOf('Nonsense'))
})

test('essenceTier orders Lesser, plain, Greater, Perfect', () => {
  assert.equal(essenceTier('Lesser Essence of the Body'), 0)
  assert.equal(essenceTier('Essence of the Body'), 1)
  assert.equal(essenceTier('Greater Essence of the Body'), 2)
  assert.equal(essenceTier('Perfect Essence of the Body'), 3)
  assert.equal(essenceTier('Essence of Hysteria'), 1)
})

const { essences } = readJson('essences.json')
const { augments } = readJson('augments.json')
const { pools } = readJson('pools.json')

test('essences: every essence with its class rows, texts clean, levels and affixes present', () => {
  assert.ok(essences.length >= 80, essences.length)
  assert.equal(new Set(essences.map(e => e.name)).size, essences.length)
  const classes = new Set(pools.map(p => p.class))
  for (const e of essences) {
    assert.ok(e.name && Number.isInteger(e.tier) && Array.isArray(e.rows) && e.rows.length, e.name)
    for (const r of e.rows) {
      assert.ok(classes.has(r.class), `${e.name}: unknown class ${r.class}`)
      assert.ok(['prefix', 'suffix', 'implicit'].includes(r.affix), `${e.name}: ${r.affix}`)
      assert.ok(Number.isInteger(r.level) && r.level >= 0, `${e.name}: level ${r.level}`)
      assert.ok(r.text && !/\(\s|\s\)|\s%|\s,/.test(r.text), `${e.name}: "${r.text}"`)
    }
  }
  const body = essences.find(e => e.name === 'Greater Essence of the Body')
  assert.deepEqual(body.rows.find(r => r.class === 'Body Armours'), { class: 'Body Armours', text: '+(100–119) to maximum Life', affix: 'prefix', level: 43 })
  assert.ok(essences.some(e => e.name === 'Perfect Essence of the Body'))
})

test('augments: every rune, soul core and idol with the classes it fits and what it grants there', () => {
  assert.ok(augments.length >= 250, augments.length)
  assert.equal(new Set(augments.map(a => a.id)).size, augments.length)
  const classes = new Set(pools.map(p => p.class))
  for (const a of augments) {
    assert.ok(a.id && a.name && a.type && Array.isArray(a.fits) && a.fits.length, a.id)
    for (const f of a.fits) {
      assert.ok(Array.isArray(f.classes) && f.classes.length && f.classes.every(c => classes.has(c)), `${a.id}: ${f.classes}`)
      assert.ok(Array.isArray(f.text) && Array.isArray(f.bonded) && (f.text.length || f.bonded.length), `${a.id}: an empty fit`)
      assert.ok([...f.text, ...f.bonded].every(t => !/[[\]|]/.test(t)), `${a.id}: ${f.text}`)
    }
  }
  const iron = augments.find(a => a.name === 'Iron Rune')
  assert.ok(iron && iron.type === 'Rune')
  assert.ok(augments.some(a => a.type === 'Soul Core') && augments.some(a => a.type === 'Idol'))
})

test('essencesFor and augmentsFor pick what fits a pool\'s class, in tier then name order', () => {
  const ring = pools.find(p => p.id === 'ring')
  const es = essencesFor(ring, essences)
  assert.ok(es.length >= 20, es.length)
  for (const e of es) assert.ok(e.rows.every(r => r.class === 'Rings'))
  for (let i = 1; i < es.length; i++) assert.ok(es[i - 1].tier < es[i].tier || (es[i - 1].tier === es[i].tier && es[i - 1].name <= es[i].name))
  assert.deepEqual(essencesFor({ class: 'Nowhere' }, essences), [])
  const wand = pools.find(p => p.id === 'wand')
  const au = augmentsFor(wand, augments)
  assert.ok(au.length >= 20, au.length)
  for (const a of au) { assert.equal(a.fits.length, 1); assert.deepEqual(a.fits[0].classes, ['Wands']); assert.ok(a.fits[0].text.length || a.fits[0].bonded.length) }
  const adept = au.find(a => a.name === 'Adept Rune')
  assert.deepEqual(adept.fits[0], { classes: ['Wands'], text: ['+9 to Dexterity'], bonded: ['+80 to Evasion Rating'] }, 'the general text and the wand bonded effect merge into one fit')
  assert.ok(au.some(a => a.type === 'Rune') && au.some(a => a.type === 'Soul Core'))
  assert.deepEqual(augmentsFor({ class: 'Nowhere' }, augments), [])
})
