// The Waystone and Tablet generators and their trade queries (docs/regex-filters-plan.md).
// Expected strings are what the game's search box needs; the settings shape and the table
// shape are ours. A table row carries what the sync script derived: the token, the trade ids
// GGG lists for the text, and `num` (where the roll sits relative to the token, or null).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaults, LIMIT, KINDS } from '../src/lib/regex/defaults.js'
import { rarity, selectedMod, placement } from '../src/lib/regex/terms.js'
import { waystoneRegex } from '../src/lib/regex/waystone.js'
import { tabletRegex } from '../src/lib/regex/tablet.js'
import { waystoneQuery, tabletQuery } from '../src/lib/regex/trade.js'
import { generate, query } from '../src/lib/regex/index.js'

const W = (over = {}) => ({ ...structuredClone(defaults.waystone), ...over })
const T = (over = {}) => ({ ...structuredClone(defaults.tablet), ...over })
// Rows as the sync script writes them (num is derived from text + regex by `placement`).
const row = (id, text, regex, trade = []) => ({ id, text, regex, trade, num: placement(text, regex) })
const mods = [
  row('chains', 'Players are periodically Cursed with Temporal Chains', 'hains$', ['explicit.stat_1']),
  row('fire', 'Monsters deal #% of Damage as Extra Fire', 'a fire$', ['explicit.stat_2']),
  row('pack', '#% increased Pack Size', 'pack', ['explicit.stat_3', 'explicit.stat_3b']),
  row('notrade', 'Players have #% less Cooldown Recovery Rate', 'cool'),
  row('magic', 'Map has #% increased Magic Monsters', '^M.*gi', ['explicit.stat_4']),
  row('res', '-#% maximum Player Resistances', '% ma', ['explicit.stat_5']),
  row('two', 'Monsters have #% increased Stun Threshold | Monsters have #% increased Ailment Threshold', 'Thr'),
  row('forms', 'Map contains an additional Shrine ~ Map contains # additional Shrines', 'l Shrine', ['explicit.stat_6']),
]
const kinds = [
  { key: 'ritual', label: 'Ritual', base: 'Ritual Tablet', description: 'Adds Ritual Altars to a Map', regex: '^adds rit' },
  { key: 'breach', label: 'Breach', base: 'Breach Tablet', description: 'Adds an Otherworldy Breach to a Map', regex: '^adds an ot' },
  { key: 'abyss', label: 'Abyss', base: 'Abyss Tablet', description: 'Adds Abysses to a Map', regex: '^adds aby' },
]
const WT = { mods }
const TT = { mods, kinds }

test('the limit is the game search box; the kinds are the two tabs', () => {
  assert.equal(LIMIT, 250)
  assert.deepEqual(KINDS, ['waystone', 'tablet'])
})

test('rarity term', () => {
  assert.equal(rarity({ normal: false, magic: false, rare: false }), null)
  assert.equal(rarity({ normal: true, magic: true, rare: true }), null)
  assert.equal(rarity({ normal: false, magic: false, rare: true }), '"y: r"')
  assert.equal(rarity({ normal: false, magic: true, rare: true }), '"y: (m|r)"')
})

test('placement: where the roll sits relative to the token, derived once from text and token', () => {
  assert.equal(placement('Players are periodically Cursed with Temporal Chains', 'hains$'), null)      // no roll
  assert.deepEqual(placement('Monsters deal #% of Damage as Extra Fire', 'a fire$'), { side: 'after', gap: true, after: '%' })
  assert.deepEqual(placement('Monsters have #% increased Life', 'nsters h'), { side: 'before', gap: true, after: '%' })
  assert.deepEqual(placement('-#% maximum Player Resistances', '% ma'), { side: 'after', gap: false, after: '%' })
  assert.deepEqual(placement('Map has #% increased Magic Monsters', '^M.*gi'), { side: 'inside', gap: true, after: '%' })
  assert.deepEqual(placement('Map contains # additional Shrines', 'ines$'), { side: 'after', gap: true, after: ' ' })
  // no minimum on offer: a two-line mod, a mod with several printed forms, two rolls, or a
  // token on the other line from the roll
  assert.equal(placement('Monsters have #% increased Stun Threshold | Monsters have #% increased Ailment Threshold', 'Thr'), null)
  assert.equal(placement('Map contains an additional Shrine ~ Map contains # additional Shrines', 'l Shrine'), null)
  assert.equal(placement('Abyssal Monsters have #% increased Effectiveness for each closed Pit, up to #%', 't,'), null)
  assert.equal(placement('Players are Marked for Death for # seconds | after killing a Rare or Unique monster', 'af'), null)
})

