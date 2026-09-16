// Every fixture item × prefs variant: the port's q equals the golden EE2's own code produced, as a STRING.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const ROOT = new URL('../', import.meta.url).pathname
const port = require('../src/vendor/ee2-query')
const G = `${ROOT}test/goldens/ee2-query/`, F = `${ROOT}test/fixtures/ee2/items/`

await port.init()
const goldens = readdirSync(G).filter(f => f.endsWith('.json')).sort()
assert.ok(goldens.length >= 60, `goldens present (${goldens.length})`)

for (const g of goldens) {
  test(`golden ${g}`, () => {
    const gold = JSON.parse(readFileSync(G + g, 'utf8'))
    const raw = readFileSync(F + gold.fixture, 'utf8')
    const r = port.buildQuery(raw, gold.prefs)
    if (gold.error) { assert.ok(r.error, 'expected an error'); assert.equal(r.error.stage, gold.error.stage); return }
    assert.ok(!r.error, r.error && JSON.stringify(r.error))
    assert.equal(r.q, gold.q, 'q differs from EE2')
    assert.equal(r.name, gold.name)
    JSON.parse(r.q)
  })
}

test('the fixture set covers the roadmap categories', () => {
  const names = readdirSync(F).map(f => f.toLowerCase())
  for (const want of ['unique', 'rare', 'magic', 'normal', 'corrupted', 'unidentified', 'mirrored', 'currency', 'divine', 'map', 'gem', 'jewel', 'charm', 'fractured', 'german', 'unknownbase']) {
    assert.ok(names.some(n => n.includes(want)), want)
  }
  assert.ok(names.length >= 20)
})
