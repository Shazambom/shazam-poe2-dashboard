#!/usr/bin/env node
// Build the Regex tab's tables (frontend/src/data/regex/{waystone,tablet}.json) from the
// hand-maintained inputs. No network. Run by hand in a reviewed change; the drift test in
// frontend/test/regex-data.test.mjs fails the gate when the tables or their inputs are stale.
//
//   node scripts/sync-regex-data.mjs
//
// Inputs (all in data/regex, all hashed into MANIFEST.json):
//   pools/<kind>.txt       the mods that roll on that kind, GGG's text, "#" for the roll
//                          ("a | b": printed together; "a ~ b": printed as one of)
//   tooltip-lines.json     the lines every tooltip shows; a token may match none of them
//   map-names.json         the name vocabulary and its patterns; a token may match no name
//   tablet-kinds.json      the tablet kinds: trade base and the description line each prints
//   ../../../desktop/src/vendor/ee2-query/data/trade/stats.json   GGG's trade stats, for the ids
// Output rows: { id, text, regex, trade: [ids], num } with the token from shortestUnique and
// `num` from placement (where the roll sits relative to the token); tablet.json also carries
// `kinds` with a token per kind.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { shortestUnique, formsOf, linesOf } from '../src/lib/regex/shortest.js'
import { placement } from '../src/lib/regex/terms.js'
import { namePool } from '../src/lib/regex/names.js'
import { KINDS } from '../src/lib/regex/defaults.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND = path.resolve(HERE, '..')
const DATA = path.join(FRONTEND, 'src', 'data', 'regex')
const STATS = path.resolve(FRONTEND, '..', 'desktop', 'src', 'vendor', 'ee2-query', 'data', 'trade', 'stats.json')

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
export const readPool = (text) => text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'))

// FNV-1a over the text: a stable id that survives reordering the pool.
function fnv1a(str) {
  let h = 0x811c9dc5
  for (const ch of Buffer.from(str, 'utf8')) { h ^= ch; h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

// GGG's stat ids for a pool text: every printed form is looked up (lower case; "+#", "#" and
// "-#" spellings tried), a two-line form has no single stat. Explicit ids first, then the rest,
// all of them: a text GGG lists twice needs both in a trade search.
function statIndex(stats) {
  const byText = new Map()
  for (const g of stats.result) for (const e of g.entries) {
    const k = e.text.toLowerCase()
    if (!byText.has(k)) byText.set(k, [])
    byText.get(k).push(e.id)
  }
  const one = (form) => {
    if (linesOf(form).length > 1) return []
    const t = form.toLowerCase()
    return byText.get(t) || byText.get(t.replace(/[+-]#/g, '#')) || byText.get(t.replace(/(?<![+\-\d])#/g, '+#')) || []
  }
  return (text) => {
    const ids = [...new Set(formsOf(text).flatMap(one))]
    return [...ids.filter(id => id.startsWith('explicit.')), ...ids.filter(id => !id.startsWith('explicit.'))]
  }
}

// Every file under data/regex except the manifest, so a new input cannot ship unhashed.
function walk(dir, rel = '') {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap(e => {
    const p = rel ? `${rel}/${e.name}` : e.name
    return e.isDirectory() ? walk(dir, p) : e.name === 'MANIFEST.json' ? [] : [p]
  }).sort()
}

export function build() {
  const statsBuf = fs.readFileSync(STATS)
  const tradeOf = statIndex(JSON.parse(statsBuf.toString('utf8')))
  const tooltip = readJson(path.join(DATA, 'tooltip-lines.json'))
  const names = namePool(readJson(path.join(DATA, 'map-names.json')))
  const kinds = readJson(path.join(DATA, 'tablet-kinds.json')).kinds
  const stop = [...tooltip, ...names]
  for (const kind of KINDS) {
    const texts = readPool(fs.readFileSync(path.join(DATA, 'pools', `${kind}.txt`), 'utf8'))
    const dup = texts.find((t, i) => texts.indexOf(t) !== i)
    if (dup) throw new Error(`${kind}.txt lists "${dup}" twice`)
    const tokens = shortestUnique(texts, stop)
    const mods = texts.map((text, i) => ({ id: fnv1a(text), text, regex: tokens[i], trade: tradeOf(text), num: placement(text, tokens[i]) }))
      .sort((a, b) => a.text.localeCompare(b.text))
    const table = { mods }
    if (kind === 'tablet') {
      // A kind's token must be unique against every mod, every fixed line and every name, but
      // its own description line is a fixed line too: take those out of the stoplist first.
      const descriptions = new Set(kinds.map(k => k.description))
      const kindStop = [...tooltip.filter(l => !descriptions.has(l)), ...names, ...texts]
      const kindTokens = shortestUnique(kinds.map(k => k.description), kindStop)
      table.kinds = kinds.map((k, i) => ({ ...k, regex: kindTokens[i] }))
    }
    fs.writeFileSync(path.join(DATA, `${kind}.json`), JSON.stringify(table, null, 2) + '\n')
    console.log(`${kind}: ${mods.length} mods, ${mods.filter(m => m.trade.length).length} with trade ids, ${mods.filter(m => m.num).length} with a minimum, longest token ${Math.max(...tokens.map(t => t.length))}`)
  }
  const files = {}
  for (const f of walk(DATA)) { const buf = fs.readFileSync(path.join(DATA, f)); files[f] = { sha256: sha(buf), bytes: buf.length } }
  const manifest = { source: 'data/regex inputs + ee2-query/data/trade/stats.json', sourceSha256: sha(statsBuf), files }
  fs.writeFileSync(path.join(DATA, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) build()
