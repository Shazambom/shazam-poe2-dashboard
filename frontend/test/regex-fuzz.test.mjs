// The Regex tab, tested the way the game uses it. A search string is only right if the in-game
// search box, run over an item's tooltip, keeps exactly the items the settings describe. So:
//
//   settings ──generate──▶ string ──search()──▶ verdict on a rendered tooltip
//   settings ──oracle────▶ what the verdict must be for that item
//
// The tooltip renderer is the model of what the game shows (its fixed lines are the stoplist the
// tokens are computed against). The search simulator is the game's box: space-separated terms
// ANDed, quotes group a term, "!" negates, everything is a case-insensitive regex, ^ and $ bind
// to a line. Both are here, in the test, so a wrong assumption about the game is one edit away.
//
// Every tier pair, revive pair, rarity subset, state combination, tablet-type subset and uses
// value is swept exhaustively; everything together is fuzzed with a seeded generator so a failure
// replays. Mods come from the hand-authored pools with tokens computed by shortestUnique, so this
// also proves the token rule end to end, before any table is built.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate, defaults, overLimit, LIMIT } from '../src/lib/regex/index.js'
import { namePool } from '../src/lib/regex/names.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(HERE, '..', 'src', 'data', 'regex')
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'))
const STOP = readJson('tooltip-lines.json')
// The shipped tables (frontend/test/regex-data.test.mjs proves their tokens); the mods get the
// counts the item generator needs.
const describe = (m) => ({ ...m, forms: m.text.split(' ~ ').length, holes: Math.max(...m.text.split(' ~ ').map(f => (f.match(/#/g) || []).length)) })
const WTABLE = { mods: readJson('waystone.json').mods.map(describe) }
const TTABLE = (() => { const t = readJson('tablet.json'); return { mods: t.mods.map(describe).map(m => ({ ...m, type: tabletTypeOf(m.text) })), kinds: t.kinds } })()

// ---------------------------------------------------------------- the game
// Everything below was read off live trade listings on 2026-09-24 (91 rare waystones, 91 rare
// and 91 magic tablets): the line order, the wording, and the name vocabulary.
const NAMES = readJson('map-names.json')
const V = NAMES.vocab
const NAME_POOL = namePool(NAMES)

// A mod as the item prints it: a plain roll where the text has "#" ("Monsters deal 17% of Damage
// as Extra Fire"), one line per line of the mod ("a | b" in the pool). A mod with several printed
// forms ("a ~ b") prints the form `it.form` picks. `rolls` is one number per "#".
const renderMod = (text, rolls, form = 0) => {
  const forms = text.split(' ~ ')
  let i = 0
  return forms[form % forms.length].replace(/#/g, () => String(rolls[i++])).split(' | ').join('\n')
}

function renderWaystone(it) {
  const y = (label, v) => v > 0 ? [`${label}: +${v}%`] : []
  return [
    'Item Class: Waystones',
    `Rarity: ${it.rarity[0].toUpperCase() + it.rarity.slice(1)}`,
    ...(it.rarity === 'rare' ? [it.name] : []),
    `Waystone (Tier ${it.tier})`,
    '--------',
    `Revives Available: ${it.revives}`,
    ...y('Item Rarity', it.iir), ...y('Pack Size', it.pack), ...y('Monster Rarity', it.mrar), ...y('Monster Effectiveness', it.eff), ...y('Waystone Drop Chance', it.drop),
    '--------', `Item Level: ${it.tier + 64}`, '--------',
    ...it.mods.map(m => renderMod(m.text, m.rolls, m.form)),
    ...(it.corrupted ? ['--------', 'Corrupted'] : []),
    ...(it.delirious ? ['Delirious'] : []),
    ...(it.price ? ['--------', `~b/o ${it.price.n}${it.price.frac || ""} ${it.price.cur}`] : []),
  ].join('\n')
}

const TABLET_BASE = Object.fromEntries(TTABLE.kinds.map(k => [k.key, k.base]))
const TABLET_DESC = Object.fromEntries(TTABLE.kinds.map(k => [k.key, k.description]))
const TYPE_KEYS = TTABLE.kinds.map(k => k.key)

function renderTablet(it) {
  const base = TABLET_BASE[it.type]
  const head = it.rarity === 'rare' ? [it.name, base] : it.rarity === 'magic' ? [`${it.prefix} ${base} ${it.suffix}`] : [base]
  return [
    'Item Class: Tablets',
    `Rarity: ${it.rarity[0].toUpperCase() + it.rarity.slice(1)}`,
    ...head,
    'Tablet',
    '--------', `Item Level: ${60 + it.uses}`, '--------',
    TABLET_DESC[it.type],
    it.uses === 1 ? '1 use remaining' : `${it.uses} uses remaining`,
    '--------',
    ...it.mods.map(m => renderMod(m.text, m.rolls, m.form)),
    ...(it.price ? ['--------', `~b/o ${it.price.n}${it.price.frac || ""} ${it.price.cur}`] : []),
  ].join('\n')
}

// The search box. Returns true when the item stays visible.
export function search(string, tooltip) {
  const terms = []
  const re = /"([^"]*)"|(\S+)/g
  let m
  while ((m = re.exec(string))) terms.push(m[1] ?? m[2])
  return terms.every(t => {
    const neg = t.startsWith('!')
    const body = neg ? t.slice(1) : t
    let hit
    try { hit = new RegExp(body, 'im').test(tooltip) } catch (e) { throw new Error(`bad regex ${body}: ${e.message}`) }
    return neg ? !hit : hit
  })
}

// ---------------------------------------------------------------- the pools
// Tablet mods roll by tablet kind; a Breach tablet never shows a Ritual mod. Classified by the
// mechanic the text names; the rest roll on any tablet.
function tabletTypeOf(text) {
  return /Ritual|Favour|Tribute/i.test(text) ? 'ritual' : /Breach|Xesht|Hiveb/i.test(text) ? 'breach'
    : /Delirium|Deliriousness|Simulacrum|Mirror/i.test(text) ? 'delirium' : /Abyss|Desecrated/i.test(text) ? 'abyss'
    : /Vaal Beacon|Vaal Relic/i.test(text) ? 'temple' : /Map Boss|Map Bosses/i.test(text) ? 'overseer'
    : /Expedition|Runic|Remnant|Logbook|Verisium/i.test(text) ? 'expedition' : 'any'
}
const WMODS = WTABLE.mods
const TMODS = TTABLE.mods

// ---------------------------------------------------------------- seeded randomness
function rng(seed) {
  let a = seed >>> 0
  const next = () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1))
  const pick = (arr) => arr[int(0, arr.length - 1)]
  const chance = (p) => next() < p
  const sample = (arr, n) => { const a2 = [...arr]; const out = []; while (out.length < n && a2.length) out.push(a2.splice(int(0, a2.length - 1), 1)[0]); return out }
  return { next, int, pick, chance, sample }
}

const RAR = ['normal', 'magic', 'rare']
const CUR = ['exalted', 'divine']
const rolls = (r, mod) => Array.from({ length: mod.holes }, () => r.int(1, 99))
const withRoll = (r, m) => ({ ...m, rolls: rolls(r, m), form: r.int(0, m.forms - 1) })
const name = (r) => `${r.pick(V.waystone_first)} ${r.pick(V.waystone_second)}`
const price = (r) => r.chance(.5) ? { n: r.int(0, 999), frac: r.chance(.3) ? `.${r.int(1, 9)}` : '', cur: r.pick(CUR) } : null

function randomWaystone(r) {
  const mods = r.sample(WMODS, r.int(0, 6)).map(m => withRoll(r, m))
  return { name: name(r), tier: r.int(1, 16), revives: r.int(0, 6), rarity: r.pick(RAR), corrupted: r.chance(.4), delirious: r.chance(.2),
    iir: r.chance(.7) ? r.int(1, 150) : 0, pack: r.chance(.7) ? r.int(1, 150) : 0, drop: r.chance(.5) ? r.int(1, 150) : 0, eff: r.chance(.5) ? r.int(1, 150) : 0, mrar: r.chance(.5) ? r.int(1, 150) : 0,
    mods, price: price(r) }
}

function randomTablet(r) {
  const type = r.pick(Object.keys(TABLET_BASE))
  const pool = TMODS.filter(m => m.type === 'any' || m.type === type)
  const mods = r.sample(pool, r.int(0, 4)).map(m => withRoll(r, m))
  return { name: `${r.pick(V.tablet_first)} ${r.pick(V.tablet_second)}`, prefix: r.pick(V.magic_prefix), suffix: r.pick(V.magic_suffix),
    type, rarity: r.pick(RAR), uses: r.int(1, 18), mods, price: price(r) }
}

function randomWaystoneSettings(r) {
  const s = structuredClone(defaults.waystone)
  if (r.chance(.4)) s.rarity = { normal: r.chance(.4), magic: r.chance(.4), rare: r.chance(.6) }
  if (r.chance(.6)) { const a = r.int(1, 16), b = r.int(1, 16); s.tier = { min: Math.min(a, b), max: Math.max(a, b) } }
  if (r.chance(.3)) { const a = r.int(0, 6), b = r.int(0, 6); s.revives = { min: Math.min(a, b), max: Math.max(a, b) } }
  if (r.chance(.4)) s.state = { corrupted: r.chance(.4), uncorrupted: r.chance(.3), delirious: r.chance(.3) }
  for (const k of ['itemRarity', 'dropChance', 'monsterEffect', 'monsterRarity', 'packSize']) if (r.chance(.25)) s[k] = r.pick([1, 5, 9, 10, 11, 19, 20, 25, 55, 99, 100, 101, 150])
  s.round10 = r.chance(.3)
  s.wantMode = r.pick(['any', 'all'])
  if (r.chance(.5)) s.want = r.sample(WMODS, r.int(1, 3)).map(m => ({ id: m.id, min: m.num && r.chance(.5) ? r.int(1, 99) : 0 }))
  if (r.chance(.3)) s.avoid = r.sample(WMODS.filter(m => !s.want.some(w => w.id === m.id)), r.int(1, 3)).map(m => m.id)
  if (r.chance(.3)) { const a = r.int(0, 999), b = r.int(0, 999); s.price = { on: true, trade: false, min: Math.min(a, b), max: Math.max(a, b), currency: r.pick(CUR) } }
  return s
}

function randomTabletSettings(r) {
  const s = structuredClone(defaults.tablet)
  if (r.chance(.4)) s.rarity = { normal: r.chance(.4), magic: r.chance(.5), rare: r.chance(.3) }
  if (r.chance(.5)) for (const k of TYPE_KEYS) s.type[k] = r.chance(.35)
  if (r.chance(.4)) s.uses = r.int(1, 18)
  s.round10 = r.chance(.3)
  s.wantMode = r.pick(['any', 'all'])
  if (r.chance(.6)) s.want = r.sample(TMODS, r.int(1, 3)).map(m => ({ id: m.id, min: m.num && r.chance(.5) ? r.int(1, 99) : 0 }))
  if (r.chance(.3)) { const a = r.int(0, 999), b = r.int(0, 999); s.price = { on: true, trade: false, min: Math.min(a, b), max: Math.max(a, b), currency: r.pick(CUR) } }
  return s
}

// ---------------------------------------------------------------- the oracles
const floor10 = (n) => Math.floor(n / 10) * 10
const atLeast = (v, min, round10) => v >= (round10 ? floor10(min) : min)
const rarityOk = (sel, r) => { const on = RAR.filter(k => sel[k]); return on.length === 0 || on.length === 3 || on.includes(r) }
const canMin = (m) => !!m.num
const modOk = (it, sel, round10) => { const m = it.mods.find(x => x.id === sel.id); return !!m && (!(sel.min > 0) || !canMin(m) || atLeast(m.rolls[0], sel.min, round10)) }
const wantOk = (it, s) => { const known = s.want.filter(w => w.id); return !known.length || (s.wantMode === 'all' ? known.every(w => modOk(it, w, s.round10)) : known.some(w => modOk(it, w, s.round10))) }
const priceOk = (it, p) => !p.on || (!!it.price && it.price.cur === p.currency && it.price.n >= p.min && it.price.n <= p.max)   // 2.5 reads as 2

function waystoneOracle(it, s) {
  if (!rarityOk(s.rarity, it.rarity)) return false
  const { min, max } = s.tier
  if (min <= max && !(min <= 1 && max === 16) && (it.tier < min || it.tier > max)) return false
  const rv = s.revives
  if (rv.min <= rv.max && !(rv.min <= 0 && rv.max === 6) && (it.revives < rv.min || it.revives > rv.max)) return false
  if (s.state.corrupted && !s.state.uncorrupted && !it.corrupted) return false
  if (s.state.uncorrupted && !s.state.corrupted && it.corrupted) return false
  if (s.state.delirious && !it.delirious) return false
  const yields = [['itemRarity', 'iir'], ['dropChance', 'drop'], ['monsterEffect', 'eff'], ['monsterRarity', 'mrar'], ['packSize', 'pack']]
  for (const [k, f] of yields) if (s[k] > 0 && !atLeast(it[f], s[k], s.round10)) return false
  if (!wantOk(it, s)) return false
  if (s.avoid.some(id => it.mods.some(m => m.id === id))) return false
  return priceOk(it, s.price)
}

function tabletOracle(it, s) {
  if (!rarityOk(s.rarity, it.rarity)) return false
  const on = TYPE_KEYS.filter(k => s.type[k])
  if (on.length && on.length < TYPE_KEYS.length && !on.includes(it.type)) return false
  if (s.uses >= 1 && s.uses <= 18 && it.uses < s.uses) return false
  if (!wantOk(it, s)) return false
  return priceOk(it, s.price)
}

// ---------------------------------------------------------------- the checks
const KIT = { waystone: { table: WTABLE, render: renderWaystone, oracle: waystoneOracle }, tablet: { table: TTABLE, render: renderTablet, oracle: tabletOracle } }
function check(kind, s, it, label) {
  const { table, render, oracle } = KIT[kind]
  const str = generate(kind, s, table)
  const want = oracle(it, s)
  const got = search(str, render(it))
  if (got !== want) assert.equal(got, want, `${label}\n  settings ${JSON.stringify(s)}\n  string   ${str}\n  tooltip\n${render(it).split('\n').map(l => '    ' + l).join('\n')}`)
  assert.equal((str.match(/"/g) || []).length % 2, 0, `unbalanced quotes: ${str}`)
  assert.equal(str, str.trim(), `stray whitespace: [${str}]`)
  assert.equal(/  /.test(str), false, `double space: [${str}]`)
  return str
}
const S = (kind, over = {}) => ({ ...structuredClone(defaults[kind]), ...over })

test('the string is a pure function of the settings', () => {
  const r = rng(0)
  for (let i = 0; i < 50; i++) {
    const w = randomWaystoneSettings(r), t = randomTabletSettings(r)
    assert.equal(generate('waystone', w, WTABLE), generate('waystone', w, WTABLE))
    assert.equal(generate('tablet', t, TTABLE), generate('tablet', t, TTABLE))
  }
})

test('the tooltip model agrees with the stoplist the tokens were computed against', () => {
  const r = rng(1)
  const bare = (l) => l.replace(/#/g, '1').replace(/[+-]?\d+/g, '').replace(/\s+/g, ' ').trim()
  const fixed = new Set(STOP.map(bare))
  const lines = renderWaystone({ ...randomWaystone(r), mods: [], price: { n: 5, cur: 'exalted' }, corrupted: true, delirious: true }).split('\n')
    .concat(...Object.keys(TABLET_BASE).map(type => renderTablet({ ...randomTablet(r), type, mods: [], price: { n: 5, cur: 'divine' } }).split('\n')))
  for (const line of lines) {
    if (line === '--------' || NAME_POOL.includes(line)) continue
    assert.ok(fixed.has(bare(line)), `tooltip line "${line}" is not in tooltip-lines.json`)
  }
})

test('waystone: every tier pair against every tier', () => {
  const r = rng(2)
  const items = Array.from({ length: 16 }, (_, i) => ({ ...randomWaystone(r), tier: i + 1, mods: [], price: null }))
  for (let min = 1; min <= 16; min++) for (let max = min; max <= 16; max++) {
    const s = S('waystone', { tier: { min, max } })
    for (const it of items) check('waystone', s, it, `tier ${min}-${max} vs ${it.tier}`)
  }
})

test('waystone: every revive pair against every revive count', () => {
  const r = rng(3)
  const items = Array.from({ length: 7 }, (_, i) => ({ ...randomWaystone(r), revives: i, mods: [], price: null }))
  for (let min = 0; min <= 6; min++) for (let max = min; max <= 6; max++) {
    const s = S('waystone', { revives: { min, max } })
    for (const it of items) check('waystone', s, it, `revives ${min}-${max} vs ${it.revives}`)
  }
})

test('waystone: every rarity subset and every state combination', () => {
  const r = rng(4)
  for (let bits = 0; bits < 8; bits++) {
    const s = S('waystone', { rarity: { normal: !!(bits & 1), magic: !!(bits & 2), rare: !!(bits & 4) } })
    for (const rarity of RAR) check('waystone', s, { ...randomWaystone(r), rarity, mods: [], price: null }, `rarity ${bits} vs ${rarity}`)
  }
  for (let bits = 0; bits < 8; bits++) {
    const s = S('waystone', { state: { corrupted: !!(bits & 1), uncorrupted: !!(bits & 2), delirious: !!(bits & 4) } })
    for (const corrupted of [false, true]) for (const delirious of [false, true])
      check('waystone', s, { ...randomWaystone(r), corrupted, delirious, mods: [], price: null }, `state ${bits} vs c=${corrupted} d=${delirious}`)
  }
})

test('waystone: every yield threshold at the digit boundaries, both rounding modes, against every boundary value', () => {
  const r = rng(5)
  const values = [0, 1, 4, 5, 9, 10, 11, 19, 20, 21, 25, 29, 30, 50, 55, 60, 99, 100, 101, 110, 149, 150]
  const keys = [['itemRarity', 'iir'], ['dropChance', 'drop'], ['monsterEffect', 'eff'], ['monsterRarity', 'mrar'], ['packSize', 'pack']]
  for (const [k, f] of keys) for (const round10 of [false, true]) for (const th of values) {
    const s = S('waystone', { [k]: th, round10 })
    for (const v of values) check('waystone', s, { ...randomWaystone(r), [f]: v, mods: [], price: null }, `${k}>=${th} r10=${round10} vs ${v}`)
  }
})

test('waystone: every mod alone, wanted and avoided, against items carrying it and not', () => {
  const r = rng(6)
  for (const m of WMODS) {
    const withIt = { ...randomWaystone(r), mods: [withRoll(r, m)], price: null }
    const others = WMODS.filter(x => x.id !== m.id)
    const without = { ...randomWaystone(r), mods: r.sample(others, 5).map(x => withRoll(r, x)), price: null }
    const every = { ...randomWaystone(r), mods: others.map(x => withRoll(r, x)), price: null }
    for (const mode of ['any', 'all']) for (let form = 0; form < m.forms; form++) {
      const s = S('waystone', { want: [{ id: m.id, min: 0 }], wantMode: mode })
      for (const it of [{ ...withIt, mods: [{ ...withIt.mods[0], form }] }, without, every]) check('waystone', s, it, `want ${m.text} form ${form}`)
    }
    const s = S('waystone', { avoid: [m.id] })
    for (const it of [withIt, without, every]) check('waystone', s, it, `avoid ${m.text}`)
  }
})

test('waystone: a wanted mod with a minimum, at the digit boundaries, both rounding modes', () => {
  const r = rng(7)
  const values = [1, 5, 9, 10, 11, 19, 20, 21, 45, 50, 99]
  for (const m of WMODS.filter(canMin)) for (const round10 of [false, true]) for (const min of [1, 9, 10, 15, 20, 45, 50]) {
    const s = S('waystone', { want: [{ id: m.id, min }], round10 })
    for (const v of values) check('waystone', s, { ...randomWaystone(r), mods: [{ ...m, rolls: [v], form: 0 }], price: null }, `${m.text} >= ${min} vs ${v}`)
  }
})

test('tablet: every type subset against every type, every uses value against every count', () => {
  const r = rng(8)
  const types = Object.keys(TABLET_BASE)
  for (let bits = 0; bits < 1 << TYPE_KEYS.length; bits++) {
    const s = S('tablet')
    TYPE_KEYS.forEach((k, i) => { s.type[k] = !!(bits & (1 << i)) })
    for (const type of types) check('tablet', s, { ...randomTablet(r), type, mods: [], price: null }, `type ${bits} vs ${type}`)
  }
  for (let n = 0; n <= 18; n++) for (let uses = 1; uses <= 18; uses++)
    check('tablet', S('tablet', { uses: n }), { ...randomTablet(r), uses, mods: [], price: null }, `uses>=${n} vs ${uses}`)
})

test('tablet: every mod alone, wanted, on the tablet types it rolls on and off them', () => {
  const r = rng(9)
  for (const m of TMODS) {
    const type = m.type === 'any' ? 'irradiated' : m.type
    for (let form = 0; form < m.forms; form++) {
    const withIt = { ...randomTablet(r), type, mods: [{ ...withRoll(r, m), form }], price: null }
    const pool = TMODS.filter(x => x.id !== m.id && (x.type === 'any' || x.type === type))
    const without = { ...randomTablet(r), type, mods: r.sample(pool, 4).map(x => withRoll(r, x)), price: null }
    const every = { ...randomTablet(r), type, mods: pool.map(x => withRoll(r, x)), price: null }
    for (const mode of ['any', 'all']) {
      const s = S('tablet', { want: [{ id: m.id, min: 0 }], wantMode: mode })
      for (const it of [withIt, without, every]) check('tablet', s, it, `want ${m.text}`)
    }
    }
  }
})

test('price: every currency, both kinds, ranges at the digit boundaries against notes at the boundaries', () => {
  const r = rng(10)
  const edges = [0, 1, 9, 10, 11, 99, 100, 101, 250, 999]
  for (const currency of CUR) for (const min of edges) for (const max of edges) {
    if (max < min) continue
    for (const n of edges) for (const cur of CUR) {
      const price = { on: true, trade: false, min, max, currency }
      check('waystone', S('waystone', { price }), { ...randomWaystone(r), mods: [], price: { n, cur } }, `price ${min}-${max} ${currency} vs ${n} ${cur}`)
      check('tablet', S('tablet', { price }), { ...randomTablet(r), mods: [], price: { n, cur } }, `price ${min}-${max} ${currency} vs ${n} ${cur}`)
    }
  }
})

test('fuzz: 4000 random waystone settings against random items', () => {
  const r = rng(11)
  for (let i = 0; i < 4000; i++) {
    const s = randomWaystoneSettings(r)
    for (let j = 0; j < 3; j++) check('waystone', s, randomWaystone(r), `fuzz waystone #${i}.${j}`)
  }
})

test('fuzz: 4000 random tablet settings against random items', () => {
  const r = rng(12)
  for (let i = 0; i < 4000; i++) {
    const s = randomTabletSettings(r)
    for (let j = 0; j < 3; j++) check('tablet', s, randomTablet(r), `fuzz tablet #${i}.${j}`)
  }
})

test('fuzz: the string is reported over the limit, never cut, and Round to tens only ever shortens', () => {
  const r = rng(13)
  let over = 0, saved = 0
  for (let i = 0; i < 2000; i++) {
    const s = randomWaystoneSettings(r)
    s.want = r.sample(WMODS, r.int(3, 8)).map(m => ({ id: m.id, min: m.num ? r.int(11, 99) : 0 }))
    s.avoid = r.sample(WMODS.filter(m => !s.want.some(w => w.id === m.id)), r.int(2, 6)).map(m => m.id)
    const loose = generate('waystone', { ...s, round10: false }, WTABLE)
    const tight = generate('waystone', { ...s, round10: true }, WTABLE)
    // Rounding shortens a number's pattern except at one edge (89 → 80 is "(89|9.|\d..)" →
    // "([8-9].|\d..)", one character more), so the bound is one character per rounded number.
    const numbers = s.want.filter(w => w.min > 0).length + ['itemRarity', 'dropChance', 'monsterEffect', 'monsterRarity', 'packSize'].filter(k => s[k] > 0).length
    assert.ok(tight.length <= loose.length + numbers, `round10 lengthened the string:\n${loose}\n${tight}`)
    saved += loose.length - tight.length
    assert.equal(overLimit(loose), loose.length > LIMIT)
    if (overLimit(loose)) over++
    assert.equal(loose.endsWith('"') || /[^\s"]$/.test(loose), true, 'a string ends on a whole term')
  }
  assert.ok(over > 0, 'the fuzz never reached the limit; it is not stressing the string')
  assert.ok(saved > 2000 * 5, `Round to tens saved only ${saved} characters over 2000 strings`)
})

test('fuzz: appended text is carried verbatim at the end', () => {
  const r = rng(14)
  for (let i = 0; i < 200; i++) {
    const s = { ...randomWaystoneSettings(r), append: `"^${r.pick(V.waystone_first).toLowerCase()}"` }
    const str = generate('waystone', s, WTABLE)
    assert.ok(str.endsWith(s.append), str)
  }
})

test('a waystone string never keeps a tablet, and a tablet string never keeps a waystone', () => {
  const r = rng(15)
  for (let i = 0; i < 1500; i++) {
    const w = randomWaystoneSettings(r), t = randomTabletSettings(r)
    const ws = generate('waystone', w, WTABLE), ts = generate('tablet', t, TTABLE)
    if (ws) for (let j = 0; j < 3; j++) { const it = randomTablet(r); assert.equal(search(ws, renderTablet(it)), false, `waystone string kept a tablet:\n  ${ws}\n${renderTablet(it)}`) }
    if (ts) for (let j = 0; j < 3; j++) { const it = randomWaystone(r); assert.equal(search(ts, renderWaystone(it)), false, `tablet string kept a waystone:\n  ${ts}\n${renderWaystone(it)}`) }
  }
})

test('a fractional price note reads by its whole part', () => {
  const r = rng(16)
  for (const [min, max, n, frac, want] of [[1, 25, 2, '.5', true], [1, 2, 2, '.5', true], [1, 9, 12, '.5', false], [3, 9, 2, '.9', false], [0, 999, 999, '.9', true]]) {
    const s = S('waystone', { price: { on: true, trade: false, min, max, currency: 'exalted' } })
    check('waystone', s, { ...randomWaystone(r), mods: [], price: { n, frac, cur: 'exalted' } }, `price ${min}-${max} vs ${n}${frac}`)
    assert.equal(waystoneOracle({ ...randomWaystone(r), mods: [], price: { n, frac, cur: 'exalted' } }, s), want)
  }
})
