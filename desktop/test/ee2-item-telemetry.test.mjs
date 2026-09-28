// The EE2 diagnostic also reports the item text and the built history search URL, each under its
// own marker, so real items become parser fixtures and the query can be debugged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { attachEe2Telemetry, postItemText, ITEM_MARKER, ITEM_MAX } = require('../src/dev-ee2-telemetry.js')

const RAW = 'Item Class: Rings\nRarity: Rare\nHavoc Twirl\nSapphire Ring\n--------\nItem Level: 68\n--------\n+39 to maximum Life\n'

test('an item-checked event posts the compact line and, under the item marker, the text with its origin', () => {
  const sent = []
  const m = new EventEmitter()
  attachEe2Telemetry(m, { send: (marker, body, opts) => sent.push([marker, body, opts]) })
  m.emit('item-checked', { origin: 'ee2', rarity: 'Rare', name: 'Havoc Twirl', raw: RAW })
  const compact = sent.find(([k, b]) => k === 'ee2' && b.startsWith('item-checked'))
  assert.ok(compact && !compact[1].includes('maximum Life'), 'the compact line stays compact')
  const full = sent.find(([k]) => k === ITEM_MARKER)
  assert.equal(full[1], `origin=ee2\n${RAW}`)
  assert.equal(full[2].max, ITEM_MAX)
})

test('no text, no item post; a long text is cut at the cap; the origin names the path', () => {
  const sent = []
  const send = (marker, body, opts) => sent.push([marker, body, opts])
  postItemText('mods', '', send)
  postItemText('mods', null, send)
  assert.equal(sent.length, 0)
  postItemText('clipboard', 'x'.repeat(ITEM_MAX + 500), send)
  assert.equal(sent.length, 1)
  assert.equal(sent[0][0], ITEM_MARKER)
  assert.ok(sent[0][1].startsWith('origin=clipboard\n'))
  assert.equal(sent[0][2].max, ITEM_MAX)
  const m = new EventEmitter()
  attachEe2Telemetry(m, { send })
  m.emit('item-checked', { origin: 'ee2', rarity: 'Rare', name: 'x' })   // no raw on the event
  assert.equal(sent.filter(([k]) => k === ITEM_MARKER).length, 1)
})

test('a built history intent posts the search URL the app would open, under the query marker', async () => {
  const { postQuery, QUERY_MARKER } = require('../src/dev-ee2-telemetry.js')
  const { queryUrl } = require('../src/trade/urls.js')
  const sent = []
  const send = (marker, body, opts) => sent.push([marker, body, opts])
  const intent = { origin: 'ee2', name: 'Havoc Twirl Sapphire Ring', cfgLeague: 'Forbidden Rites', q: '{"query":{"status":{"option":"securable"}}}', degraded: false }
  postQuery(intent, send)
  assert.equal(sent.length, 1)
  assert.equal(sent[0][0], QUERY_MARKER)
  assert.equal(sent[0][1], `origin=ee2 name="Havoc Twirl Sapphire Ring"\n${queryUrl({ q: intent.q }, 'Forbidden Rites')}`)
  assert.ok(sent[0][2].max >= 8000)
  postQuery({ ...intent, q: null, degraded: true }, send)
  postQuery(null, send)
  assert.equal(sent.length, 1, 'a degraded intent has no query to report')
})
