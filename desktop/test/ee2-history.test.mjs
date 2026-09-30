// Pure tests of the EE2 history consumer (desktop/src/ee2-history/index.js): the actions layer between the
// package's item-checked events and the renderer's ingest(). Worker + window + telemetry are injected.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createHistoryConsumer, NO_WINDOW_BUFFER, RESTART_MIN_MS } = require('../src/ee2-history/index.js')

const RAW = 'Item Class: Belts\nRarity: Unique\nHeadhunter\nHeavy Belt\n--------\n+41 to maximum Life\n'
function harness({ build, enabled = true, hasWindow = true, now } = {}) {
  const pkg = new EventEmitter()
  const sent = [], lines = [], spawns = []
  let t = 1_000_000
  const clock = now || (() => t)
  const worker = {
    spawn() { spawns.push(clock()); return { build: build || (async (raw, prefs) => ({ q: '{"query":{}}', name: 'Headhunter', item: { name: 'Headhunter', baseType: 'Heavy Belt', rarity: 'Unique', itemClass: 'Belts' }, host: 'www.pathofexile.com', buildMs: 5 })), kill() {} } },
  }
  const c = createHistoryConsumer({
    manager: pkg, worker, prefs: () => ({ prefs: { leagueId: 'Forbidden Rites', language: 'en' }, source: 'ee2' }),
    send: hasWindow ? (ch, p) => sent.push([ch, p]) : null, log: (l) => lines.push(l), now: clock,
  })
  c.setEnabled(enabled)
  return { pkg, sent, lines, spawns, c, tick: (ms) => { t += ms } }
}
const item = (origin = 'ee2', raw = RAW) => ({ name: 'Headhunter', baseType: 'Heavy Belt', rarity: 'Unique', itemClass: 'Belts', origin, raw, ts: 1 })

test('any origin is accepted; the intent carries no raw text; telemetry lines are emitted', async () => {
  const h = harness()
  h.pkg.emit('item-checked', item('clipboard'))
  h.pkg.emit('item-checked', item('ee2'))
  await new Promise(r => setTimeout(r, 10))
  assert.equal(h.sent.length, 2)
  const [ch, intent] = h.sent[0]
  assert.equal(ch, 'trade:ingest'); assert.equal(intent.source, 'ee2'); assert.equal(intent.origin, 'clipboard'); assert.equal(intent.folder, 'ee2-history')
  assert.equal(intent.q, '{"query":{}}'); assert.equal(intent.name, 'Headhunter'); assert.equal(intent.cfgLeague, 'Forbidden Rites')
  const s = JSON.stringify(intent)
  assert.ok(!('raw' in intent) && !s.includes('maximum Life') && !s.includes('Item Class'))
  assert.ok(h.lines.some(l => l.startsWith('history-build origin=clipboard rarity=Unique name="Headhunter"')))
})

test('currency is skipped without an intent; other errors produce a degraded intent', async () => {
  const h = harness({ build: async () => ({ error: { stage: 'currency', message: 'bulk' } }) })
  h.pkg.emit('item-checked', item()); await new Promise(r => setTimeout(r, 10))
  assert.equal(h.sent.length, 0); assert.ok(h.lines.some(l => l === 'history-skip reason=currency origin=ee2'))
  const h2 = harness({ build: async () => ({ error: { stage: 'parse', message: 'item.unknown' } }) })
  h2.pkg.emit('item-checked', item()); await new Promise(r => setTimeout(r, 10))
  assert.equal(h2.sent.length, 1); assert.equal(h2.sent[0][1].degraded, true); assert.equal(h2.sent[0][1].stage, 'parse'); assert.equal(h2.sent[0][1].q, null)
  assert.ok(h2.lines.some(l => l.startsWith('history-degraded stage=parse')))
})

