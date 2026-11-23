// Feature 3: "Close-enough" fuzzy rare finder — pure relaxation & real-rate selection tests.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseNodeQuery,
  canRelax,
  relaxQuery,
  relaxSummary,
  rankRelaxedRows,
  applyRelaxedCurrency,
  bestRelaxedCurrency,
} from '../src/lib/relaxQuery.js'

const P = {
  vaal: 0.012811502165494587,
  chaos: 0.09150921466842146,
  exalted: 0.0014669982480578286,
  divine: 1,
}

const OPTIONS = [
  { id: 'exalted_divine', text: 'Exalted / Divine' },
  { id: 'exalted', text: 'Exalted Orb' },
  { id: 'chaos', text: 'Chaos Orb' },
  { id: 'vaal', text: 'Vaal Orb' },
  { id: 'divine', text: 'Divine Orb' },
]

// Realistic EE2-generated 5-mod rare ring query.
const RARE_5MOD = {
  status: { option: 'securable' },
  stats: [
    {
      type: 'and',
      filters: [
        { id: 'explicit.stat_3299347043', value: { min: 100 } },              // +100 to maximum Life
        { id: 'explicit.stat_3372524247', value: { min: 40 } },               // +40% Fire Resistance
        { id: 'explicit.stat_1671376347', value: { min: 35, max: 45 } },      // Lightning Res range
        { id: 'explicit.stat_210067635', value: { min: 1 } },                 // min 1 floor stays >= 1
        { id: 'explicit.stat_999999999', value: { option: 3 } },              // option-only mod stays intact
        { id: 'explicit.stat_disabled', value: { min: 50 }, disabled: true }, // disabled mod excluded
      ],
    },
  ],
  filters: {
    type_filters: { filters: { category: { option: 'accessory.ring' }, rarity: { option: 'nonunique' } } },
    equipment_filters: { filters: { ar: { min: 200 } } },
    misc_filters: { filters: { ilvl: { min: 80 }, corrupted: { option: 'false' } } },
    trade_filters: { filters: { price: { option: 'chaos' }, indexed: { option: '1week' } } },
  },
}

test('parseNodeQuery extracts query from { query, sort } or bare query JSON, returns null on junk/degraded', () => {
  assert.deepEqual(parseNodeQuery({ q: JSON.stringify({ query: RARE_5MOD, sort: { price: 'asc' } }) }), RARE_5MOD)
  assert.deepEqual(parseNodeQuery({ q: JSON.stringify(RARE_5MOD) }), RARE_5MOD)
  assert.equal(parseNodeQuery({ q: JSON.stringify({ query: RARE_5MOD }), degraded: true }), null)
  assert.equal(parseNodeQuery({ q: 'not-json' }), null)
  assert.equal(parseNodeQuery({ q: '[]' }), null)
  assert.equal(parseNodeQuery({ q: 'null' }), null)
  assert.equal(parseNodeQuery({}), null)
  assert.equal(parseNodeQuery(null), null)
})

test('canRelax requires >= 2 enabled stat filters in enabled and/count groups', () => {
  assert.equal(canRelax(RARE_5MOD), true)
  assert.equal(canRelax({ status: { option: 'securable' }, type: 'Divine Orb' }), false, 'currency')
  assert.equal(canRelax({ status: { option: 'securable' }, name: 'Headhunter', type: 'Heavy Belt', stats: [{ type: 'and', filters: [] }] }), false, 'unique without stat filters')
  assert.equal(canRelax({ stats: [{ type: 'and', filters: [{ id: 's1', value: { min: 10 } }] }] }), false, '1-mod search')
  assert.equal(canRelax({
    stats: [{
      type: 'and',
      filters: [
        { id: 's1', value: { min: 10 } },
        { id: 's2', value: { min: 20 }, disabled: true },
      ],
    }],
  }), false, 'only 1 enabled mod')
  assert.equal(canRelax({
    stats: [{
      type: 'and',
      disabled: true,
      filters: [{ id: 's1' }, { id: 's2' }],
    }],
  }), false, 'disabled group')
  assert.equal(canRelax({
    stats: [{
      type: 'not',
      filters: [{ id: 's1' }, { id: 's2' }],
    }],
  }), false, 'not group is not relaxable')
  assert.equal(canRelax({
    stats: [{
      type: 'count',
      value: { min: 2 },
      filters: [{ id: 's1', value: { min: 20 } }, { id: 's2', value: { min: 30 } }],
    }],
  }), true, 'enabled count group with 2 mods is relaxable')
  assert.equal(canRelax(null), false)
})

