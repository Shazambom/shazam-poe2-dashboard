// frontend/src/lib/merchant.js: pure valuation, actionable verdicts, currency alerts,
// 249-char batch regexes, waterfall cut ladder, search/sort, and inline floor summary.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  STALE_DAYS,
  STALE_MS,
  BLEED_PCT,
  DUST_CHAOS,
  HARD_CURRENCIES,
  MAX_REGEX_LEN,
  enrichMerchantRows,
  indexWorkspaceSearches,
  matchRecentSale,
  merchantSummary,
  merchantCurrencyAlerts,
  merchantHighlightRegex,
  merchantBatchRegexes,
  merchantWaterfallSteps,
  filterMerchantRows,
  compareMerchantPrices,
  sortMerchantRows,
  merchantFloorQueryObj,
  merchantFloorQuery,
  summarizeFloorCheck,
} from '../src/lib/merchant.js'
import { makeExchange } from '../src/lib/price.js'

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const NOW = Date.parse('2026-11-22T12:00:00Z')
const isoAgo = (ms) => new Date(NOW - ms).toISOString()

test('constants match contract', () => {
  assert.equal(STALE_DAYS, 3)
  assert.equal(STALE_MS, 3 * DAY)
  assert.equal(BLEED_PCT, 0.15)
  assert.equal(DUST_CHAOS, 2)
  assert.equal(MAX_REGEX_LEN, 249)
  assert.deepEqual([...HARD_CURRENCIES].sort(), ['divine', 'hinekoras-lock', 'mirror'])
})

test('enrichMerchantRows assigns single actionable verdict (vendor | reprice | cut | fresh) and vendorVerb', () => {
  const prices = { divine: 1, exalted: 0.01, chaos: 0.05, mirror: 500 }
  const tNowSec = Math.floor(NOW / 1000)
  // Exalted inflated 100 -> 125 per Divine = 20% drop (>= 15% reprice).
  // Chaos moved 100 -> 105 per Divine = ~4.76% (< 15%).
  const inflation = {
    anchor: 'divine',
    currencies: [
      { id: 'exalted', points: [{ t: tNowSec - 10 * 86400, v: 100 }, { t: tNowSec, v: 125 }], current: 125 },
      { id: 'chaos', points: [{ t: tNowSec - 10 * 86400, v: 100 }, { t: tNowSec, v: 105 }], current: 105 },
    ],
  }
  const rows = [
    // Reprice: 200 ex (2 div, above 2c dust) listed 10d ago -> bled 20%
    { id: '1', indexed: isoAgo(10 * DAY), amount: 200, currency: 'exalted', name: 'Old Exalted Ring', typeLine: 'Gold Ring', baseType: 'Gold Ring', rarity: 'Rare' },
    // Cut: 40 chaos (2 div, above 2c dust) listed 4d ago -> stale >= 3d, not bled
    { id: '2', indexed: isoAgo(4 * DAY), amount: 40, currency: 'chaos', name: 'Stale Amulet', typeLine: 'Amulet', baseType: 'Amulet', rarity: 'Rare' },
    // Vendor (Rare): 1 chaos (<= 2c dust) listed 4d ago -> vendor ('Vendor')
    { id: '3', indexed: isoAgo(4 * DAY), amount: 1, currency: 'chaos', name: 'Dust Rare', typeLine: 'Boots', baseType: 'Boots', rarity: 'Rare' },
    // Vendor (Unique): 2 exalted (0.02 div <= 0.10 div dust) listed 10d ago -> vendor ('Disenchant') even though exalted bled
    { id: '4', indexed: isoAgo(10 * DAY), amount: 2, currency: 'exalted', name: 'Dust Unique', typeLine: 'Belt', baseType: 'Belt', rarity: 'Unique' },
    // Fresh: 3 div listed 1d ago (< 3d)
    { id: '5', indexed: isoAgo(1 * DAY), amount: 3, currency: 'divine', name: 'Fresh Divine', typeLine: 'Heavy Belt', baseType: 'Heavy Belt', rarity: 'Unique' },
    // Unpriced currency (divValue == null) listed 5d ago -> NEVER vendor dust, gets 'cut'
    { id: '6', indexed: isoAgo(5 * DAY), amount: 1, currency: 'mystery-orb', name: 'Mystery Item', typeLine: 'Wand', baseType: 'Wand', rarity: 'Magic' },
  ]

  const out = enrichMerchantRows(rows, { prices, inflation, now: NOW })
  assert.equal(out[0].verdict, 'reprice')
  assert.equal(out[0].canInlinePriceCheck, false)
  assert.equal(out[1].verdict, 'cut')
  assert.equal(out[2].verdict, 'vendor')
  assert.equal(out[2].vendorVerb, 'Vendor')
  assert.equal(out[3].verdict, 'vendor')
  assert.equal(out[3].vendorVerb, 'Disenchant')
  assert.equal(out[3].canInlinePriceCheck, true)
  assert.equal(out[4].verdict, 'fresh')
  assert.equal(out[5].divValue, null)
  assert.equal(out[5].verdict, 'cut', 'unpriced items must never be classified as vendor dust')

  const sum = merchantSummary(out)
  assert.ok(Math.abs(sum.totalDiv - 7.07) < 1e-9)
  assert.deepEqual({ ...sum, totalDiv: 7.07 }, {
    count: 6,
    totalDiv: 7.07,
    actionableCount: 5,
    repriceCount: 1,
    cutCount: 2,
    vendorCount: 2,
    freshCount: 1,
  })

  const alerts = merchantCurrencyAlerts(out)
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].currency, 'exalted')
  assert.equal(alerts[0].count, 2)
  assert.ok(Math.abs(alerts[0].maxBleedPct - 0.2) < 1e-6)
})

