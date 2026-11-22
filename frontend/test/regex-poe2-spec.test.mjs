// Official Path of Exile 2 (Patch 0.5.x) regex specification and real-item validation.
//
// In PoE 2 0.5.0+, the in-game search box:
//   - Accepts up to 250 characters (LIMIT = 250).
//   - Evaluates against an item's advanced description format (what Ctrl+C copies):
//       * Header lines carry "(augmented)" (e.g. "Revives Available: 0 (augmented)",
//         "Monster Pack Size: +25% (augmented)").
//       * Affix metadata headers appear on their own lines ("{ Implicit Modifier }",
//         '{ Prefix Modifier "Infernal" (Tier: 1) }', '{ Suffix Modifier "of Flames" (Tier: 1) }').
//       * Rolled numbers carry inline tier ranges immediately after the rolled value
//         ("18(15-19)%", "42(50-40)%", "2(1-2) buried Strongboxes").
//       * Unscalable mods append " — Unscalable Value"; desecrated/fractured/enchanted lines
//         can append "(desecrated)", "(fractured)", "(enchant)".
//       * Tablets use "Item Class: Tablet" and "Can be used in a personal Map Device to add
//         modifiers to a Map.".
//   - Splits unquoted spaces into AND terms, keeps spaces and "|" inside double quotes,
//     negates a term with leading "!" (inside quotes for quoted terms: "!a|b"), matches
//     case-insensitively, and evaluates each term line-by-line (no cross-line "." matching;
//     ^ and $ bind to individual lines).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate, defaults, LIMIT, overLimit } from '../src/lib/regex/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(HERE, '..', 'src', 'data', 'regex')
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'))
const WTABLE = readJson('waystone.json')
const TTABLE = readJson('tablet.json')
const W = (over = {}) => ({ ...structuredClone(defaults.waystone), ...over })
const T = (over = {}) => ({ ...structuredClone(defaults.tablet), ...over })
const findMod = (table, substr) => {
  const m = table.mods.find(x => x.text === substr) || table.mods.find(x => x.text.includes(substr))
  assert.ok(m, `missing mod matching "${substr}"`)
  return m
}