test('relaxQuery level 1 converts active and/count mods into count (N-1) at 85% bounds, preserves filters, drops currency lock', () => {
  const before = JSON.stringify(RARE_5MOD)
  const r = relaxQuery(RARE_5MOD, 1)
  assert.ok(r)
  assert.equal(JSON.stringify(RARE_5MOD), before, 'input query is never mutated')

  assert.deepEqual(r.summary, {
    level: 1,
    required: 4,
    total: 5,
    keepPct: 85,
    canRelaxFurther: true,
  })
  assert.equal(relaxSummary(r.summary), 'Relaxed 4/5 · 85%')

  assert.deepEqual(r.query.status, { option: 'securable' })
  assert.equal(r.query.stats.length, 1)
  assert.equal(r.query.stats[0].type, 'count')
  assert.deepEqual(r.query.stats[0].value, { min: 4 })
  assert.deepEqual(r.query.stats[0].filters, [
    { id: 'explicit.stat_3299347043', value: { min: 85 } },
    { id: 'explicit.stat_3372524247', value: { min: 34 } },
    { id: 'explicit.stat_1671376347', value: { min: 29, max: 52 } },
    { id: 'explicit.stat_210067635', value: { min: 1 } },
    { id: 'explicit.stat_999999999', value: { option: 3 } },
  ])

  // Base, category, ilvl, corrupted, non-price trade filters preserved; equipment defense relaxes while non-defense stays intact.
  assert.deepEqual(r.query.filters.type_filters, RARE_5MOD.filters.type_filters)
  assert.deepEqual(r.query.filters.equipment_filters, { filters: { ar: { min: 170 } } })
  assert.deepEqual(r.query.filters.misc_filters, RARE_5MOD.filters.misc_filters)
  assert.deepEqual(r.query.filters.trade_filters, { filters: { indexed: { option: '1week' } } })
})

test('relaxQuery level 2 relaxes to (N-2) at 75% bounds when N >= 3, returns null when N === 2', () => {
  const r2 = relaxQuery(RARE_5MOD, 2)
  assert.ok(r2)
  assert.deepEqual(r2.summary, {
    level: 2,
    required: 3,
    total: 5,
    keepPct: 75,
    canRelaxFurther: false,
  })
  assert.equal(r2.query.stats[0].type, 'count')
  assert.deepEqual(r2.query.stats[0].value, { min: 3 })
  assert.deepEqual(r2.query.stats[0].filters[0], { id: 'explicit.stat_3299347043', value: { min: 75 } })
  assert.deepEqual(r2.query.stats[0].filters[1], { id: 'explicit.stat_3372524247', value: { min: 30 } })
  assert.deepEqual(r2.query.stats[0].filters[2], { id: 'explicit.stat_1671376347', value: { min: 26, max: 57 } })
  assert.deepEqual(r2.query.stats[0].filters[3], { id: 'explicit.stat_210067635', value: { min: 1 } })
  assert.deepEqual(r2.query.stats[0].filters[4], { id: 'explicit.stat_999999999', value: { option: 3 } })

  const twoMod = {
    stats: [{
      type: 'and',
      filters: [
        { id: 's1', value: { min: 20 } },
        { id: 's2', value: { min: 40 } },
      ],
    }],
  }
  const r1 = relaxQuery(twoMod, 1)
  assert.equal(r1.summary.required, 1)
  assert.equal(r1.summary.canRelaxFurther, false)
  assert.equal(relaxQuery(twoMod, 2), null, 'level 2 requires N >= 3')
  assert.equal(relaxQuery(RARE_5MOD, 3), null)
  assert.equal(relaxQuery(RARE_5MOD, 0), null)
})