test('enrichMerchantRows marks bleedCapped and bleedWindowDays when listing predates inflation window', () => {
  const tNowSec = Math.floor(NOW / 1000)
  const infl14d = {
    anchor: 'divine',
    currencies: [
      { id: 'chaos', points: [{ t: tNowSec - 14 * 86400, v: 100 }, { t: tNowSec, v: 125 }], current: 125 },
    ],
  }
  const rows = [
    { id: 'old64', indexed: isoAgo(64 * DAY), amount: 50, currency: 'chaos', name: 'Old Chaos Ring' },
    { id: 'in5', indexed: isoAgo(5 * DAY), amount: 50, currency: 'chaos', name: 'Recent Chaos Ring' },
  ]
  const out = enrichMerchantRows(rows, { prices: { divine: 1, chaos: 0.05 }, inflation: infl14d, now: NOW })
  assert.equal(out[0].bleedCapped, true)
  assert.equal(out[0].bleedWindowDays, 14)
  assert.equal(out[1].bleedCapped, false)
  assert.equal(out[1].bleedWindowDays, null)
})

test('merchantHighlightRegex builds PoE 2-safe ^escaped$ string, quotes whitespace, sanitizes quotes, and caps under 250 chars', () => {
  assert.equal(merchantHighlightRegex({ name: 'Headhunter', typeLine: 'Heavy Belt' }), '^Headhunter$')
  assert.equal(merchantHighlightRegex({ name: '', typeLine: 'Waystone (Tier 16)' }), '"^Waystone \\(Tier 16\\)$"')
  assert.equal(merchantHighlightRegex({ name: 'The "Best" Belt' }), '"^The .Best. Belt$"')
  assert.equal(merchantHighlightRegex({}), '')
  const re = merchantHighlightRegex({ name: '(Item)+ '.repeat(50) })
  assert.ok(re.length <= MAX_REGEX_LEN)
  assert.ok(re.startsWith('"') && re.endsWith('"'))
  assert.doesNotThrow(() => new RegExp(re.slice(1, -1)))
})