test('disabled: never spawns the worker, logs a skip', async () => {
  const h = harness({ enabled: false })
  h.pkg.emit('item-checked', item()); await new Promise(r => setTimeout(r, 10))
  assert.equal(h.spawns.length, 0); assert.equal(h.sent.length, 0)
  assert.ok(h.lines.some(l => l === 'history-skip reason=disabled origin=ee2'))
})

test('no window: intents are held (≤ 20) and flushed when a window appears; overflow is dropped', async () => {
  const h = harness({ hasWindow: false })
  for (let i = 0; i < NO_WINDOW_BUFFER + 3; i++) { h.pkg.emit('item-checked', item()); await new Promise(r => setTimeout(r, 1)) }
  await new Promise(r => setTimeout(r, 10))
  assert.equal(h.lines.filter(l => l === 'ingest-drop reason=no-window').length, 3)
  const sent = []
  h.c.setSender((ch, p) => sent.push([ch, p]))
  assert.equal(sent.length, NO_WINDOW_BUFFER)
})

test('worker failure: in-flight item skipped, restart at most once per 5 minutes', async () => {
  let calls = 0
  const h = harness({ build: async () => { calls++; throw new Error('worker died') } })
  h.pkg.emit('item-checked', item()); await new Promise(r => setTimeout(r, 10))
  assert.ok(h.lines.some(l => l.startsWith('history-skip reason=worker origin=ee2 err="worker died"')))
  assert.equal(h.spawns.length, 1)
  h.pkg.emit('item-checked', item()); await new Promise(r => setTimeout(r, 10))
  assert.equal(h.spawns.length, 1, 'no restart within 5 min')
  h.tick(RESTART_MIN_MS + 1)
  h.pkg.emit('item-checked', item()); await new Promise(r => setTimeout(r, 10))
  assert.equal(h.spawns.length, 2, 'restarted after the window')
})

test('warm-if-running: warmed only when the package reports EE2 running', () => {
  const h = harness()
  h.pkg.emit('ee2-detected', { present: true, running: false }); assert.equal(h.spawns.length, 0)
  h.pkg.emit('ee2-detected', { present: true, running: true }); assert.equal(h.spawns.length, 1)
  assert.ok(h.lines.some(l => l.startsWith('history-attached cfg=ok')))
})

test('buildIntent (clipboard paste): folder null, source clipboard, currency → null, no raw', async () => {
  const h = harness()
  const intent = await h.c.buildIntent(RAW, 'clipboard')
  assert.equal(intent.source, 'clipboard'); assert.equal(intent.folder, null); assert.equal(intent.q, '{"query":{}}'); assert.ok(!('raw' in intent))
  const h2 = harness({ build: async () => ({ error: { stage: 'currency' } }) })
  assert.equal(await h2.c.buildIntent(RAW, 'clipboard'), null)
  const h3 = harness({ enabled: false })
  assert.ok(await h3.c.buildIntent(RAW, 'clipboard'), 'paste works even when the automatic stream is off')
})

test('rate-budget hint: an EE2-originated price check spends one trade-fetch slot; clipboard copies do not', async () => {
  const hints = []
  const pkg = new EventEmitter()
  const c = createHistoryConsumer({ manager: pkg, worker: { spawn: () => ({ build: async () => ({ q: '{}', name: 'x', item: {} }) }) }, prefs: () => ({ prefs: {}, source: 'default' }), send: () => {}, log: () => {}, hint: (p) => hints.push(p) })
  pkg.emit('item-checked', item('ee2')); pkg.emit('item-checked', item('clipboard'))
  await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(hints, ['trade-fetch'])
  c.stop()
})

