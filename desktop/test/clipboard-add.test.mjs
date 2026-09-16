// Pins desktop/src/clipboard-add.js — main classifies the clipboard; the text never leaves main.
import test from 'node:test'
import assert from 'node:assert/strict'
const { classify, classifyClipboard } = await import('../src/clipboard-add.js')
const Q = JSON.stringify({ query: { name: 'Headhunter', type: 'Heavy Belt' }, sort: { price: 'asc' } })

test('classify: search id link → trade-url with slug/live; league dropped', () => {
  assert.deepEqual(classify('https://www.pathofexile.com/trade2/search/poe2/Forbidden%20Rites/AbC123/live'), { kind: 'trade-url', parsed: { type: 'search', slug: 'AbC123', live: true } })
  assert.deepEqual(classify('  https://www.pathofexile.com/trade2/search/poe2/Standard/xyz  \n'), { kind: 'trade-url', parsed: { type: 'search', slug: 'xyz', live: false } })
})

test('classify: ?q= link → query-url with the exact q; exchange → exchange; junk → none with length only', () => {
  assert.deepEqual(classify(`https://www.pathofexile.com/trade2/search/poe2/Standard?q=${encodeURIComponent(Q)}`), { kind: 'query-url', parsed: { q: Q } })
  assert.deepEqual(classify('https://www.pathofexile.com/trade2/exchange/poe2/Standard/abc'), { kind: 'exchange' })
  assert.deepEqual(classify('https://www.pathofexile.com/trade2/exchange/poe2/Standard?q={}'), { kind: 'exchange' })
  assert.deepEqual(classify('Rarity: Unique\nHeadhunter\nHeavy Belt'), { kind: 'none', len: 36 })
  assert.deepEqual(classify(''), { kind: 'none', len: 0 })
  assert.deepEqual(classify('   '), { kind: 'none', len: 0 })
})

test('classifyClipboard reads via the injected reader, caps at 8000 chars, and never returns the text', () => {
  const junk = 'x'.repeat(20000)
  const r = classifyClipboard(() => junk)
  assert.deepEqual(r, { kind: 'none', len: 8000 })
  assert.ok(!JSON.stringify(r).includes('xxxx'))
  assert.deepEqual(classifyClipboard(() => { throw new Error('no clipboard') }), { kind: 'none', len: 0 })
})

test('the desktop URL helpers agree with the frontend ones on every fixture', async () => {
  const d = await import('../src/trade/urls.js')
  globalThis.window = undefined
  const f = await import('../../frontend/src/lib/session.js')
  const fixtures = [
    'https://www.pathofexile.com/trade2/search/poe2/Standard/abc123', 'https://www.pathofexile.com/trade2/search/poe2/Rise%20of%20the%20Abyssal/xyz/live',
    'https://www.pathofexile.com/trade2/exchange/Standard/q1w2e3', '/trade2/search/Standard/slug?x=1', 'https://example.com/', '',
    `https://www.pathofexile.com/trade2/search/poe2/Forbidden%20Rites?q=${encodeURIComponent(Q)}`, `https://www.pathofexile.com/trade2/search/poe2/Standard?q=${Q}`,
    'https://www.pathofexile.com/trade2/search/poe2/Standard?q={"a":"x/y/z"}', 'https://www.pathofexile.com/trade2/search/poe2/Standard?q=nope',
  ]
  for (const u of fixtures) {
    assert.deepEqual(d.parseTradeUrl(u), f.parseTradeUrl(u), 'parseTradeUrl ' + u)
    assert.deepEqual(d.parseTradeQueryUrl(u), f.parseTradeQueryUrl(u), 'parseTradeQueryUrl ' + u)
  }
  assert.equal(d.queryUrl({ q: Q }, 'A B'), f.queryUrl({ q: Q }, 'A B'))
  assert.equal(d.tradeUrl({ type: 'search', slug: 's' }, 'A B', true), f.tradeUrl({ type: 'search', slug: 's' }, 'A B', true))
})