test('merchantBatchRegexes deduplicates names, quotes whitespace chunks as single PoE 2 tokens, and caps under 250 chars', () => {
  const noSpaces = merchantBatchRegexes([{ name: 'Headhunter' }, { name: 'headhunter' }, { name: 'Svalinn' }])
  assert.equal(noSpaces.length, 1)
  assert.equal(noSpaces[0].regex, '^(Headhunter|Svalinn)$')

  const dupes = [
    { name: 'Headhunter' },
    { name: 'headhunter' },
    { name: 'Svalinn' },
    { name: '', typeLine: 'Waystone (Tier 16)' },
  ]
  const one = merchantBatchRegexes(dupes)
  assert.equal(one.length, 1)
  assert.equal(one[0].count, 3)
  assert.equal(one[0].regex, '"^(Headhunter|Svalinn|Waystone \\(Tier 16\\))$"')
  assert.doesNotThrow(() => new RegExp(one[0].regex.slice(1, -1)))

  // Many long names split into valid single-token PoE 2 chunks each <= 249 chars
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `Vengeance Band Ring Number ${i + 1}` }))
  const parts = merchantBatchRegexes(many)
  assert.ok(parts.length >= 2)
  let totalCount = 0
  for (const p of parts) {
    assert.ok(p.regex.length <= MAX_REGEX_LEN, `chunk len ${p.regex.length} > ${MAX_REGEX_LEN}`)
    const tokens = [...p.regex.matchAll(/"([^"]*)"|(\S+)/g)]
    assert.equal(tokens.length, 1, `expected single PoE 2 search token, got ${tokens.length}: ${p.regex}`)
    const inner = tokens[0][1] ?? tokens[0][2]
    assert.doesNotThrow(() => new RegExp(inner))
    totalCount += p.count
  }
  assert.equal(totalCount, 20)
})

test('merchantWaterfallSteps returns clean PoE 2 rounded cut steps', () => {
  assert.deepEqual(merchantWaterfallSteps({ amount: 100, currency: 'exalted' }), [
    { label: '−15%', amount: 85, currency: 'exalted' },
    { label: '−30%', amount: 70, currency: 'exalted' },
    { label: '−50%', amount: 50, currency: 'exalted' },
  ])
  assert.deepEqual(merchantWaterfallSteps({ amount: 2, currency: 'divine' }), [
    { label: '−15%', amount: 1.7, currency: 'divine' },
    { label: '−30%', amount: 1.4, currency: 'divine' },
    { label: '−50%', amount: 1, currency: 'divine' },
  ])
  assert.deepEqual(merchantWaterfallSteps({ amount: 0, currency: 'divine' }), [])
})

test('filterMerchantRows and sortMerchantRows filter by verdict/search/done and sort cleanly', () => {
  const rows = enrichMerchantRows([
    { id: '1', indexed: isoAgo(5 * DAY), amount: 10, currency: 'divine', name: 'Svalinn', typeLine: 'Tower Shield', rarity: 'Unique', stashName: 'Ange' },
    { id: '2', indexed: isoAgo(1 * DAY), amount: 50, currency: 'divine', name: 'Headhunter', typeLine: 'Heavy Belt', rarity: 'Unique', stashName: 'High' },
    { id: '3', indexed: isoAgo(6 * DAY), amount: 1, currency: 'chaos', name: 'Junk Ring', typeLine: 'Gold Ring', rarity: 'Rare', stashName: 'Dump' },
  ], { prices: { divine: 1, chaos: 0.05 }, now: NOW })

  // Default verdict sort puts cut (Svalinn) -> vendor (Junk) -> fresh (Headhunter)
  const byVerdict = sortMerchantRows(rows, { key: 'verdict', dir: 'asc' })
  assert.deepEqual(byVerdict.map(r => r.id), ['1', '3', '2'])

  // Price desc puts Headhunter (50d) -> Svalinn (10d) -> Junk (0.05d)
  const byPrice = sortMerchantRows(rows, { key: 'price', dir: 'desc' })
  assert.deepEqual(byPrice.map(r => r.id), ['2', '1', '3'])

  // Search matches by stash tab or base type via shared search.js
  assert.deepEqual(filterMerchantRows(rows, { search: 'dump' }).map(r => r.id), ['3'])
  assert.deepEqual(filterMerchantRows(rows, { search: 'shield' }).map(r => r.id), ['1'])

  // Hide done
  assert.deepEqual(filterMerchantRows(rows, { hideDone: true, doneIds: new Set(['1']) }).map(r => r.id), ['2', '3'])
})

