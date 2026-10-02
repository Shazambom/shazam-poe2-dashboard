// Pins desktop/src/clipboard-add.js — main classifies the clipboard; the text never leaves main.
import test from 'node:test'
import assert from 'node:assert/strict'
const { classify } = await import('../src/clipboard-add.js')
const Q = JSON.stringify({ query: { name: 'Headhunter', type: 'Heavy Belt' }, sort: { price: 'asc' } })

test('classify: search id link → trade-url with slug/live; league dropped', () => {
  assert.deepEqual(classify('https://www.pathofexile.com/trade2/search/poe2/Forbidden%20Rites/AbC123/live'), { kind: 'trade-url', parsed: { type: 'search', slug: 'AbC123', live: true } })
  assert.deepEqual(classify('  https://www.pathofexile.com/trade2/search/poe2/Standard/xyz  \n'), { kind: 'trade-url', parsed: { type: 'search', slug: 'xyz', live: false } })
})

test('classify: ?q= link → query-url with the exact q; exchange → exchange; junk → none with length only', () => {
  assert.deepEqual(classify(`https://www.pathofexile.com/trade2/search/poe2/Standard?q=${encodeURIComponent(Q)}`), { kind: 'query-url', parsed: { q: Q } })
  assert.deepEqual(classify('https://www.pathofexile.com/trade2/exchange/poe2/Standard/abc'), { kind: 'exchange' })
  assert.deepEqual(classify('https://www.pathofexile.com/trade2/exchange/poe2/Standard?q={}'), { kind: 'exchange' })
  assert.deepEqual(classify('hello world, not a link'), { kind: 'none', len: 23 })
  assert.deepEqual(classify(''), { kind: 'none', len: 0 })
  assert.deepEqual(classify('   '), { kind: 'none', len: 0 })
})

test('classify caps at 8000 chars and never returns the text', () => {
  const r = classify('x'.repeat(20000))
  assert.deepEqual(r, { kind: 'none', len: 8000 })
  assert.ok(!JSON.stringify(r).includes('xxxx'))
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
  assert.equal(d.tradeHome('A B'), f.tradeHome('A B'), 'a new tab opens the same Instant Buyout page from either side')
})

// ---- Batch 4-A: the item rung ----
test('classify: PoE item text → item (the worker builds the intent in main; text never returned)', () => {
  const raw = 'Item Class: Belts\nRarity: Unique\nHeadhunter\nHeavy Belt\n--------\n+41 to maximum Life\n'
  assert.deepEqual(classify(raw), { kind: 'item' })
  assert.deepEqual(classify('Rarity: Rare\nFoe Slicer\nBastard Sword\n--------\nItem Level: 80\n'), { kind: 'item' })
})

test('a trade link copied with line breaks or spaces in it (chat, terminal wrap) still classifies', () => {
  // 2026-09-30: a 923-char search URL copied out of a wrapped chat window arrived as 935 chars with
  // line breaks and was refused ("That's not a trade link"). A URL never holds raw whitespace.
  const url = 'https://www.pathofexile.com/trade2/search/poe2/Forbidden%20Rites?q=%7B%22query%22%3A%7B%22status%22%3A%7B%22option%22%3A%22securable%22%7D%7D%2C%22sort%22%3A%7B%22price%22%3A%22asc%22%7D%7D'
  const wrapped = url.match(/.{1,40}/g).join('\n  ')
  assert.equal(classify(wrapped).kind, 'query-url')
  assert.equal(classify(' ' + 'https://www.pathofexile.com/trade2/search/poe2/Standard/ab cd' + '\r\n').kind, 'trade-url')
})
