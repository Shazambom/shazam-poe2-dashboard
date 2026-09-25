// Trading → Mods → "Search on trade": a family row becomes a Workspace search for items of the
// pool's kind carrying that mod. The desktop resolves the stat ids and category (EE2's data,
// desktop/src/trade/modsearch.js); this builds the query in the Regex tab's frame.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { familyQuery } from '../src/lib/mods/trade.js'

const LIFE = { id: 'prefix:IncreasedLife', text: '+# to maximum Life', tags: ['life'], tiers: [] }
const POOL = { id: 'ring', name: 'Rings', keywords: ['Gold Ring'] }

test('one count group per line of the mod, at least one of its ids, on the kind, instant buyout, cheapest first', () => {
  const q = familyQuery(LIFE, POOL, { stats: [['explicit.stat_3299347043', 'desecrated.stat_3299347043']], category: 'accessory.ring' })
  assert.deepEqual(q.query, {
    query: {
      status: { option: 'securable' },
      filters: { type_filters: { disabled: false, filters: { category: { option: 'accessory.ring' } } } },
      stats: [{ type: 'count', filters: [{ id: 'explicit.stat_3299347043' }, { id: 'desecrated.stat_3299347043' }], value: { min: 1 } }],
    },
    sort: { price: 'asc' },
  })
  assert.equal(q.name, '+# to maximum Life · Rings')
})

test('a hybrid mod is two groups: the item carries both lines', () => {
  const fam = { ...LIFE, text: '#% increased Evasion Rating\n+# to maximum Life' }
  const q = familyQuery(fam, POOL, { stats: [['explicit.stat_1'], ['explicit.stat_2']], category: 'accessory.ring' })
  assert.deepEqual(q.query.query.stats.map(g => g.filters.map(f => f.id)), [['explicit.stat_1'], ['explicit.stat_2']])
  assert.equal(q.name, '#% increased Evasion Rating / +# to maximum Life · Rings')
})

test('no category known: the stat alone, on anything', () => {
  const q = familyQuery(LIFE, { id: 'claw', name: 'Claws', keywords: [] }, { stats: [['explicit.stat_3299347043']], category: null })
  assert.deepEqual(q.query.query.filters.type_filters, { disabled: false, filters: {} })
})

test('a mod the site does not list is no search', () => {
  assert.equal(familyQuery(LIFE, POOL, { stats: null, category: 'accessory.ring' }), null)
  assert.equal(familyQuery(LIFE, POOL, null), null)
})