test('merchantFloorQueryObj, merchantFloorQuery, and summarizeFloorCheck work cleanly (including wealthPrices fallback)', () => {
  const obj = merchantFloorQueryObj({ name: 'Headhunter', typeLine: 'Heavy Belt', baseType: 'Heavy Belt', rarity: 'Unique' })
  assert.equal(merchantFloorQuery({ name: 'Headhunter', typeLine: 'Heavy Belt', baseType: 'Heavy Belt', rarity: 'Unique' }), JSON.stringify(obj))
  assert.deepEqual(obj, {
    query: {
      status: { option: 'securable' },
      name: 'Headhunter',
      type: 'Heavy Belt',
      filters: { type_filters: { disabled: false, filters: { rarity: { option: 'unique' } } } },
    },
    sort: { price: 'asc' },
  })

  const floor = summarizeFloorCheck(
    { ok: true, total: 18, listings: [{ amount: 40, currency: 'divine' }, { amount: 45, currency: 'divine' }] },
    { divValue: 50 },
    { divine: 1, exalted: 0.01 },
  )
  assert.equal(floor.total, 18)
  assert.equal(floor.cheapest.amount, 40)
  assert.equal(floor.floorDiv, 40)
  assert.ok(Math.abs(floor.pctAbove - 0.25) < 1e-6)

  const fallbackFloor = summarizeFloorCheck(
    { ok: true, total: 4, listings: [{ amount: 200, currency: 'chaos' }] },
    { divValue: 15 },
    {},
    { divine: 100, chaos: 5 },
  )
  assert.equal(fallbackFloor.floorDiv, 10)
  assert.ok(Math.abs(fallbackFloor.pctAbove - 0.5) < 1e-6)
})

