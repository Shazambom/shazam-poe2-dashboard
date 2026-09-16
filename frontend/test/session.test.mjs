// Pins the trade-URL parser/builder in frontend/src/lib/session.js.
// Run:  node --test frontend/test/
import test from 'node:test'
import assert from 'node:assert/strict'

globalThis.window = undefined   // session.js guards every window access
const { parseTradeUrl, tradeUrl, tradeHome } = await import('../src/lib/session.js')

test('parseTradeUrl handles the poe2 realm segment', () => {
  assert.deepEqual(parseTradeUrl('https://www.pathofexile.com/trade2/search/poe2/Standard/abc123'),
    { type: 'search', slug: 'abc123', live: false })
  assert.deepEqual(parseTradeUrl('https://www.pathofexile.com/trade2/search/poe2/Rise%20of%20the%20Abyssal/xyz/live'),
    { type: 'search', slug: 'xyz', live: true })
})

test('parseTradeUrl handles the older realm-less shape and exchange type', () => {
  assert.deepEqual(parseTradeUrl('https://www.pathofexile.com/trade2/exchange/Standard/q1w2e3'),
    { type: 'exchange', slug: 'q1w2e3', live: false })
  assert.deepEqual(parseTradeUrl('/trade2/search/Standard/slug?x=1'), { type: 'search', slug: 'slug', live: false })
})

test('parseTradeUrl rejects non-trade urls', () => {
  assert.equal(parseTradeUrl('https://example.com/'), null)
  assert.equal(parseTradeUrl(''), null)
})

test('tradeUrl round-trips through parseTradeUrl and injects the league', () => {
  const u = tradeUrl({ type: 'search', slug: 'abc' }, 'My League', true)
  assert.equal(u, 'https://www.pathofexile.com/trade2/search/poe2/My%20League/abc/live')
  assert.deepEqual(parseTradeUrl(u), { type: 'search', slug: 'abc', live: true })
  assert.equal(tradeHome('Standard'), 'https://www.pathofexile.com/trade2/search/poe2/Standard')
  assert.equal(tradeHome(), 'https://www.pathofexile.com/trade2/search/poe2/Standard')
})
