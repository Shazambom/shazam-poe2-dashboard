// The first-use loads of EE2's trade data: modsearch.js's stat/base catalogue and uniqueprice.js's
// unique list are read once on first use and then reused; a load that fails is retried on the next
// call. Each test takes a fresh copy of the module so it sees a first use.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const MODSEARCH = require.resolve('../src/trade/modsearch.js')
const UNIQUEPRICE = require.resolve('../src/trade/uniqueprice.js')
const fresh = (file) => { delete require.cache[file]; return require(file) }
// Which fs function each module reads its data through (mocked to count and to fail reads).
/** @type {Record<'modsearch' | 'uniqueprice', { target: any, name: string }>} */
const READS = { modsearch: { target: fs.promises, name: 'readFile' }, uniqueprice: { target: fs, name: 'readFileSync' } }
const LIFE = { text: '+# to maximum Life', affix: 'prefix', bases: ['Gold Ring'] }
// Reads of EE2's data only (requiring a module reads its source through the same fs).
const dataReads = (mock) => mock.mock.calls.filter(c => String(c.arguments[0]).includes('ee2-query')).length

test('modsearch: the catalogue is read on first use (3 files) and reused afterwards', async (t) => {
  const reads = t.mock.method(READS.modsearch.target, READS.modsearch.name)
  const M = fresh(MODSEARCH)
  assert.equal(dataReads(reads), 0, 'nothing is read at require time')
  const r = await M.lookup(LIFE)
  assert.equal(r.category, 'accessory.ring')
  assert.equal(dataReads(reads), 3)
  await M.lookup(LIFE)
  await M.lookupItemMods({ baseType: 'Gold Ring', explicitMods: ['+50 to maximum Life'] })
  assert.equal(dataReads(reads), 3)
})

test('modsearch: a failed first load throws to the caller and the next call loads again', async (t) => {
  let fail = true
  const real = READS.modsearch.target[READS.modsearch.name]
  t.mock.method(READS.modsearch.target, READS.modsearch.name, function (...a) {
    if (fail && String(a[0]).includes('ee2-query')) { fail = false; throw Object.assign(new Error('ENOENT: stats.json'), { code: 'ENOENT' }) }
    return real.apply(this, a)
  })
  const M = fresh(MODSEARCH)
  await assert.rejects(async () => M.lookup(LIFE), /ENOENT/)
  assert.equal((await M.lookup(LIFE)).category, 'accessory.ring')
})

test('uniqueprice: the unique list is read on first use and reused afterwards', async (t) => {
  const reads = t.mock.method(READS.uniqueprice.target, READS.uniqueprice.name)
  const U = fresh(UNIQUEPRICE)
  assert.equal(dataReads(reads), 0)
  const a = await U.uniques()
  assert.ok(a.length > 500)
  assert.equal(dataReads(reads), 1)
  assert.equal(await U.uniques(), a, 'the same list')
  assert.equal(dataReads(reads), 1)
})

// Today's behaviour, pinned as it is (reported to the owner, not changed here): uniques() sets its cache
// before reading, so after a failed read every later call answers an empty list until restart.
test('uniqueprice: a failed first load throws to the caller; later calls answer an empty list', async (t) => {
  let fail = true
  const real = READS.uniqueprice.target[READS.uniqueprice.name]
  t.mock.method(READS.uniqueprice.target, READS.uniqueprice.name, function (...a) {
    if (fail && String(a[0]).includes('ee2-query')) { fail = false; throw Object.assign(new Error('ENOENT: items.json'), { code: 'ENOENT' }) }
    return real.apply(this, a)
  })
  const U = fresh(UNIQUEPRICE)
  await assert.rejects(async () => U.uniques(), /ENOENT/)
  assert.deepEqual(await U.uniques(), [])
  assert.deepEqual(await U.uniques(), [])
})

test('modsearch: overlapping first calls share one read of the catalogue', async (t) => {
  const reads = t.mock.method(READS.modsearch.target, READS.modsearch.name)
  const M = fresh(MODSEARCH)
  const item = { baseType: 'Gold Ring', explicitMods: ['+50 to maximum Life'] }
  const [a, b, c, d] = await Promise.all([M.lookup(LIFE), M.lookup(LIFE), M.lookupItemMods(item), M.lookupItemMods(item)])
  assert.deepEqual(a, b)
  assert.deepEqual(c, d)
  assert.equal(c.category, 'accessory.ring')
  assert.equal(dataReads(reads), 3, 'stats.json, the bundle and items.ndjson, once each')
})