test('sortMerchantRows sorts in pairs by relative currency value using injected exchange function', () => {
  // 1 divine = 12 chaos = 120 exalted (1 chaos = 10 exalted)
  const rates = { exalted: 1, chaos: 10, divine: 120 }
  const calls = []
  const baseExchange = makeExchange(rates)
  const spyExchange = (amount, from, to) => {
    calls.push([amount, from, to])
    return baseExchange(amount, from, to)
  }

  // Same currency compares directly without calling exchange
  assert.ok(compareMerchantPrices({ amount: 25, currency: 'divine' }, { amount: 15, currency: 'divine' }, spyExchange) > 0)
  assert.equal(calls.length, 0)

  // Different currencies convert one into the other via injected exchange
  assert.ok(compareMerchantPrices({ amount: 25, currency: 'divine' }, { amount: 250, currency: 'exalted' }, spyExchange) > 0)
  assert.ok(compareMerchantPrices({ amount: 100, currency: 'chaos' }, { amount: 250, currency: 'exalted' }, spyExchange) > 0)
  assert.ok(compareMerchantPrices({ amount: 1, currency: 'chaos' }, { amount: 5, currency: 'exalted' }, spyExchange) > 0)
  assert.ok(calls.length >= 3)

  // Raw listings WITHOUT precomputed divValue: must sort by real worth, never raw currency counts.
  const mixed = [
    { id: 'ex250', amount: 250, currency: 'exalted', verdict: 'reprice' },   // 250 ex (2.08 div)
    { id: 'ch100', amount: 100, currency: 'chaos', verdict: 'reprice' },     // 1000 ex (8.33 div)
    { id: 'div25', amount: 25, currency: 'divine', verdict: 'cut' },         // 3000 ex (25 div)
    { id: 'div15', amount: 15, currency: 'divine', verdict: 'cut' },         // 1800 ex (15 div)
    { id: 'ch1', amount: 1, currency: 'chaos', verdict: 'vendor' },          // 10 ex (0.083 div)
    { id: 'ex5', amount: 5, currency: 'exalted', verdict: 'vendor' },        // 5 ex (0.042 div)
    { id: 'div12', amount: 12, currency: 'divine', verdict: 'fresh' },       // 1440 ex (12 div)
    { id: 'div4', amount: 4, currency: 'divine', verdict: 'fresh' },         // 480 ex (4 div)
    { id: 'unk9999', amount: 9999, currency: 'mystery-orb', verdict: 'cut' }, // unpriced: must never beat priced items
    { id: 'unk50', amount: 50, currency: 'mystery-orb', verdict: 'cut' },
  ]

  const desc = sortMerchantRows(mixed, { key: 'price', dir: 'desc', exchange: baseExchange })
  assert.deepEqual(
    desc.map(r => r.id),
    ['div25', 'div15', 'div12', 'ch100', 'div4', 'ex250', 'ch1', 'ex5', 'unk9999', 'unk50'],
  )

  const asc = sortMerchantRows(mixed, { key: 'price', dir: 'asc', exchange: baseExchange })
  assert.deepEqual(
    asc.map(r => r.id),
    ['ex5', 'ch1', 'ex250', 'div4', 'ch100', 'div12', 'div15', 'div25', 'unk50', 'unk9999'],
  )

  // Verdict sort also uses injected exchange to tie-break within each verdict bucket.
  const byVerdict = sortMerchantRows(mixed, { key: 'verdict', dir: 'asc', exchange: baseExchange })
  assert.deepEqual(
    byVerdict.map(r => r.id),
    ['ch100', 'ex250', 'div25', 'div15', 'unk9999', 'unk50', 'ch1', 'ex5', 'div12', 'div4'],
  )
})