test('relaxQuery handles negative numeric bounds, preserves non-and/disabled groups, and forces INSTANT_BUYOUT', () => {
  const negQuery = {
    status: { option: 'online' },
    type: 'Breach Ring',
    stats: [
      {
        type: 'and',
        filters: [
          { id: 'neg.min', value: { min: -20 } },
          { id: 'neg.max', value: { max: -20 } },
          { id: 'zero.bound', value: { min: 0, max: 0 } },
        ],
      },
      { type: 'not', filters: [{ id: 'avoid.stat' }] },
      { type: 'and', disabled: true, filters: [{ id: 'off.stat', value: { min: 99 } }] },
    ],
    filters: {
      trade_filters: { filters: { price: { option: 'divine', max: 5 } } },
    },
  }
  const r1 = relaxQuery(negQuery, 1)
  assert.deepEqual(r1.query.status, { option: 'securable' })
  assert.equal(r1.query.type, 'Breach Ring')
  assert.deepEqual(r1.query.stats[0].filters, [
    { id: 'neg.min', value: { min: -23 } },
    { id: 'neg.max', value: { max: -17 } },
    { id: 'zero.bound', value: { min: 0, max: 0 } },
  ])
  assert.deepEqual(r1.query.stats[1], { type: 'not', filters: [{ id: 'avoid.stat' }] })
  assert.deepEqual(r1.query.stats[2], { type: 'and', disabled: true, filters: [{ id: 'off.stat', value: { min: 99 } }] })
  assert.equal(r1.query.filters, undefined, 'empty trade_filters/filters dropped cleanly')

  const r2 = relaxQuery(negQuery, 2)
  assert.deepEqual(r2.query.stats[0].filters[0], { id: 'neg.min', value: { min: -25 } })
  assert.deepEqual(r2.query.stats[0].filters[1], { id: 'neg.max', value: { max: -15 } })
})

test('applyRelaxedCurrency sets price option and converts existing price bounds without mutating input', () => {
  const base = relaxQuery(RARE_5MOD, 1).query
  const priced = applyRelaxedCurrency(base, 'vaal', P)
  assert.equal(base.filters.trade_filters.filters.price, undefined)
  assert.deepEqual(priced.filters.trade_filters, {
    disabled: false,
    filters: { indexed: { option: '1week' }, price: { option: 'vaal' } },
  })
  assert.deepEqual(priced.status, { option: 'securable' })

  // Existing exalted_divine price cap preserved & converted into chosen currency (R3)
  const capped = {
    ...RARE_5MOD,
    filters: {
      ...RARE_5MOD.filters,
      trade_filters: { filters: { price: { option: 'exalted_divine', max: 100 } } },
    },
  }
  const relCapped = relaxQuery(capped, 1).query
  assert.deepEqual(relCapped.filters.trade_filters.filters.price, { max: 100 })
  const pricedCapped = applyRelaxedCurrency(relCapped, 'vaal', P)
  assert.equal(pricedCapped.filters.trade_filters.filters.price.option, 'vaal')
  assert.ok(pricedCapped.filters.trade_filters.filters.price.max > 0)
})

test('C1: count groups with min >= 2 relax their own min without tightening or merging distinct groups', () => {
  const twoOfFive = {
    stats: [{
      type: 'count',
      value: { min: 2 },
      filters: [
        { id: 's1', value: { min: 40 } },
        { id: 's2', value: { min: 40 } },
        { id: 's3', value: { min: 40 } },
        { id: 's4', value: { min: 40 } },
        { id: 's5', value: { min: 40 } },
      ],
    }],
  }
  const r1 = relaxQuery(twoOfFive, 1)
  assert.ok(r1)
  assert.equal(r1.query.stats.length, 1)
  assert.equal(r1.query.stats[0].value.min, 1, '2-of-5 relaxes to 1-of-5, never tightens to 4-of-5')
  assert.equal(r1.summary.required, 1)
  assert.equal(r1.summary.canRelaxFurther, false, 'already at min=1 floor')
  assert.equal(relaxQuery(twoOfFive, 2), null)

  // Two separate count groups stay separate and each relaxes its own min independently
  const twoGroups = {
    stats: [
      {
        type: 'count',
        value: { min: 2 },
        filters: [{ id: 'a1', value: { min: 20 } }, { id: 'a2', value: { min: 20 } }, { id: 'a3', value: { min: 20 } }],
      },
      {
        type: 'count',
        value: { min: 3 },
        filters: [{ id: 'b1', value: { min: 30 } }, { id: 'b2', value: { min: 30 } }, { id: 'b3', value: { min: 30 } }, { id: 'b4', value: { min: 30 } }],
      },
    ],
  }
  const g1 = relaxQuery(twoGroups, 1)
  assert.equal(g1.query.stats.length, 2, 'distinct count groups never merged')
  assert.equal(g1.query.stats[0].value.min, 1)
  assert.equal(g1.query.stats[1].value.min, 2)
  assert.equal(g1.summary.canRelaxFurther, true)
  const g2 = relaxQuery(twoGroups, 2)
  assert.equal(g2.query.stats.length, 2)
  assert.equal(g2.query.stats[0].value.min, 1)
  assert.equal(g2.query.stats[1].value.min, 1)
})