test('worker-host maps an app.asar path to its unpacked twin (the worker and vendor are asarUnpack\'ed)', async () => {
  const { unpacked } = require('../src/ee2-history/worker-host.js')
  assert.equal(unpacked('/Applications/Arbiter.app/Contents/Resources/app.asar/src/ee2-history/worker.js'), '/Applications/Arbiter.app/Contents/Resources/app.asar.unpacked/src/ee2-history/worker.js')
  assert.equal(unpacked('C:\\Users\\x\\AppData\\Local\\Programs\\Arbiter\\resources\\app.asar\\src\\ee2-history\\worker.js'), 'C:\\Users\\x\\AppData\\Local\\Programs\\Arbiter\\resources\\app.asar.unpacked\\src\\ee2-history\\worker.js')
  assert.equal(unpacked('/dev/desktop/src/ee2-history/worker.js'), '/dev/desktop/src/ee2-history/worker.js')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.build.asarUnpack.includes('src/ee2-history/**') && pkg.build.asarUnpack.includes('src/vendor/ee2-query/**'))
})


test('parseItem: the parse crosses as { item, reason }; a worker error, a timeout and no worker are told apart from "not an item"', async () => {
  const parses = []
  const mk = (parse) => {
    const pkg = new EventEmitter()
    const worker = { spawn() { return { build: async () => ({ q: '{}', name: 'x', item: {}, host: '', buildMs: 1 }), parse, kill() {} } } }
    return createHistoryConsumer({ manager: pkg, worker, prefs: () => ({ prefs: { leagueId: 'L', language: 'en' }, source: 'ee2' }), send: () => {}, log: (l) => parses.push(l), now: () => 1 })
  }
  const item = { baseType: 'Gold Ring', rarity: 'Rare', itemLevel: 80, mods: [] }
  assert.deepEqual(await mk(async () => item).parseItem(RAW), { item, reason: null })
  assert.deepEqual(await mk(async () => null).parseItem('hello'), { item: null, reason: 'not-item' })
  assert.deepEqual(await mk(async () => ({ error: { stage: 'parse', message: 'boom' } })).parseItem(RAW), { item: null, reason: 'worker' })
  assert.deepEqual(await mk(async () => { throw new Error('build timeout') }).parseItem(RAW), { item: null, reason: 'timeout' })
  assert.deepEqual(await mk(async () => { throw new Error('worker exited') }).parseItem(RAW), { item: null, reason: 'worker' })
  const noParse = mk(undefined)
  assert.deepEqual(await noParse.parseItem(RAW), { item: null, reason: 'worker' })
  assert.ok(parses.some(l => l.startsWith('mods-parse-skip reason=timeout')) && parses.some(l => l.startsWith('mods-parse-skip reason=worker')))
})

test('onBuilt sees every built intent, from the automatic stream and from the clipboard rung, never a degraded one', async () => {
  const built = []
  const pkg = new EventEmitter()
  let fail = false
  const worker = { spawn() { return { build: async () => (fail ? { error: { stage: 'parse', message: 'x' } } : { q: '{"query":{}}', name: 'Headhunter', item: { name: 'Headhunter', baseType: 'Heavy Belt', rarity: 'Unique', itemClass: 'Belts' }, host: 'www.pathofexile.com', buildMs: 5 }), kill() {} } } }
  const c = createHistoryConsumer({ manager: pkg, worker, prefs: () => ({ prefs: { leagueId: 'L', language: 'en' }, source: 'ee2' }), send: () => {}, onBuilt: (i) => built.push(i) })
  pkg.emit('item-checked', item('ee2'))
  await new Promise(r => setTimeout(r, 10))
  await c.buildIntent(RAW, 'clipboard')
  fail = true
  await c.buildIntent(RAW, 'clipboard')
  assert.deepEqual(built.map(i => [i.origin, i.q, i.cfgLeague]), [['ee2', '{"query":{}}', 'L'], ['clipboard', '{"query":{}}', 'L']])
})

