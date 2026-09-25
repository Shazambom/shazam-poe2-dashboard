// Ours against the reference implementation's own number code, case by case. The goldens were produced by running
// upstream (frontend/scripts/regex-number-goldens.mjs; the source stays in ~/.cache, only the
// output strings are here): the full 0..999 and 0..99×0..99 input spaces in both rounding modes,
// price ranges at every digit boundary, and a few thousand seeded fuzz inputs with junk around
// the digits. The rules:
//   ranges       byte-identical
//   price bodies byte-identical inside our two deliberate additions (the leading space that
//                anchors on the note, the optional fraction)
//   minimums     the same set of integers matched over 0..999, and never a longer string; the
//                one intended difference is that a threshold Round to tens takes to 0 is "any"
//                for us ('') where upstream emits a bare wildcard ('.')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { minRegex, rangeRegex, priceRange } from '../src/lib/regex/number.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'goldens', 'regex-number.json'), 'utf8'))
// The grids are stored positionally; unfold them into cases beside the fuzz ones.
const G = {
  ...raw,
  minimum: [...raw.minimumGrid.flatMap((outs, r) => outs.map((out, n) => ({ in: String(n), round10: r === 1, out }))), ...raw.minimum],
  range: [...raw.rangeGrid.flatMap((byLo, r) => byLo.flatMap((byHi, lo) => byHi.map((out, hi) => ({ min: String(lo), max: String(hi), round10: r === 1, out })))), ...raw.range],
}
const matched = (r) => { if (r === '') return null; const re = new RegExp('^(?:' + r.replace(/\./g, '\\d') + ')$'); const out = []; for (let v = 0; v <= 999; v++) if (re.test(String(v))) out.push(v); return out.join(',') }
const wildcard = (r) => r === '.' || r === ''

test('goldens are pinned to an upstream commit and cover the whole input space', () => {
  assert.match(G.upstream, /^[\w.-]+\/[\w.-]+$/)
  assert.match(G.commit, /^[0-9a-f]{40}$/)
  assert.ok(G.minimum.length >= 2 * 1000 + 1500, `${G.minimum.length} minimum cases`)
  assert.ok(G.range.length >= 2 * 100 * 100 + 1500, `${G.range.length} range cases`)
  assert.ok(G.price.length >= 3 * 24 * 24 + 2000, `${G.price.length} price cases`)
})

test('minimums match upstream by the integers they accept, and are never longer', () => {
  let same = 0, shorter = 0, outOfRange = 0
  for (const c of G.minimum) {
    // The box has no room above 999 and both entry points clamp there; upstream reads a longer
    // input by its first three digits, which is a quirk, not a behaviour to keep.
    if (Number((c.in.match(/\d/g) || []).join('')) > 999) { outOfRange++; continue }
    const ours = minRegex(c.in, c.round10)
    if (wildcard(c.out) && wildcard(ours)) { same++; continue }   // "any", spelled our way
    assert.equal(matched(ours), matched(c.out), `minRegex(${JSON.stringify(c.in)}, ${c.round10}): ours ${ours} vs upstream ${c.out}`)
    assert.ok(ours.length <= c.out.length, `minRegex(${JSON.stringify(c.in)}, ${c.round10}): ours ${ours} is longer than upstream ${c.out}`)
    if (ours === c.out) same++; else shorter++
  }
  assert.ok(same + shorter + outOfRange === G.minimum.length && outOfRange < G.minimum.length / 10, `${same} identical, ${shorter} shorter, ${outOfRange} out of range`)
})

test('ranges match upstream byte for byte', () => {
  for (const c of G.range) assert.equal(rangeRegex(c.min, c.max, c.round10), c.out, `rangeRegex(${JSON.stringify(c.min)}, ${JSON.stringify(c.max)}, ${c.round10})`)
})

test('price bodies match upstream byte for byte inside our note anchor and optional fraction', () => {
  for (const c of G.price) {
    const ours = priceRange(c.min, c.max, c.currency)
    if (c.out === '') { assert.equal(ours, '', `price(${JSON.stringify(c.min)}, ${JSON.stringify(c.max)})`); continue }
    const theirs = c.out.slice(1, -1)                       // "<body> <currency>"
    const body = ours.slice(1, -1)                           // " <body>(\.\d+)? <currency>"
    assert.equal(body, ` ${theirs.replace(` ${c.currency}`, `(\\.\\d+)? ${c.currency}`)}`, `price(${JSON.stringify(c.min)}, ${JSON.stringify(c.max)}, ${c.currency}): ours ${ours} vs upstream ${c.out}`)
  }
})
