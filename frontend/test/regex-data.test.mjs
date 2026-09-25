// The tables the Regex tab ships (docs/regex-filters-plan.md): computed by
// frontend/scripts/sync-regex-data.mjs from the hand-maintained inputs, never hand-edited. The
// property that makes the feature work is re-checked here on the shipped rows: every token
// matches its own mod in every printed form and nothing else the tooltip can show.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { shortestUnique, escapeRe, matchable, formsOf, linesOf } from '../src/lib/regex/shortest.js'
import { placement } from '../src/lib/regex/terms.js'
import { namePool } from '../src/lib/regex/names.js'
import { defaults, KINDS } from '../src/lib/regex/defaults.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(HERE, '..', 'src', 'data', 'regex')
const STATS = path.join(HERE, '..', '..', 'desktop', 'src', 'vendor', 'ee2-query', 'data', 'trade', 'stats.json')
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'))
const readPool = (kind) => fs.readFileSync(path.join(DATA, 'pools', `${kind}.txt`), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'))
const printed = (text) => formsOf(text).flatMap(f => linesOf(f).map(matchable))

test('shortestUnique picks the shortest substring no other line matches', () => {
  const pool = ['Monsters deal #% of Damage as Extra Fire', 'Monsters deal #% of Damage as Extra Cold', 'Area has patches of Ignited Ground']
  const out = shortestUnique(pool, [])
  for (const [i, tok] of out.entries()) {
    const re = new RegExp(tok, 'i')
    assert.ok(re.test(matchable(pool[i])), `${tok} must match its own line`)
    for (const [j, other] of pool.entries()) if (j !== i) assert.equal(re.test(matchable(other)), false, `${tok} must not match ${other}`)
  }
  assert.ok(out[0].length <= 'a fire$'.length, out[0])
})

test('shortestUnique never uses a digit, honours the stoplist, escapes specials, anchors when shorter', () => {
  const [tok] = shortestUnique(['#% increased Monster Damage'], ['Monster Damage: +10%'])
  assert.equal(/[#\d]/.test(tok), false)
  assert.equal(new RegExp(tok, 'i').test('Monster Damage: +10%'), false)
  const [digit] = shortestUnique(['Players deal no damage for 3 out of every 10 seconds'], ['Revives Available: 3'])
  assert.equal(/\d/.test(digit), false, digit)
  const [plus] = shortestUnique(['+#% Monster Elemental Resistances'], ['+#% to all Elemental Resistances'])
  assert.doesNotThrow(() => new RegExp(plus))
  const [anch] = shortestUnique(['Monsters are Armoured', 'Monsters are Evasive', 'Armoured Monsters deal more'], [])
  assert.equal(new RegExp(anch, 'i').test(matchable('Armoured Monsters deal more')), false)
  assert.equal(escapeRe('a+b(c)'), 'a\\+b\\(c\\)')
  const [two] = shortestUnique(['Monsters have #% increased Stun Threshold | Monsters have #% increased Ailment Threshold', 'Monsters have #% increased Life'], [])
  const re = new RegExp(two, 'i')
  assert.ok(re.test(matchable('Monsters have #% increased Stun Threshold')) || re.test(matchable('Monsters have #% increased Ailment Threshold')))
  assert.equal(re.test(matchable('Monsters have #% increased Life')), false)
})

test('a modifier printed in several forms gets one token that matches every form', () => {
  const [tok] = shortestUnique(['Map contains an additional Shrine ~ Map contains # additional Shrines', 'Map has #% increased chance to contain Shrines'], [])
  const re = new RegExp(tok, 'i')
  assert.equal(re.test('Map contains an additional Shrine'), true, tok)
  assert.equal(re.test('Map contains 3 additional Shrines'), true, tok)
  assert.equal(re.test('Map has 40% increased chance to contain Shrines'), false, tok)
})

test('when the only distinguishing text sits on both sides of the roll, the token bridges it', () => {
  const [tok] = shortestUnique(['Map has #% increased Magic Monsters', 'Breaches in Map spawn #% increased Magic Monsters', 'Map has #% increased Monster Rarity'], [])
  const re = new RegExp(tok, 'i')
  assert.ok(tok.includes('.*'), tok)
  assert.equal(re.test('Map has 37% increased Magic Monsters'), true, tok)
  assert.equal(re.test('Breaches in Map spawn 37% increased Magic Monsters'), false, tok)
  assert.equal(re.test('Map has 16% increased Monster Rarity'), false, tok)
})

test('matchable stands a plain roll in for every placeholder, as items print it', () => {
  assert.equal(matchable('Monsters deal #% of Damage as Extra Fire'), 'Monsters deal 12% of Damage as Extra Fire')
})

test('the name vocabulary expands its patterns to every combination', () => {
  const pool = namePool({ vocab: { a: ['Grim', 'Lost'], b: ['Charge'], base: ['Breach Tablet'] }, patterns: ['{a} {b}', '{base}', 'Teeming {base}'] })
  assert.deepEqual(pool, ['Grim Charge', 'Lost Charge', 'Breach Tablet', 'Teeming Breach Tablet'])
  assert.throws(() => namePool({ vocab: {}, patterns: ['{nope}'] }))
})

const manifest = readJson('MANIFEST.json')
const stoplist = [...readJson('tooltip-lines.json'), ...namePool(readJson('map-names.json'))]
const statsBuf = fs.readFileSync(STATS)
const gggIds = new Set(JSON.parse(statsBuf.toString('utf8')).result.flatMap(g => g.entries.map(e => e.id)))
const walk = (rel = '') => fs.readdirSync(path.join(DATA, rel), { withFileTypes: true }).flatMap(e => {
  const p = rel ? `${rel}/${e.name}` : e.name
  return e.isDirectory() ? walk(p) : e.name === 'MANIFEST.json' ? [] : [p]
})

test('every file under data/regex is in MANIFEST.json and hashes as recorded, and the source snapshot too', () => {
  const files = walk().sort()
  assert.deepEqual(Object.keys(manifest.files).sort(), files, 'a file is missing from the manifest: rerun sync-regex-data.mjs')
  for (const [file, rec] of Object.entries(manifest.files)) {
    const buf = fs.readFileSync(path.join(DATA, file))
    assert.equal(sha(buf), rec.sha256, `${file} drifted from the manifest: rerun sync-regex-data.mjs`)
    assert.equal(buf.length, rec.bytes, file)
  }
  assert.equal(sha(statsBuf), manifest.sourceSha256, 'the GGG snapshot changed since the tables were built: rerun sync-regex-data.mjs')
})

// Texts GGG genuinely has no stat for (two-line mods, unsigned spellings it lacks). A new gap
// in this list means the join broke, not the corpus.
const NO_TRADE_ID = {
  waystone: 5,
  tablet: 6,
}

for (const kind of KINDS) {
  test(`${kind}: every shipped row re-checks: token, forms, placement, trade ids`, () => {
    const table = readJson(`${kind}.json`)
    const { mods } = table
    const pool = readPool(kind)
    assert.equal(mods.length, pool.length, 'one row per pool line')
    assert.deepEqual([...mods.map(m => m.text)].sort(), [...pool].sort())
    assert.equal(new Set(mods.map(m => m.id)).size, mods.length, 'ids are unique')
    const otherKind = readPool(kind === 'waystone' ? 'tablet' : 'waystone')
    for (const m of mods) {
      assert.ok(m.regex, m.text)
      const re = new RegExp(m.regex, 'im')
      for (const f of formsOf(m.text)) assert.ok(linesOf(f).map(matchable).some(l => re.test(l)), `${m.regex} must match the form "${f}"`)
      for (const o of mods) if (o !== m) for (const l of printed(o.text)) assert.equal(re.test(l), false, `${m.regex} (${m.text}) also matches "${l}"`)
      for (const l of stoplist) assert.equal(re.test(matchable(l)), false, `${m.regex} (${m.text}) matches the fixed line or name "${l}"`)
      assert.deepEqual(m.num, placement(m.text, m.regex), `${m.text}: shipped placement drifted from the rule`)
      assert.ok(Array.isArray(m.trade), m.text)
      for (const id of m.trade) assert.ok(gggIds.has(id), `${id} is not in the GGG snapshot`)
      if (formsOf(m.text).length === 1 && linesOf(m.text).length === 1 && (m.text.match(/#/g) || []).length === 1) assert.ok(m.num, `${m.text} should offer a minimum`)
    }
    assert.equal(mods.filter(m => !m.trade.length).length, NO_TRADE_ID[kind], `${kind}: rows without a trade id: ${mods.filter(m => !m.trade.length).map(m => m.text).join(' / ')}`)
    // Kind anchors the generators rely on: no mod of the other kind prints them either way round.
    const anchor = kind === 'waystone' ? /e \(T/i : / rem/i
    for (const l of otherKind.flatMap(printed)) assert.equal(anchor.test(l), false, `the ${kind} anchor matches a ${kind === 'waystone' ? 'tablet' : 'waystone'} mod: ${l}`)
  })
}

test('tablet kinds: one per settings key, tokens unique against every mod, fixed line and name', () => {
  const { kinds, mods } = readJson('tablet.json')
  assert.deepEqual(kinds.map(k => k.key), Object.keys(defaults.tablet.type))
  const descriptions = new Set(kinds.map(k => k.description))
  const others = [...stoplist.filter(l => !descriptions.has(l)), ...mods.flatMap(m => printed(m.text)), ...kinds.map(k => k.base)]
  for (const k of kinds) {
    assert.ok(k.regex && k.base && k.description && k.label, JSON.stringify(k))
    const re = new RegExp(k.regex, 'im')
    assert.ok(re.test(k.description), `${k.regex} must match "${k.description}"`)
    for (const other of kinds) if (other !== k) assert.equal(re.test(other.description), false, `${k.regex} also matches "${other.description}"`)
    for (const l of others) assert.equal(re.test(matchable(l)), false, `${k.regex} (${k.key}) matches "${l}"`)
  }
})