test('a minimum is the number pattern anchored on the character after the roll, on the side the roll lives', () => {
  const byId = Object.fromEntries(mods.map(m => [m.id, m]))
  assert.equal(selectedMod(byId.fire, { min: 0 }, false), 'a fire$')
  assert.equal(selectedMod(byId.fire, { min: 12 }, false), '(1[2-9]|[2-9]\\d|\\d\\d\\d)%.*a fire$')
  assert.equal(selectedMod(row('life', 'Monsters have #% increased Life', 'nsters h'), { min: 25 }, true), 'nsters h.*([2-9]\\d|\\d\\d\\d)%')
  // touching the roll: no ".*", the token is the anchor
  assert.equal(selectedMod(byId.res, { min: 1 }, false), '([1-9]|\\d\\d\\d?)% ma')
  assert.equal(new RegExp(selectedMod(byId.res, { min: 1 }, false), 'i').test('-1% maximum Player Resistances'), true)
  // a bridged token takes the number inside the bridge
  assert.equal(selectedMod(byId.magic, { min: 37 }, false), '^M.*(3[7-9]|[4-9]\\d|\\d\\d\\d)%.*gi')
  assert.equal(new RegExp(selectedMod(byId.magic, { min: 37 }, false), 'im').test('Map has 37% increased Magic Monsters'), true)
  assert.equal(new RegExp(selectedMod(byId.magic, { min: 37 }, false), 'im').test('Map has 5% increased Magic Monsters'), false)
  // rounded to 0 is "any": bare token
  assert.equal(selectedMod(byId.res, { min: 7 }, true), '% ma')
  // no placement: bare token whatever the minimum
  assert.equal(selectedMod(byId.two, { min: 3 }, false), 'Thr')
  assert.equal(selectedMod(byId.forms, { min: 3 }, false), 'l Shrine')
  for (const [min, roll, want] of [[12, 5, false], [12, 12, true], [12, 215, true], [30, 25, false], [30, 119, true], [130, 25, false], [3, 8, true], [3, 2, false]]) {
    const re = new RegExp(selectedMod(byId.fire, { min }, false), 'i')
    assert.equal(re.test(`Monsters deal ${roll}% of Damage as Extra Fire`), want, `min ${min} roll ${roll}`)
  }
})

test('waystone: nothing selected emits nothing', () => {
  assert.equal(waystoneRegex(W(), WT), '')
})

test('waystone: tier, revives, state, rarity, yields', () => {
  assert.equal(waystoneRegex(W({ tier: { min: 14, max: 16 } }), WT), '"r 1[4-6]\\)"')
  assert.equal(waystoneRegex(W({ tier: { min: 3, max: 12 } }), WT), '"r ([3-9]|1[0-2])\\)"')
  assert.equal(waystoneRegex(W({ tier: { min: 16, max: 16 } }), WT), '"r 16\\)"')
  assert.equal(waystoneRegex(W({ tier: { min: 1, max: 9 } }), WT), '"r [1-9]\\)"')
  assert.equal(waystoneRegex(W({ tier: { min: 4, max: 4 } }), WT), '"r 4\\)"')
  assert.equal(waystoneRegex(W({ tier: { min: 10, max: 16 } }), WT), '"r 1[0-6]\\)"')
  assert.equal(waystoneRegex(W({ tier: { min: 5, max: 3 } }), WT), '')
  // Every other string carries the kind anchor "e \(T" ("Waystone (Tier 14)"), so a search in a
  // stash tab that also holds tablets never keeps a tablet. A tier term is its own anchor.
  assert.equal(waystoneRegex(W({ revives: { min: 2, max: 4 } }), WT), '"e \\(T" "le: [2-4]"')
  assert.equal(waystoneRegex(W({ revives: { min: 0, max: 0 } }), WT), '"e \\(T" "le: 0"')
  assert.equal(waystoneRegex(W({ state: { corrupted: true, uncorrupted: false, delirious: false } }), WT), '"e \\(T" corr')
  assert.equal(waystoneRegex(W({ state: { corrupted: false, uncorrupted: true, delirious: true } }), WT), '"e \\(T" delir !corr')
  assert.equal(waystoneRegex(W({ rarity: { normal: false, magic: true, rare: true } }), WT), '"e \\(T" "y: (m|r)"')
  assert.equal(waystoneRegex(W({ packSize: 30 }), WT), '"e \\(T" "k s.*([3-9].|\\d..)%"')
  assert.equal(waystoneRegex(W({ itemRarity: 55, round10: true }), WT), '"e \\(T" "m rar.*([5-9].|\\d..)%"')
  assert.equal(waystoneRegex(W({ itemRarity: 5, round10: true }), WT), '')
  assert.equal(waystoneRegex(W({ dropChance: 5, monsterEffect: 100, monsterRarity: 20 }), WT),
    '"e \\(T" "p c.*([5-9]|\\d..?)%" "r ef.*[1-9]..%" "r rar.*([2-9].|\\d..)%"')
})

