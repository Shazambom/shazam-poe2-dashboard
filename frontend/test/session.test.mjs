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
})

test('a new trade tab always opens on Instant Buyout (owner, 2026-10-01: "no matter what")', async () => {
  const { parseTradeQueryUrl } = await import('../src/lib/session.js')
  for (const [lg, path] of [['Standard', 'Standard'], [undefined, 'Standard'], ['Forbidden Rites', 'Forbidden%20Rites']]) {
    const u = tradeHome(lg)
    assert.ok(u.startsWith(`https://www.pathofexile.com/trade2/search/poe2/${path}?q=`), u)
    assert.deepEqual(JSON.parse(parseTradeQueryUrl(u).q), { query: { status: { option: 'securable' } } })
    assert.equal(parseTradeUrl(u), null, 'a fresh tab is not a saved search: nothing is captured from it')
  }
})

// ---- Batch 1: pathname-only parsing, ?q= links, queryUrl ----
const { parseTradeQueryUrl, queryUrl } = await import('../src/lib/session.js')
const Q = JSON.stringify({ query: { status: { option: 'securable' }, name: 'Headhunter', type: 'Heavy Belt', stats: [{ type: 'and', filters: [] }], filters: {} }, sort: { price: 'asc' } })

test('parseTradeUrl looks at the pathname only — a ?q= link is not a slug', () => {
  const u = `https://www.pathofexile.com/trade2/search/poe2/Forbidden%20Rites?q=${encodeURIComponent(Q)}`
  assert.equal(parseTradeUrl(u), null)
  assert.equal(parseTradeUrl('https://www.pathofexile.com/trade2/search/poe2/Standard?q={"a":"x/y/z"}'), null, 'garbage-slug case')
  assert.deepEqual(parseTradeUrl('https://www.pathofexile.com/trade2/search/poe2/Standard/abc123?x=1#f'), { type: 'search', slug: 'abc123', live: false })
  assert.equal(parseTradeUrl('https://www.pathofexile.com/trade2/search/poe2/Standard'), null, 'a bare league page has no slug')
})

test('parseTradeQueryUrl returns the exact q string and drops the league', () => {
  const u = queryUrl({ q: Q }, 'Forbidden Rites')
  assert.equal(u, `https://www.pathofexile.com/trade2/search/poe2/Forbidden%20Rites?q=${encodeURIComponent(Q)}`)
  assert.deepEqual(parseTradeQueryUrl(u), { q: Q })
  // EE2 interpolates q raw; the site decodes both spellings to the same bytes
  assert.equal(decodeURIComponent(new URL(u).search.slice(3)), Q)
  assert.deepEqual(parseTradeQueryUrl(`https://www.pathofexile.com/trade2/search/poe2/Standard?q=${Q}`), { q: Q })
  assert.equal(parseTradeQueryUrl('https://www.pathofexile.com/trade2/search/poe2/Standard?q=not-json'), null)
  assert.equal(parseTradeQueryUrl('https://www.pathofexile.com/trade2/search/poe2/Standard/abc'), null)
  assert.equal(parseTradeQueryUrl('https://www.pathofexile.com/trade2/exchange/poe2/Standard?q=' + Q), null, 'exchange links are not searches')
})

test('Instant Buyout is defined once; a tab opened from a ?q= URL already has it, so only saved searches get the dropdown click', async () => {
  const { readFileSync } = await import('node:fs')
  const session = readFileSync(new URL('../src/lib/session.js', import.meta.url), 'utf8')
  const trade = readFileSync(new URL('../src/lib/regex/trade.js', import.meta.url), 'utf8')
  assert.ok(trade.includes("export const INSTANT_BUYOUT = { option: 'securable' }"), 'one definition, with the query builder')
  assert.ok(session.includes("import { INSTANT_BUYOUT } from './regex/trade.js'") && !session.includes("'securable'"), 'the home page uses it')
  assert.ok(/export const tradeHome = \(league\) => queryUrl\(/.test(session), 'the home page is a ?q= URL built by queryUrl')
  const ws = readFileSync(new URL('../src/components/WorkspaceView.jsx', import.meta.url), 'utf8')
  assert.ok(/if \(\/\[\?&\]q=\/\.test\(mountUrl\)\) return/.test(ws), 'the DOM click runs only when the URL does not carry the status')
})