test('indexWorkspaceSearches, mod-filtered Rare queries, uniqueQuery, cheaperCurrency, and matchRecentSale integrate cleanly', () => {
  const tree = [
    {
      id: 'folder-hist',
      kind: 'folder',
      name: 'ExiledExchange2 History',
      children: [
        {
          id: 'ws-ring',
          kind: 'search',
          name: 'Bramble Finger',
          q: JSON.stringify({
            query: {
              filters: { type_filters: { disabled: false, filters: { category: { option: 'accessory.ring' } } } },
              stats: [{ type: 'and', filters: [{ id: 'explicit.stat_3299347043', value: { min: 60 } }] }],
            },
          }),
        },
        {
          id: 'ws-generic-base',
          kind: 'search',
          name: 'Gold Ring',
          q: JSON.stringify({ query: { type: 'Gold Ring' } }),
        },
      ],
    },
  ]
  const wsIdx = indexWorkspaceSearches(tree)

  const rows = [
    // Matches EE2 History entry by rare name -> reuses exact saved query + workspaceId
    { id: 'r1', indexed: isoAgo(DAY), amount: 3, currency: 'divine', name: 'Bramble Finger', typeLine: 'Gold Ring', rarity: 'Rare' },
    // Named rare with matchedMods (no workspace match — must NOT match generic "Gold Ring") -> mod-filtered query
    {
      id: 'r2',
      indexed: isoAgo(DAY),
      amount: 2,
      currency: 'divine',
      name: 'Storm Coil',
      typeLine: 'Gold Ring',
      rarity: 'Rare',
      matchedMods: {
        category: 'accessory.ring',
        mods: [
          { ids: ['explicit.stat_3299347043'], value: 80 },
          { ids: ['explicit.stat_1', 'explicit.stat_2'], value: 30 },
        ],
      },
    },
    // Unidentified Unique reuses shared uniqueQuery from regex/trade.js
    {
      id: 'u1',
      indexed: isoAgo(DAY),
      amount: 10,
      currency: 'divine',
      name: 'Headhunter',
      typeLine: 'Heavy Belt',
      baseType: 'Heavy Belt',
      rarity: 'Unique',
      item: { identified: false },
    },
  ]

  const enriched = enrichMerchantRows(rows, { prices: { divine: 1, exalted: 0.01, chaos: 0.05 }, now: NOW, workspaceIndex: wsIdx })
  assert.equal(enriched[0].canInlinePriceCheck, true)
  assert.equal(enriched[0].workspaceId, 'ws-ring')
  assert.equal(enriched[0].querySource, 'workspace')
  assert.equal(enriched[0].floorQueryObj.query.stats[0].filters[0].id, 'explicit.stat_3299347043')

  assert.equal(enriched[1].canInlinePriceCheck, true)
  assert.equal(enriched[1].workspaceId, null, 'named rare must not collide with generic base search')
  assert.equal(enriched[1].querySource, 'mods')
  assert.equal(enriched[1].floorQueryObj.query.filters.type_filters.filters.category.option, 'accessory.ring')
  assert.equal(enriched[1].floorQueryObj.query.stats.length, 2)
  assert.equal(enriched[1].floorQueryObj.query.stats[0].filters[0].value.min, 64)
  assert.equal(enriched[1].floorQueryObj.query.stats[1].type, 'count')

  assert.equal(enriched[2].floorQueryObj.query.filters.misc_filters.filters.identified.option, 'false')

  // summarizeFloorCheck detects cheaperCurrency when GGG rank 0 (200 ex = 2 div) is beaten by chaos (20 c = 1 div)
  const floor = summarizeFloorCheck(
    {
      ok: true,
      total: 40,
      relaxed: true,
      relaxSummary: 'Dropped 1 mod, -15% rolls',
      listings: [
        { amount: 200, currency: 'exalted' },
        { amount: 20, currency: 'chaos' },
      ],
    },
    { amount: 3, currency: 'divine', divValue: 3 },
    { divine: 1, exalted: 0.01, chaos: 0.05 },
  )
  assert.equal(floor.cheapest.currency, 'chaos')
  assert.equal(floor.cheapest.amount, 20)
  assert.equal(floor.cheaperCurrency.currency, 'chaos')
  assert.equal(floor.cheaperCurrency.vs, 'exalted')
  assert.ok(Math.abs(floor.cheaperCurrency.gap - 1) < 1e-6)
  assert.equal(floor.relaxed, true)
  assert.equal(floor.relaxSummary, 'Dropped 1 mod, -15% rolls')

  // matchRecentSale matches newest local sale for Unique and Rare
  const sales = [
    { time: '2026-11-18T10:00:00Z', price: { amount: 45, currency: 'divine' }, item: { name: 'Headhunter', typeLine: 'Heavy Belt' } },
    { time: '2026-11-21T10:00:00Z', price: { amount: 52, currency: 'divine' }, item: { name: 'Headhunter', typeLine: 'Heavy Belt' } },
    { time: '2026-11-20T10:00:00Z', price: { amount: 3, currency: 'divine' }, item: { name: 'Bramble Finger', typeLine: 'Gold Ring' } },
  ]
  const hhSale = matchRecentSale({ name: 'Headhunter', typeLine: 'Heavy Belt', rarity: 'unique' }, sales)
  assert.equal(hhSale.amount, 52)
  assert.equal(hhSale.currency, 'divine')
  const rareSale = matchRecentSale({ name: 'Bramble Finger', typeLine: 'Gold Ring', rarity: 'rare' }, sales)
  assert.equal(rareSale.amount, 3)
  assert.equal(matchRecentSale({ name: 'Other Ring', typeLine: 'Gold Ring', rarity: 'rare' }, sales), null)
})