// Faithful line-by-line PoE 2 search-box evaluator.
export function poe2Search(query, advancedItemText) {
  assert.equal((query.match(/"/g) || []).length % 2, 0, `unbalanced quotes in: ${query}`)
  assert.equal(/(^|\s)!"/.test(query), false, `negation must sit inside quotes ("!..."), got: ${query}`)
  const terms = []
  const tokenRe = /"([^"]*)"|(\S+)/g
  let m
  while ((m = tokenRe.exec(query))) terms.push(m[1] ?? m[2])
  const lines = advancedItemText.split('\n')
  return terms.every(term => {
    const neg = term.startsWith('!')
    const body = neg ? term.slice(1) : term
    let re
    try { re = new RegExp(body, 'i') } catch (e) { throw new Error(`invalid PoE 2 regex /${body}/: ${e.message}`) }
    const hit = lines.some(line => re.test(line))
    return neg ? !hit : hit
  })
}

// ---------------------------------------------------------------- verbatim 0.5.x items
const WAYSTONE_MAGIC_FLAMES = `Item Class: Waystones
Rarity: Magic
Shattering Waystone (Tier 2) of Flames
--------
Revives Available: 4 (augmented)
Monster Rarity: +19% (augmented)
Monster Effectiveness: +15% (augmented)
Waystone Drop Chance: +25% (augmented)
--------
Item Level: 79
--------
{ Prefix Modifier "Shattering" (Tier: 1) }
Monsters Break Armour equal to 17(15-20)% of Physical Damage dealt
{ Suffix Modifier "of Flames" (Tier: 1) }
Area has patches of Ignited Ground — Unscalable Value
--------
Can be used in a Map Device, allowing you to enter a Map. Waystones can only be used once.`

const WAYSTONE_RARE_T15 = `Item Class: Waystones
Rarity: Rare
Mystic Solitude
Waystone (Tier 15)
--------
Revives Available: 0 (augmented)
Item Rarity: +67% (augmented)
Monster Pack Size: +25% (augmented)
Waystone Drop Chance: +95% (augmented)
--------
Item Level: 82
--------
{ Prefix Modifier "Frostbitten" (Tier: 1) }
Monsters deal 18(15-19)% of Damage as Extra Cold
{ Prefix Modifier "Profane" (Tier: 1) }
Monsters deal 18(15-19)% of Damage as Extra Chaos
{ Prefix Modifier "Infernal" (Tier: 1) }
Monsters deal 16(15-19)% of Damage as Extra Fire
{ Suffix Modifier "of Erosion" (Tier: 1) }
Players are periodically Cursed with Elemental Weakness — Unscalable Value
{ Suffix Modifier "of Hexwarding" (Tier: 1) }
42(50-40)% less effect of Curses on Monsters
{ Suffix Modifier "of Smothering" (Tier: 1) }
Players have 36(40-36)% less Recovery Rate of Life and Energy Shield
--------
Can be used in a Map Device, allowing you to enter a Map. Waystones can only be used once.`

const WAYSTONE_IMPLICIT_UNSCALABLE = `Item Class: Waystones
Rarity: Rare
Mystic Remnant
Waystone (Tier 15)
--------
Revives Available: 2 (augmented)
Item Rarity: +45% (augmented)
Pack Size: +18% (augmented)
--------
Item Level: 81
--------
{ Implicit Modifier }
Players in Area are 32% Delirious (enchant)
--------
{ Prefix Modifier "Abyssal" (Tier: 1) }
Abysses lead to an Abyssal Boss — Unscalable Value
{ Suffix Modifier "of Obstruction" (Tier: 1) }
Monsters are Armoured — Unscalable Value
{ Suffix Modifier "of Hoards" (Tier: 1) }
Map contains an additional Rare Chest — Unscalable Value
{ Suffix Modifier "of the Prism" (Tier: 1) }
+20(20-24)% Monster Elemental Resistances (desecrated)
--------
Can be used in a Map Device, allowing you to enter a Map. Waystones can only be used once.`

const TABLET_RITUAL_DEVOTION = `Item Class: Tablet
Rarity: Rare
Empyrean Writ
Ritual Tablet
--------
Item Level: 80
--------
{ Implicit Modifier }
Adds Ritual Altars to a Map
10 uses remaining
--------
{ Prefix Modifier "Challenger's" (Tier: 1) }
Monsters have 14(10-15)% increased Effectiveness
{ Prefix Modifier "Azmeri's" (Tier: 1) }
Map contains 1 additional Azmeri Spirit
{ Suffix Modifier "of Omens" (Tier: 1) }
Ritual Favours in Map have 47(35-70)% increased chance to be Omens
{ Suffix Modifier "of Devotion" (Tier: 1) }
Deferring Favours at Ritual Altars in Map costs 24(30-20)% reduced Tribute
--------
Can be used in a personal Map Device to add modifiers to a Map.`

const TABLET_EXPEDITION_RARE = `Item Class: Tablet
Rarity: Rare
Empyrean Rite
Expedition Tablet
--------
Item Level: 81
--------
{ Implicit Modifier }
Adds a Kalguuran Expedition to a Map
10 uses remaining
--------
{ Prefix Modifier "Brimming" (Tier: 1) }
Map has 32(25-35)% increased number of Rare Monsters
{ Prefix Modifier "Abounding" (Tier: 1) }
Map has 20(15-20)% increased Monster Rarity
{ Prefix Modifier "Challenger's" (Tier: 1) }
Monsters have 15(10-15)% increased Effectiveness
{ Suffix Modifier "of the Demolition" (Tier: 1) }
6(5-10)% increased Expedition Explosive Area of Effect in Map
{ Suffix Modifier "of Treasure" (Tier: 1) }
Expeditions contain 2(1-2) buried Strongboxes in Map
--------
Can be used in a personal Map Device to add modifiers to a Map.
--------
Corrupted`

const TABLET_OVERSEER_VAAL = `Item Class: Tablet
Rarity: Rare
Cosmic Incitement
Overseer Tablet
--------
Item Level: 81
--------
{ Implicit Modifier }
Empowers the Map Boss of a Map
10 uses remaining
--------
{ Prefix Modifier "Bountiful" (Tier: 1) }
26(25-35)% increased Gold found in Map
{ Suffix Modifier "of Worship" (Tier: 1) }
Map has 74(70-100)% increased chance to contain Shrines
{ Suffix Modifier "of Twins" (Tier: 1) }
Map contains an additional Abyss — Unscalable Value
--------
Can be used in a personal Map Device to add modifiers to a Map.
--------
Note: ~b/o 14 vaal`

test('PoE 2 0.5.x spec: limit is 250 and line-by-line semantics prevent cross-line matches', () => {
  assert.equal(LIMIT, 250)
  assert.equal(overLimit('a'.repeat(250)), false)
  assert.equal(overLimit('a'.repeat(251)), true)
  // Two separate lines must not be bridged by "." or ".*".
  assert.equal(poe2Search('"Frostbitten.*Extra Cold"', WAYSTONE_RARE_T15), false)
  assert.equal(poe2Search('"Frostbitten" "Extra Cold"', WAYSTONE_RARE_T15), true)
})

test('PoE 2 0.5.x real waystone: rolled mod minimums match inline (min-max) ranges and ignore tier upper bounds', () => {
  const extraFire = findMod(WTABLE, 'Monsters deal #% of Damage as Extra Fire')
  const extraCold = findMod(WTABLE, 'Monsters deal #% of Damage as Extra Cold')
  const curseLess = findMod(WTABLE, '#% less effect of Curses on Monsters')
  const armourBreak = findMod(WTABLE, 'Monsters Break Armour equal to #%')
  const eleRes = findMod(WTABLE, '+#% Monster Elemental Resistances')

  // Extra Fire rolled 16(15-19)%: must match min<=16, must REJECT min=17..19 (must not match upper bound 19!)
  assert.equal(poe2Search(generate('waystone', W({ want: [{ id: extraFire.id, min: 15 }] }), WTABLE), WAYSTONE_RARE_T15), true)
  assert.equal(poe2Search(generate('waystone', W({ want: [{ id: extraFire.id, min: 16 }] }), WTABLE), WAYSTONE_RARE_T15), true)
  assert.equal(poe2Search(generate('waystone', W({ want: [{ id: extraFire.id, min: 17 }] }), WTABLE), WAYSTONE_RARE_T15), false)
  assert.equal(poe2Search(generate('waystone', W({ want: [{ id: extraFire.id, min: 19 }] }), WTABLE), WAYSTONE_RARE_T15), false)

  // Extra Cold rolled 18(15-19)%
  assert.equal(poe2Search(generate('waystone', W({ want: [{ id: extraCold.id, min: 18 }] }), WTABLE), WAYSTONE_RARE_T15), true)
  assert.equal(poe2Search(generate('waystone', W({ want: [{ id: extraCold.id, min: 19 }] }), WTABLE), WAYSTONE_RARE_T15), false)

  // Reversed range 42(50-40)%: must match min=42, reject min=45 (must not match 50!)
  assert.equal(poe2Search(generate('waystone', W({ want: [{ id: curseLess.id, min: 42 }] }), WTABLE), WAYSTONE_RARE_T15), true)
  assert.equal(poe2Search(generate('waystone', W({ want: [{ id: curseLess.id, min: 45 }] }), WTABLE), WAYSTONE_RARE_T15), false)

  // Armour break 17(15-20)%
  assert.equal(poe2Search(generate('waystone', W({ want: [{ id: armourBreak.id, min: 17 }] }), WTABLE), WAYSTONE_MAGIC_FLAMES), true)
  assert.equal(poe2Search(generate('waystone', W({ want: [{ id: armourBreak.id, min: 20 }] }), WTABLE), WAYSTONE_MAGIC_FLAMES), false)

  // Leading-plus touching roll: +20(20-24)% Monster Elemental Resistances (desecrated)
  assert.equal(poe2Search(generate('waystone', W({ want: [{ id: eleRes.id, min: 20 }] }), WTABLE), WAYSTONE_IMPLICIT_UNSCALABLE), true)
  assert.equal(poe2Search(generate('waystone', W({ want: [{ id: eleRes.id, min: 22 }] }), WTABLE), WAYSTONE_IMPLICIT_UNSCALABLE), false)
})

test('PoE 2 0.5.x real waystone: unscalable and desecrated mods match despite trailing suffixes', () => {
  const abyssBoss = findMod(WTABLE, 'Abysses lead to an Abyssal Boss')
  const armoured = findMod(WTABLE, 'Monsters are Armoured')
  const rareChest = findMod(WTABLE, 'Map contains an additional Rare Chest')
  const eleWeak = findMod(WTABLE, 'Elemental Weakness')

  for (const mod of [abyssBoss, armoured, rareChest]) {
    const wantStr = generate('waystone', W({ want: [{ id: mod.id, min: 0 }] }), WTABLE)
    const avoidStr = generate('waystone', W({ avoid: [mod.id] }), WTABLE)
    assert.equal(poe2Search(wantStr, WAYSTONE_IMPLICIT_UNSCALABLE), true, `want ${mod.text} (${wantStr}) should match`)
    assert.equal(poe2Search(avoidStr, WAYSTONE_IMPLICIT_UNSCALABLE), false, `avoid ${mod.text} (${avoidStr}) should exclude`)
  }
  assert.equal(poe2Search(generate('waystone', W({ want: [{ id: eleWeak.id, min: 0 }] }), WTABLE), WAYSTONE_RARE_T15), true)
})

test('PoE 2 0.5.x real waystone: affix headers and { Implicit Modifier } never cause false positives', () => {
  const crit = findMod(WTABLE, 'Critical Hit Chance')
  const flask = findMod(WTABLE, 'reduced Flask Charges')
  const faridun = findMod(WTABLE, 'Faridun Monsters')

  // WAYSTONE_IMPLICIT_UNSCALABLE has { Implicit Modifier } but NO crit mod.
  assert.equal(poe2Search(generate('waystone', W({ want: [{ id: crit.id, min: 0 }] }), WTABLE), WAYSTONE_IMPLICIT_UNSCALABLE), false)
  assert.equal(poe2Search(generate('waystone', W({ avoid: [crit.id] }), WTABLE), WAYSTONE_IMPLICIT_UNSCALABLE), true)

  // WAYSTONE_MAGIC_FLAMES has "of Flames" (Ignited Ground), NOT Flask Charges or Faridun.
  assert.equal(poe2Search(generate('waystone', W({ want: [{ id: flask.id, min: 0 }] }), WTABLE), WAYSTONE_MAGIC_FLAMES), false)
  assert.equal(poe2Search(generate('waystone', W({ avoid: [flask.id] }), WTABLE), WAYSTONE_MAGIC_FLAMES), true)
  assert.equal(poe2Search(generate('waystone', W({ want: [{ id: faridun.id, min: 0 }] }), WTABLE), WAYSTONE_MAGIC_FLAMES), false)
  assert.equal(poe2Search(generate('waystone', W({ avoid: [faridun.id] }), WTABLE), WAYSTONE_MAGIC_FLAMES), true)
})

test('PoE 2 0.5.x real tablets: kind filters, rolled minimums, unscalable mods, and affix headers', () => {
  // Delirium filter must NOT match a Ritual tablet whose suffix is "of Devotion"!
  const deliriumOnly = generate('tablet', T({ type: { ...defaults.tablet.type, delirium: true } }), TTABLE)
  assert.equal(poe2Search(deliriumOnly, TABLET_RITUAL_DEVOTION), false, `Delirium filter (${deliriumOnly}) falsely matched Ritual tablet`)

  // Ritual filter MUST match Ritual tablet, NOT Expedition or Overseer.
  const ritualOnly = generate('tablet', T({ type: { ...defaults.tablet.type, ritual: true } }), TTABLE)
  assert.equal(poe2Search(ritualOnly, TABLET_RITUAL_DEVOTION), true)
  assert.equal(poe2Search(ritualOnly, TABLET_EXPEDITION_RARE), false)
  assert.equal(poe2Search(ritualOnly, TABLET_OVERSEER_VAAL), false)

  // Tablet searches with only rarity must NOT match a Rare Waystone named "Mystic Remnant"!
  const rareTablet = generate('tablet', T({ rarity: { normal: false, magic: false, rare: true } }), TTABLE)
  assert.equal(poe2Search(rareTablet, WAYSTONE_IMPLICIT_UNSCALABLE), false, `Rare tablet filter (${rareTablet}) falsely matched Rare Waystone "Mystic Remnant"`)
  assert.equal(poe2Search(rareTablet, TABLET_RITUAL_DEVOTION), true)

  // Rolled tablet minimums with inline ranges (including reversed 24(30-20)%)
  const eff = findMod(TTABLE, 'Monsters have #% increased Effectiveness')
  const omens = findMod(TTABLE, 'chance to be Omens')
  const defer = findMod(TTABLE, 'Deferring Favours at Ritual Altars in Map costs #% reduced Tribute')
  const mrar = findMod(TTABLE, 'Map has #% increased Monster Rarity')

  assert.equal(poe2Search(generate('tablet', T({ want: [{ id: eff.id, min: 14 }] }), TTABLE), TABLET_RITUAL_DEVOTION), true)
  assert.equal(poe2Search(generate('tablet', T({ want: [{ id: eff.id, min: 15 }] }), TTABLE), TABLET_RITUAL_DEVOTION), false)
  assert.equal(poe2Search(generate('tablet', T({ want: [{ id: omens.id, min: 45 }] }), TTABLE), TABLET_RITUAL_DEVOTION), true)
  assert.equal(poe2Search(generate('tablet', T({ want: [{ id: omens.id, min: 50 }] }), TTABLE), TABLET_RITUAL_DEVOTION), false)
  assert.equal(poe2Search(generate('tablet', T({ want: [{ id: defer.id, min: 24 }] }), TTABLE), TABLET_RITUAL_DEVOTION), true)
  assert.equal(poe2Search(generate('tablet', T({ want: [{ id: defer.id, min: 25 }] }), TTABLE), TABLET_RITUAL_DEVOTION), false)
  assert.equal(poe2Search(generate('tablet', T({ want: [{ id: mrar.id, min: 20 }] }), TTABLE), TABLET_EXPEDITION_RARE), true)
  assert.equal(poe2Search(generate('tablet', T({ want: [{ id: mrar.id, min: 21 }] }), TTABLE), TABLET_EXPEDITION_RARE), false)

  // Unscalable tablet mod ("Map contains an additional Abyss — Unscalable Value")
  const addAbyss = findMod(TTABLE, 'Map contains an additional Abyss')
  assert.equal(poe2Search(generate('tablet', T({ want: [{ id: addAbyss.id, min: 0 }] }), TTABLE), TABLET_OVERSEER_VAAL), true)

  // Affix header collisions: "of Worship" must NOT match Wombgifts; "of Twins" must NOT match Abyss Pits twice
  const wombgifts = findMod(TTABLE, 'Quantity of Wombgifts')
  const abyssTwice = findMod(TTABLE, 'twice as likely to have Rewards')
  assert.equal(poe2Search(generate('tablet', T({ want: [{ id: wombgifts.id, min: 0 }] }), TTABLE), TABLET_OVERSEER_VAAL), false)
  assert.equal(poe2Search(generate('tablet', T({ want: [{ id: abyssTwice.id, min: 0 }] }), TTABLE), TABLET_OVERSEER_VAAL), false)
})

test('PoE 2 0.5.x exhaustive: every waystone & tablet mod handles inline roll ranges, upper-bound rejection, and trailing tags', () => {
  for (const [kind, table, baseHeader] of [
    ['waystone', WTABLE, 'Item Class: Waystones\nRarity: Rare\nWaystone (Tier 15)\n--------\nRevives Available: 2 (augmented)\n--------'],
    ['tablet', TTABLE, 'Item Class: Tablet\nRarity: Rare\nIrradiated Tablet\n--------\n{ Implicit Modifier }\nAdds Irradiated to a Map\n10 uses remaining\n--------'],
  ]) {
    const mk = kind === 'waystone' ? W : T
    for (const mod of table.mods) {
      // Every form must match even with " — Unscalable Value" or "(desecrated)" at the end of the line.
      const wantAny = generate(kind, mk({ want: [{ id: mod.id, min: 0 }] }), table)
      for (const form of mod.text.split(' ~ ')) {
        const rendered = form.replace(/#/g, '18(15-25)').split(' | ').map(l => `${l} — Unscalable Value`).join('\n')
        assert.equal(poe2Search(wantAny, `${baseHeader}\n${rendered}`), true, `${kind} want ${mod.text} failed on 0.5.x line:\n  str: ${wantAny}\n  line: ${rendered}`)
      }
      // Every mod offering a minimum must match roll(lo-hi) iff roll >= min (even when hi >= min!).
      if (mod.num) {
        for (const [min, roll, lo, hi, expect] of [
          [1, 1, 1, 5, true],
          [5, 4, 1, 9, false],
          [5, 5, 1, 9, true],
          [10, 9, 5, 15, false],
          [10, 10, 5, 15, true],
          [15, 14, 10, 20, false],
          [15, 15, 10, 20, true],
          [20, 19, 15, 25, false],
          [20, 20, 15, 25, true],
          [45, 42, 50, 40, false],
          [42, 42, 50, 40, true],
          [100, 99, 80, 120, false],
          [100, 100, 80, 120, true],
        ]) {
          const str = generate(kind, mk({ want: [{ id: mod.id, min }] }), table)
          const lineWithRange = mod.text.split(' ~ ')[0].replace('#', `${roll}(${lo}-${hi})`)
          const linePlain = mod.text.split(' ~ ')[0].replace('#', String(roll))
          assert.equal(poe2Search(str, `${baseHeader}\n${lineWithRange}`), expect, `${kind} ${mod.text} min=${min} vs ${roll}(${lo}-${hi}) -> ${str}`)
          assert.equal(poe2Search(str, `${baseHeader}\n${linePlain}`), expect, `${kind} ${mod.text} min=${min} vs plain ${roll} -> ${str}`)
        }
      }
    }
  }
})