test('waystone: wanted and unwanted mods', () => {
  assert.equal(waystoneRegex(W({ want: [{ id: 'chains', min: 0 }, { id: 'fire', min: 0 }] }), WT), '"e \\(T" "hains$|a fire$"')
  assert.equal(waystoneRegex(W({ want: [{ id: 'chains', min: 0 }, { id: 'fire', min: 0 }], wantMode: 'all' }), WT), '"e \\(T" "hains$" "a fire$"')
  assert.equal(waystoneRegex(W({ avoid: ['chains', 'pack'] }), WT), '"e \\(T" "!hains$|pack"')
  assert.equal(waystoneRegex(W({ want: [{ id: 'fire', min: 15 }], avoid: ['chains'] }), WT), '"e \\(T" "(1[5-9]|[2-9]\\d|\\d\\d\\d)%.*a fire$" "!hains$"')
  assert.equal(waystoneRegex(W({ want: [{ id: 'gone', min: 0 }] }), WT), '')   // an id not in the table is ignored
})

test('waystone: price and append, in order', () => {
  const s = W({ tier: { min: 14, max: 16 }, price: { on: true, trade: false, min: 1, max: 25, currency: 'exalted' }, append: '"^com"' })
  assert.equal(waystoneRegex(s, WT), '"r 1[4-6]\\)" " ([1-9]|1\\d|2[0-5])(\\.\\d+)? exalted" "^com"')
})

test('tablet: type, uses, rarity, mods, price', () => {
  assert.equal(tabletRegex(T(), TT), '')
  // The kind anchor " rem" ("10 uses remaining", "1 use remaining") keeps waystones out; a uses
  // term is its own anchor.
  assert.equal(tabletRegex(T({ type: { ...defaults.tablet.type, ritual: true } }), TT), '" rem" "(^adds rit)"')
  assert.equal(tabletRegex(T({ type: { ...defaults.tablet.type, breach: true, abyss: true } }), TT), '" rem" "(^adds an ot|^adds aby)"')
  assert.equal(tabletRegex(T({ type: { ...defaults.tablet.type, breach: true, temple: true } }), TT), '" rem" "(^adds an ot)"')   // a kind the table lacks is ignored
  assert.equal(tabletRegex(T({ uses: 5 }), TT), '"([5-9]|1[0-8]) us"')
  assert.equal(tabletRegex(T({ uses: 9 }), TT), '"(9|1[0-8]) us"')
  assert.equal(tabletRegex(T({ uses: 14 }), TT), '"1[4-8] us"')
  assert.equal(tabletRegex(T({ uses: 19 }), TT), '')
  assert.equal(tabletRegex(T({ rarity: { normal: true, magic: false, rare: false } }), TT), '" rem" "y: n"')
  assert.equal(tabletRegex(T({ want: [{ id: 'pack', min: 0 }, { id: 'fire', min: 0 }] }), TT), '" rem" "pack|a fire$"')
  assert.equal(tabletRegex(T({ want: [{ id: 'pack', min: 25 }, { id: 'fire', min: 0 }], wantMode: 'all' }), TT),
    '" rem" "(2[5-9]|[3-9]\\d|\\d\\d\\d)%.*pack" "a fire$"')
  assert.equal(tabletRegex(T({ want: [{ id: 'pack', min: 25 }], round10: true }), TT), '" rem" "([2-9]\\d|\\d\\d\\d)%.*pack"')
  assert.equal(tabletRegex(T({ price: { on: true, trade: false, min: 1, max: 9, currency: 'divine' } }), TT), '" rem" " [1-9](\\.\\d+)? divine"')
})