test('bestRelaxedCurrency ranks in Divine-equivalent units and triggers only when another filterable currency beats lead by > TAU', () => {
  // Lead: 17 chaos = 1.5557 div; cheaper: 105 vaal = 1.3452 div (15.6% cheaper -> pick vaal).
  const rows = [
    { id: 'a', amount: 17, currency: 'chaos' },
    { id: 'b', amount: 18, currency: 'chaos' },
    { id: 'c', amount: 105, currency: 'vaal' },
  ]
  const res = bestRelaxedCurrency(rows, P, OPTIONS)
  assert.equal(res.currency, 'vaal')
  assert.equal(res.amount, 105)
  assert.ok(Math.abs(res.divPrice - 105 * P.vaal) < 1e-9)
  assert.equal(res.rowsRanked[0].id, 'c')
  assert.equal(res.rowsRanked[1].id, 'a')

  // Lead is already cheapest -> currency: null.
  const ordered = [
    { id: 'c', amount: 105, currency: 'vaal' },
    { id: 'a', amount: 17, currency: 'chaos' },
  ]
  assert.equal(bestRelaxedCurrency(ordered, P, OPTIONS).currency, null)

  // TAU boundary: 4.9% gap -> null, 5.1% gap -> pick vaal.
  const chaosFor = (gap) => (105 * P.vaal * (1 + gap)) / P.chaos
  assert.equal(bestRelaxedCurrency([
    { id: 'a', amount: chaosFor(0.049), currency: 'chaos' },
    { id: 'b', amount: 105, currency: 'vaal' },
  ], P, OPTIONS).currency, null)
  assert.equal(bestRelaxedCurrency([
    { id: 'a', amount: chaosFor(0.051), currency: 'chaos' },
    { id: 'b', amount: 105, currency: 'vaal' },
  ], P, OPTIONS).currency, 'vaal')

  // Unfilterable currency ignored.
  const withGold = [
    { id: 'a', amount: 17, currency: 'chaos' },
    { id: 'g', amount: 1, currency: 'gold' },
    { id: 'v', amount: 105, currency: 'vaal' },
  ]
  assert.equal(bestRelaxedCurrency(withGold, { ...P, gold: 0.0001 }, OPTIONS).currency, 'vaal')

  // Missing options or prices -> safe currency: null, ranked list still returned.
  assert.equal(bestRelaxedCurrency(rows, P, null).currency, null)
  assert.equal(bestRelaxedCurrency(rows, null, OPTIONS).currency, null)
  assert.deepEqual(rankRelaxedRows([], P), [])
  assert.equal(bestRelaxedCurrency([], P, OPTIONS).currency, null)
})

// --- Real-world production EE2 query patterns (sanitized from live EE2 logs) ---

