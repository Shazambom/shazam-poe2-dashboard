// An icon path from /api/currencies is GGG's CDN path ("/gen/image/…", hotlinked) or, for an exchange item
// the trade site does not list (Raven's Reflection, bug report FY0M4R), the game art carried as data by
// the market pipeline ("data:image/webp;base64,…") — never prefixed with the CDN.
import test from 'node:test'
import assert from 'node:assert/strict'
const { iconUrl, CDN } = await import('../src/lib/icons.js')

test('a CDN path is hotlinked, a full URL and a data icon are used as they are, nothing is nothing', () => {
  assert.equal(iconUrl('/gen/image/abc/def/Chaos.png'), `${CDN}/gen/image/abc/def/Chaos.png`)
  assert.equal(iconUrl('https://web.poecdn.com/x.png'), 'https://web.poecdn.com/x.png')
  assert.equal(iconUrl('data:image/webp;base64,UklGRg=='), 'data:image/webp;base64,UklGRg==')
  assert.equal(iconUrl(null), null)
  assert.equal(iconUrl(''), null)
})
