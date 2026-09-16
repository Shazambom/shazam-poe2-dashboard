// buildQuery never throws, q parses back, and a warm build is fast.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const port = require('../src/vendor/ee2-query')
const F = new URL('../test/fixtures/ee2/items/', import.meta.url).pathname
await port.init()
const items = readdirSync(F).map(f => readFileSync(F + f, 'utf8'))

test('never throws on junk; errors carry a stage', () => {
  const nul = String.fromCharCode(0)
  for (const raw of ['', 'hello', 'Item Class:\nRarity:\n', 'Rarity: Rare\n\n--------\n', nul + nul, 'x'.repeat(100000), null, undefined, 42]) {
    const r = port.buildQuery(raw, {})
    assert.ok(r.error && ['parse', 'lang', 'currency', 'presets', 'request'].includes(r.error.stage), JSON.stringify(r).slice(0, 100))
  }
  assert.equal(port.buildQuery(items[0], { language: 'fr' }).error.stage, 'lang')
})

test('q parses back and carries status + sort; host follows prefs', () => {
  const built = items.map(i => port.buildQuery(i, {})).filter(r => !r.error)
  assert.ok(built.length >= 20)
  for (const r of built) { const j = JSON.parse(r.q); assert.equal(j.query.status.option, 'securable'); assert.deepEqual(j.sort, { price: 'asc' }); assert.ok(r.name && (r.item.rarity || r.item.itemClass)) }
  assert.equal(port.buildQuery(items[0], { preferredTradeSite: 'www' }).host, 'www.pathofexile.com')
})

test('warm build median < 20 ms over 200 items', () => {
  const good = items.filter(i => !port.buildQuery(i, {}).error)
  const times = []
  for (let n = 0; n < 200; n++) { const t0 = process.hrtime.bigint(); port.buildQuery(good[n % good.length], {}); times.push(Number(process.hrtime.bigint() - t0) / 1e6) }
  times.sort((a, b) => a - b)
  assert.ok(times[100] < 20, `median ${times[100].toFixed(2)} ms`)
})