test('EE2 pattern 1 & 2 & 4: mixed and + active count (min: 1) alias groups, negative max (-30 -> -25 / -22), and trade_filters.collapse preserved', () => {
  // Derived from Ancient Commandment Ritual Tablet
  const ritualTablet = {
    status: { option: 'securable' },
    type: 'Ritual Tablet',
    stats: [
      {
        type: 'and',
        filters: [
          { id: 'pseudo.pseudo_number_of_uses_remaining', value: { min: 10 }, disabled: false },
          { id: 'explicit.stat_159726667', value: { min: 24 }, disabled: false },
          { id: 'explicit.stat_2282052746', value: { max: -30 }, disabled: false },
          { id: 'explicit.stat_off', value: { min: 50 }, disabled: true },
        ],
      },
      {
        type: 'count',
        value: { min: 1 },
        disabled: false,
        filters: [
          { id: 'explicit.stat_1276056105', value: { min: 31 }, disabled: false },
          { id: 'explicit.stat_1133965702', value: { min: 31 }, disabled: false },
          { id: 'explicit.stat_alias_off', value: { min: 99 }, disabled: true },
        ],
      },
      {
        type: 'count',
        value: { min: 1 },
        disabled: false,
        filters: [
          { id: 'explicit.stat_3917489142', value: { min: 12 }, disabled: false },
          { id: 'explicit.stat_2306002879', value: { min: 12 }, disabled: false },
        ],
      },
    ],
    filters: {
      trade_filters: { filters: { collapse: { option: 'true' }, price: { option: 'chaos' } } },
      type_filters: { filters: { rarity: { option: 'nonunique' } } },
      misc_filters: { filters: { corrupted: { option: 'false' }, mirrored: { option: 'false' } } },
    },
  }

  assert.equal(canRelax(ritualTablet), true)
  const r1 = relaxQuery(ritualTablet, 1)
  assert.deepEqual(r1.summary, { level: 1, required: 2, total: 3, keepPct: 85, canRelaxFurther: true })
  assert.equal(r1.query.stats.length, 3)

  // Main `and` group -> `count (min: 2)` with disabled filter stripped and negative max relaxed closer to 0 (-30 -> -25).
  assert.equal(r1.query.stats[0].type, 'count')
  assert.deepEqual(r1.query.stats[0].value, { min: 2 })
  assert.deepEqual(r1.query.stats[0].filters, [
    { id: 'pseudo.pseudo_number_of_uses_remaining', value: { min: 8 } },
    { id: 'explicit.stat_159726667', value: { min: 20 } },
    { id: 'explicit.stat_2282052746', value: { max: -25 } },
  ])

  // Dual-ID alias `count (min: 1)` groups stay separate with min: 1 intact, disabled stripped, and bounds relaxed 15%.
  assert.equal(r1.query.stats[1].type, 'count')
  assert.deepEqual(r1.query.stats[1].value, { min: 1 })
  assert.deepEqual(r1.query.stats[1].filters, [
    { id: 'explicit.stat_1276056105', value: { min: 26 } },
    { id: 'explicit.stat_1133965702', value: { min: 26 } },
  ])
  assert.equal(r1.query.stats[2].type, 'count')
  assert.deepEqual(r1.query.stats[2].value, { min: 1 })
  assert.deepEqual(r1.query.stats[2].filters, [
    { id: 'explicit.stat_3917489142', value: { min: 10 } },
    { id: 'explicit.stat_2306002879', value: { min: 10 } },
  ])

  // trade_filters.collapse preserved while price lock stripped; also preserved after applyRelaxedCurrency.
  assert.deepEqual(r1.query.filters.trade_filters, { filters: { collapse: { option: 'true' } } })
  const withVaal = applyRelaxedCurrency(r1.query, 'vaal')
  assert.deepEqual(withVaal.filters.trade_filters, {
    disabled: false,
    filters: { collapse: { option: 'true' }, price: { option: 'vaal' } },
  })

  // Level 2: `and` -> `count (min: 1)`, negative max -30 -> -22, alias mins relaxed 25%.
  const r2 = relaxQuery(ritualTablet, 2)
  assert.deepEqual(r2.summary, { level: 2, required: 1, total: 3, keepPct: 75, canRelaxFurther: false })
  assert.deepEqual(r2.query.stats[0].value, { min: 1 })
  assert.deepEqual(r2.query.stats[0].filters[2], { id: 'explicit.stat_2282052746', value: { max: -22 } })
  assert.deepEqual(r2.query.stats[1].value, { min: 1 })
  assert.deepEqual(r2.query.stats[1].filters[0], { id: 'explicit.stat_1276056105', value: { min: 23 } })
  assert.deepEqual(r2.query.stats[2].filters[0], { id: 'explicit.stat_3917489142', value: { min: 9 } })
})