test('a history search ticks what EE2 ticks by default: the EE2 settings pass through unchanged', async () => {
  // Owner, 2026-09-28: follow the boxes EE2 ticks before searching. EE2's window calls createPresets
  // with the same options the history passes (CheckedItem.vue), and the port matches createPresets
  // (its golden tests), so passing the user's EE2 settings through is EE2's default search.
  const given = []
  const worker = { spawn() { return { build: async (raw, pf) => { given.push(pf); return { q: '{"query":{}}', name: 'x', item: { name: 'x', baseType: 'b', rarity: 'Rare', itemClass: 'Boots' }, host: 'www.pathofexile.com', buildMs: 1 } }, kill() {} } } }
  for (const allSel of [false, true]) {
    const c = createHistoryConsumer({ manager: new EventEmitter(), worker, prefs: () => ({ prefs: { leagueId: 'L', language: 'en', defaultAllSelected: allSel }, source: 'ee2' }), send: () => {} })
    await c.buildIntent(RAW, 'clipboard')
  }
  assert.deepEqual(given.map(p => p.defaultAllSelected), [false, true])
})

test('beta lines say which EE2 settings the history read and how many filters each search ticks', async () => {
  // If EE2's window ticks more than the history does, these two lines tell whether the settings
  // were read differently (attached) or the search differs (build): counts and settings only.
  const lines = []
  const q = JSON.stringify({ query: { stats: [{ type: 'and', filters: [{ id: 'a', disabled: false }, { id: 'b', disabled: true }, { id: 'c' }] }] } })
  const worker = { spawn() { return { build: async () => ({ q, name: 'x', item: { name: 'x', baseType: 'b', rarity: 'Rare', itemClass: 'Boots' }, host: 'www.pathofexile.com', buildMs: 1 }), kill() {} } } }
  const mgr = new EventEmitter()
  const c = createHistoryConsumer({ manager: mgr, worker, log: (l) => lines.push(l), send: () => {},
    prefs: () => ({ prefs: { leagueId: 'L', language: 'en', defaultAllSelected: false, searchStatRange: 10, activateStockFilter: true }, source: 'ee2' }) })
  mgr.emit('ee2-detected', { present: true, running: false })
  await c.buildIntent(RAW, 'clipboard')
  const attached = lines.find(l => l.startsWith('history-attached'))
  assert.ok(/allSel=false range=10 stock=true/.test(attached), attached)
  const built = lines.find(l => l.startsWith('history-build'))
  assert.ok(/ on=2 off=1/.test(built), built)
})

test('waystone searches are refined by default ("Match waystone stats"); switching it off leaves EE2\'s search as built', async () => {
  const WAY = 'Item Class: Waystones\nRarity: Rare\nArid Vector\nWaystone (Tier 15)\n--------\nItem Rarity: +12% (augmented)\nPack Size: +29% (augmented)\nWaystone Drop Chance: +105% (augmented)\n--------\nCorrupted\n'
  const built = JSON.stringify({ query: { filters: { map_filters: { filters: { map_tier: { min: 15, max: 15 } } } } } })
  const worker = { spawn() { return { build: async () => ({ q: built, name: 'Arid Vector Waystone (Tier 15)', item: { name: 'Arid Vector', baseType: 'Waystone (Tier 15)', rarity: 'Rare', itemClass: 'Waystones' }, host: 'www.pathofexile.com', buildMs: 1 }), kill() {} } } }
  const lines = []
  const c = createHistoryConsumer({ manager: new EventEmitter(), worker, prefs: () => ({ prefs: { leagueId: 'L', language: 'en', searchStatRange: 10 }, source: 'ee2' }), send: () => {}, log: (l) => lines.push(l) })
  const on = await c.buildIntent(WAY, 'clipboard')
  assert.deepEqual(JSON.parse(on.q).query.filters.map_filters.filters.map_packsize, { min: 26 })
  assert.ok(lines.some(l => /history-build .*waystone=refined/.test(l)))
  c.setSearchPrefs({ waystoneStats: false })
  const off = await c.buildIntent(WAY, 'clipboard')
  assert.equal(off.q, built)
})