test('waystone trade query: instant buyout, rarity from the toggles, every id GGG lists for a text', () => {
  assert.deepEqual(waystoneQuery(W(), WT), {
    query: { status: { option: 'securable' }, filters: { type_filters: { disabled: false, filters: { category: { option: 'map.waystone' } } } } },
    sort: { price: 'asc' },
  })
  assert.deepEqual(waystoneQuery(W({ rarity: { normal: false, magic: false, rare: true } }), WT).query.filters.type_filters.filters.rarity, { option: 'rare' })
  assert.deepEqual(waystoneQuery(W({ rarity: { normal: true, magic: false, rare: false } }), WT).query.filters.type_filters.filters.rarity, { option: 'normal' })
  assert.equal(waystoneQuery(W({ rarity: { normal: true, magic: true, rare: false } }), WT).query.filters.type_filters.filters.rarity, undefined)
  assert.deepEqual(waystoneQuery(W({ packSize: 20 }), WT).query.filters.map_filters, { disabled: false, filters: { map_packsize: { min: 20 } } })
  const q = waystoneQuery(W({
    tier: { min: 14, max: 15 }, itemRarity: 30, dropChance: 40,
    state: { corrupted: true, uncorrupted: false, delirious: true },
    want: [{ id: 'fire', min: 12 }, { id: 'notrade', min: 0 }, { id: 'pack', min: 0 }], wantMode: 'any', avoid: ['chains', 'pack'],
    price: { on: false, trade: true, min: 5, max: 50, currency: 'divine' },
  }), WT)
  assert.deepEqual(q.query.filters.map_filters.filters, { map_tier: { min: 14, max: 15 }, map_iir: { min: 30 }, map_bonus: { min: 40 } })
  assert.deepEqual(q.query.filters.misc_filters, { disabled: false, filters: { corrupted: { option: 'true' } } })
  assert.deepEqual(q.query.stats, [
    // "any": one group, every id of every wanted mod (a mod GGG lists twice gets both), at least one
    { type: 'count', filters: [{ id: 'explicit.stat_2', value: { min: 12 } }, { id: 'explicit.stat_3' }, { id: 'explicit.stat_3b' }], value: { min: 1 } },
    { type: 'not', filters: [{ id: 'explicit.stat_1' }, { id: 'explicit.stat_3' }, { id: 'explicit.stat_3b' }] },
    { type: 'and', filters: [{ id: 'enchant.stat_1715784068' }] },
  ])
  assert.deepEqual(q.query.filters.trade_filters, { filters: { price: { option: 'divine', min: 5, max: 50 } } })
  // "all": one group per mod, so a mod with two ids still needs only one of them
  assert.deepEqual(waystoneQuery(W({ want: [{ id: 'fire', min: 0 }, { id: 'pack', min: 0 }], wantMode: 'all' }), WT).query.stats, [
    { type: 'count', filters: [{ id: 'explicit.stat_2' }], value: { min: 1 } },
    { type: 'count', filters: [{ id: 'explicit.stat_3' }, { id: 'explicit.stat_3b' }], value: { min: 1 } },
  ])
})

test('tablet trade query: base from the kinds table, uses pegged at 10', () => {
  const q = tabletQuery(T({ type: { ...defaults.tablet.type, ritual: true }, rarity: { normal: false, magic: true, rare: false }, uses: 6,
    want: [{ id: 'pack', min: 25 }], price: { on: false, trade: true, min: 0, max: 20, currency: 'exalted' } }), TT)
  assert.equal(q.query.status.option, 'securable')
  assert.equal(q.query.type, 'Ritual Tablet')
  assert.deepEqual(q.query.filters.type_filters.filters, { category: { option: 'map.tablet' }, rarity: { option: 'magic' } })
  // The trade search always asks for 10 uses remaining, whatever the string asks for (owner,
  // 2026-09-24); proven on the live site: 1251 Breach tablets, 914 with 10 uses.
  assert.deepEqual(q.query.stats, [
    { type: 'count', filters: [{ id: 'explicit.stat_3', value: { min: 25 } }, { id: 'explicit.stat_3b', value: { min: 25 } }], value: { min: 1 } },
    { type: 'and', filters: [{ id: 'pseudo.pseudo_number_of_uses_remaining', value: { min: 10 } }] },
  ])
  assert.deepEqual(tabletQuery(T(), TT).query.stats, [{ type: 'and', filters: [{ id: 'pseudo.pseudo_number_of_uses_remaining', value: { min: 10 } }] }])
  assert.deepEqual(tabletQuery(T({ uses: 14 }), TT).query.stats, [{ type: 'and', filters: [{ id: 'pseudo.pseudo_number_of_uses_remaining', value: { min: 10 } }] }])
  assert.deepEqual(tabletQuery(T({ rarity: { normal: false, magic: false, rare: true } }), TT).query.filters.type_filters.filters.rarity, { option: 'rare' })
  assert.equal(tabletQuery(T({ type: { ...defaults.tablet.type, ritual: true, breach: true } }), TT).query.type, undefined)
})

test('the facade dispatches by kind', () => {
  assert.equal(generate('waystone', W({ tier: { min: 14, max: 16 } }), WT), '"r 1[4-6]\\)"')
  assert.equal(generate('tablet', T({ uses: 5 }), TT), '"([5-9]|1[0-8]) us"')
  assert.equal(query('tablet', T(), TT).query.type, undefined)
  assert.equal(generate('nope', {}, WT), '')
  assert.equal(query('nope', {}, WT), null)
})