test('EE2 pattern 3: empty {} value on enchant/anoint stats preserved cleanly without NaN or undefined', () => {
  // Derived from Carrion Clasp Absent Amulet
  const anointAmulet = {
    status: { option: 'securable' },
    stats: [
      {
        type: 'and',
        filters: [
          { id: 'enchant.stat_2954116742|20686', value: {}, disabled: false },
          { id: 'implicit.stat_3182714256', value: { min: -1 }, disabled: true },
          { id: 'skill.cast_on_elemental_ailment', value: { min: 20 }, disabled: false },
          { id: 'explicit.stat_1177404658', value: { min: 24 }, disabled: true },
        ],
      },
      {
        type: 'count',
        value: { min: 1 },
        disabled: true,
        filters: [
          { id: 'explicit.stat_2704225257', value: { min: 47 }, disabled: true },
          { id: 'explicit.stat_3981240776', value: { min: 47 }, disabled: true },
        ],
      },
    ],
    filters: {
      trade_filters: { filters: { collapse: { option: 'true' } } },
      type_filters: { filters: { category: { option: 'accessory.amulet' }, rarity: { option: 'nonunique' } } },
    },
  }

  assert.equal(canRelax(anointAmulet), true)
  const r1 = relaxQuery(anointAmulet, 1)
  assert.deepEqual(r1.summary, { level: 1, required: 1, total: 2, keepPct: 85, canRelaxFurther: false })
  assert.deepEqual(r1.query.stats[0], {
    type: 'count',
    value: { min: 1 },
    filters: [
      { id: 'enchant.stat_2954116742|20686', value: {} },
      { id: 'skill.cast_on_elemental_ailment', value: { min: 17 } },
    ],
  })
  assert.deepEqual(Object.keys(r1.query.stats[0].filters[0].value), [])
  // Disabled count group kept disabled, not merged.
  assert.equal(r1.query.stats[1].disabled, true)
})

test('EE2 pattern 5: equipment_filters defense/DPS (es, ar, ev, dps, pdps, edps) relaxed 15%/25% while rune_sockets stays untouched', () => {
  // Derived from Beast Ward Flowing Raiment + rare weapon DPS case
  const raiment = {
    status: { option: 'securable' },
    stats: [
      {
        type: 'and',
        filters: [
          { id: 'pseudo.pseudo_total_elemental_resistance', value: { min: 41 }, disabled: false },
          { id: 'pseudo.pseudo_total_cold_resistance', value: { min: 41 }, disabled: true },
          { id: 'pseudo.pseudo_total_life', value: { min: 153 }, disabled: false },
          { id: 'rune.stat_1927467683', value: { min: 1 }, disabled: true },
        ],
      },
      {
        type: 'count',
        value: { min: 1, max: 1 },
        disabled: true,
        filters: [{ id: 'pseudo.pseudo_number_of_empty_suffix_mods', value: { min: 2 }, disabled: true }],
      },
    ],
    filters: {
      trade_filters: { filters: { collapse: { option: 'true' } } },
      type_filters: { filters: { category: { option: 'armour.chest' }, rarity: { option: 'nonunique' } } },
      equipment_filters: {
        filters: {
          rune_sockets: { min: 3 },
          es: { min: 183 },
          ar: { min: 106 },
          ev: { min: 98 },
        },
      },
    },
  }

  const r1 = relaxQuery(raiment, 1)
  assert.deepEqual(r1.query.filters.equipment_filters.filters, {
    rune_sockets: { min: 3 },
    es: { min: 155 },
    ar: { min: 90 },
    ev: { min: 83 },
  })
  assert.equal(r1.query.stats[0].filters.length, 2, 'disabled filters stripped from count group')

  // 3-mod weapon with dps/pdps/edps + rune_sockets at Level 1 and Level 2.
  const weapon = {
    status: { option: 'securable' },
    stats: [{
      type: 'and',
      filters: [
        { id: 'explicit.stat_a', value: { min: 100 }, disabled: false },
        { id: 'explicit.stat_b', value: { min: 40 }, disabled: false },
        { id: 'explicit.stat_c', value: { min: 20 }, disabled: false },
      ],
    }],
    filters: {
      equipment_filters: {
        filters: {
          rune_sockets: { min: 2 },
          dps: { min: 600 },
          pdps: { min: 500 },
          edps: { min: 200 },
        },
      },
    },
  }
  const w1 = relaxQuery(weapon, 1)
  assert.deepEqual(w1.query.filters.equipment_filters.filters, {
    rune_sockets: { min: 2 },
    dps: { min: 510 },
    pdps: { min: 425 },
    edps: { min: 170 },
  })
  const w2 = relaxQuery(weapon, 2)
  assert.deepEqual(w2.query.filters.equipment_filters.filters, {
    rune_sockets: { min: 2 },
    dps: { min: 450 },
    pdps: { min: 375 },
    edps: { min: 150 },
  })
})

