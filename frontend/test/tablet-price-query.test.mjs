// A tablet's price search must only ever see full tablets (owner, 2026-10-01: "its very important so
// people don't get scammed … it should require the tablets to have 10 uses (some unique tablets have
// different amount of uses like the ritual unique tablets max out at 5 and unique iradiated tablets only
// have 1)"; corrupted tablets excluded). Whatever search the user linked, the calculator prices it with
// the uses filter set to that tablet's full uses — the same rule the Regex tab's tablet searches use.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const T = await import('../src/lib/regex/trade.js')

const USES = 'pseudo.pseudo_number_of_uses_remaining'
const linked = () => ({
  query: {
    status: { option: 'online' },
    type: 'Breach Tablet',
    stats: [
      { type: 'and', filters: [{ id: 'explicit.stat_1', value: { min: 20 } }, { id: USES, value: { min: 3 } }] },
      { type: 'count', filters: [{ id: 'explicit.stat_2' }], value: { min: 1 } },
    ],
    filters: { misc_filters: { filters: { corrupted: { option: 'true' }, ilvl: { min: 80 } } }, trade_filters: { filters: { price: { max: 5 } } } },
  },
  sort: { 'stat.explicit.stat_1': 'desc' },
})

test('the uses filter becomes the full uses, whatever the link asked for; the user\'s other filters stay', () => {
  const q = T.fullTabletQuery(linked(), 10)
  const all = q.query.stats.flatMap(g => g.filters)
  assert.deepEqual(all.filter(f => f.id === USES), [{ id: USES, value: { min: 10 } }], 'one uses filter: at least the full uses')
  assert.ok(all.some(f => f.id === 'explicit.stat_1' && f.value.min === 20), 'the mods the user picked stay')
  assert.deepEqual(q.query.stats[1], linked().query.stats[1], 'other groups untouched')
  assert.equal(q.query.type, 'Breach Tablet')
  assert.deepEqual(q.query.filters.misc_filters.filters.ilvl, { min: 80 })
  assert.deepEqual(q.query.filters.trade_filters, linked().query.filters.trade_filters)
})

test('a unique tablet is held to its own full uses (Freedom of Faith 5, Mastered Domain 1)', () => {
  for (const n of [5, 1]) {
    const q = T.fullTabletQuery({ query: { name: 'X', type: 'Ritual Tablet' } }, n)
    assert.deepEqual(q.query.stats.flatMap(g => g.filters).filter(f => f.id === USES), [{ id: USES, value: { min: n } }])
  }
})

test('priced as a buyer pays: Instant Buyout, uncorrupted, cheapest first', () => {
  const q = T.fullTabletQuery(linked(), 10)
  assert.deepEqual(q.query.status, T.INSTANT_BUYOUT)
  assert.deepEqual(q.query.filters.misc_filters.filters.corrupted, { option: 'false' }, 'a corrupted tablet is never the price')
  assert.deepEqual(q.sort, { price: 'asc' })
})

test('the link is never changed in place; nothing usable gives null', () => {
  const src = linked()
  T.fullTabletQuery(src, 10)
  assert.deepEqual(src, linked())
  assert.equal(T.fullTabletQuery(null, 10), null)
  assert.equal(T.fullTabletQuery({ sort: {} }, 10), null)
  assert.equal(T.fullTabletQuery(linked(), 0), null, 'no full uses known: no search')
  assert.equal(T.fullTabletQuery(linked(), null), null)
})

test('the Regex tab\'s tablet search uses the same uses rule', () => {
  const g = T.tabletQuery({ type: {}, rarity: {}, want: [], wantMode: 'and', price: {} }, { kinds: [], mods: [] })
  assert.deepEqual(g.query.stats.flatMap(x => x.filters).filter(f => f.id === USES), [{ id: USES, value: { min: 10 } }])
  const src = readFileSync(new URL('../src/lib/regex/trade.js', import.meta.url), 'utf8')
  assert.ok(/export function tabletQuery[\s\S]*?withFullUses\(/.test(src), 'one rule, not two copies of the filter')
})

// ---------------------------------------------------------------- waystones (owner, 2026-10-01: "what
// about maps, those are also searchable"). No uses on a waystone, and a corrupted one is ordinary stock:
// the user's filters as they are, priced as a buyer pays.
test('a linked waystone search keeps the user\'s filters; priced Instant Buyout, cheapest first', () => {
  const src = { query: { status: { option: 'online' }, filters: { type_filters: { filters: { category: { option: 'map.waystone' } } }, map_filters: { filters: { map_tier: { min: 15 } } }, misc_filters: { filters: { corrupted: { option: 'true' } } } } }, sort: { 'stat.x': 'desc' } }
  const before = JSON.stringify(src)
  const q = T.waystonePriceQuery(src)
  assert.deepEqual(q.query.status, T.INSTANT_BUYOUT)
  assert.deepEqual(q.sort, { price: 'asc' })
  assert.deepEqual(q.query.filters, src.query.filters, 'tier, corruption, everything the user picked')
  assert.equal(JSON.stringify(src), before, 'the link is never changed in place')
  assert.equal(T.waystonePriceQuery(null), null)
  assert.equal(T.waystonePriceQuery({ sort: {} }), null)
})

// ---------------------------------------------------------------- a unique's price floor (owner, 2026-10-01:
// "for unique items … always searching as unidentified is a good baseline"; "Voices are corrupted by default,
// remove the corrupted req"). Built here beside the tablet and waystone searches; one pricer runs them all.
test('a unique\'s search: by name and base, Instant Buyout, unidentified, cheapest first, nothing else', () => {
  assert.deepEqual(T.uniqueQuery('Mageblood', 'Utility Belt'), {
    query: { status: T.INSTANT_BUYOUT, name: 'Mageblood', type: 'Utility Belt', filters: { misc_filters: { filters: { identified: { option: 'false' } } } } },
    sort: { price: 'asc' },
  })
})
