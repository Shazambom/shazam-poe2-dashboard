// A trade link's search, read from the link itself (no request): a saved search's slug is its query,
// gzipped and base64'd (measured on the owner's saved searches, 2026-10-01); an EE2-style link carries
// it as ?q=<json>. The Strat Calculator links a cost to either ("paste a trade url and we handle it";
// "Your saved searches"). Exchange links are not searches.
import test from 'node:test'
import assert from 'node:assert/strict'
const S = await import('../src/lib/session.js')

const HH_SLUG = 'H4sIAAAAAAAAEzXMQQqAIBBG4avEv_YELlt1h3Ax5USBqegYiHj3KGr7PngNWUhKhm4IUY7goZF5LYkWx-gKnk6GxsRk9-KFExSkxq9ddRjZCdT7ydBz-5W8hcJ2OOH0gOmm36ay9cNvAAAA'
const HH = { status: { option: 'securable' }, name: 'Headhunter', type: 'Heavy Belt', stats: [{ type: 'and', filters: [] }] }

test('a saved search link: its slug is the search, read without asking the site', async () => {
  const url = `https://www.pathofexile.com/trade2/search/poe2/Forbidden%20Rites/${HH_SLUG}`
  assert.deepEqual(await S.searchOfLink(url), { query: HH })
  assert.deepEqual(await S.searchOfLink(`${url}/live`), { query: HH }, 'its live form too')
})

test('an EE2-style ?q= link: the JSON it carries, with or without the outer query', async () => {
  const body = { query: { type: 'Breach Tablet' }, sort: { price: 'asc' } }
  assert.deepEqual(await S.searchOfLink(S.queryUrl({ q: JSON.stringify(body) }, 'L')), body)
  assert.deepEqual(await S.searchOfLink(S.queryUrl({ q: JSON.stringify({ type: 'Breach Tablet' }) }, 'L')), { query: { type: 'Breach Tablet' } })
})

test('anything that is not a readable search is null', async () => {
  for (const bad of ['', 'hello', 'https://example.com/x',
    `https://www.pathofexile.com/trade2/exchange/poe2/Forbidden%20Rites/${HH_SLUG}`,
    'https://www.pathofexile.com/trade2/search/poe2/Forbidden%20Rites/AbCd12',     // a short id: no search inside
    'https://www.pathofexile.com/trade2/search/poe2/Forbidden%20Rites/H4sIAAAAbroken']) {
    assert.equal(await S.searchOfLink(bad), null, bad)
  }
})