test('EE2 pattern 6: ineligible real items (0-stat base, 1-stat wand/ring, 1-stat + equipment defense) return false / null cleanly', () => {
  // Bandit Mace: 0 active stats, only rune_sockets
  const banditMace = {
    status: { option: 'securable' },
    type: 'Bandit Mace',
    stats: [{ type: 'and', filters: [] }],
    filters: {
      trade_filters: { filters: { collapse: { option: 'true' } } },
      type_filters: { filters: { rarity: { option: 'normal' }, ilvl: { min: 80 } } },
      equipment_filters: { filters: { rune_sockets: { min: 2 } } },
    },
  }
  assert.equal(canRelax(banditMace), false)
  assert.equal(relaxQuery(banditMace, 1), null)

  // Gloom Branch Dueling Wand: 1 active stat + rune_sockets
  const gloomWand = {
    status: { option: 'securable' },
    stats: [{
      type: 'and',
      filters: [
        { id: 'rune.stat_1963398329', value: { min: 1 }, disabled: true },
        { id: 'skill.spellslinger_invocation', value: { min: 19 }, disabled: false },
        { id: 'explicit.stat_124131830', value: { min: 4 }, disabled: true },
      ],
    }],
    filters: {
      type_filters: { filters: { category: { option: 'weapon.wand' }, rarity: { option: 'nonunique' } } },
      equipment_filters: { filters: { rune_sockets: { min: 2 } } },
    },
  }
  assert.equal(canRelax(gloomWand), false)
  assert.equal(relaxQuery(gloomWand, 1), null)

  // Rift Knuckle Gold Ring: 1 active stat + disabled count group
  const riftRing = {
    status: { option: 'securable' },
    stats: [
      {
        type: 'and',
        filters: [
          { id: 'pseudo.pseudo_total_elemental_resistance', value: { min: 61 }, disabled: false },
          { id: 'pseudo.pseudo_total_fire_resistance', value: { min: 32 }, disabled: true },
        ],
      },
      {
        type: 'count',
        value: { min: 1 },
        disabled: true,
        filters: [
          { id: 'explicit.stat_3917489142', value: { min: 16 }, disabled: true },
          { id: 'explicit.stat_2306002879', value: { min: 16 }, disabled: true },
        ],
      },
    ],
  }
  assert.equal(canRelax(riftRing), false)
  assert.equal(relaxQuery(riftRing, 1), null)

  // 1 active stat + defense equipment filter: stays ineligible (< 2 active stat filters) and never throws
  const oneStatWithEs = {
    status: { option: 'securable' },
    stats: [{ type: 'and', filters: [{ id: 'pseudo.pseudo_total_life', value: { min: 100 }, disabled: false }] }],
    filters: { equipment_filters: { filters: { es: { min: 350 } } } },
  }
  assert.equal(canRelax(oneStatWithEs), false)
  assert.equal(relaxQuery(oneStatWithEs, 1), null)

  // Small negative max (-1) stays -1 (never -0)
  const tinyNeg = {
    stats: [{
      type: 'and',
      filters: [
        { id: 's1', value: { max: -1 }, disabled: false },
        { id: 's2', value: { min: 10 }, disabled: false },
      ],
    }],
  }
  const rNeg = relaxQuery(tinyNeg, 1)
  assert.equal(Object.is(rNeg.query.stats[0].filters[0].value.max, -1), true)
})

