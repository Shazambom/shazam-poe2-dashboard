// Strategy → Strat Calculator: named farming strats, each a session you can leave and resume, and
// each one's profit in divines per hour. Pure (frontend/src/lib/stratcalc.js); the view renders it.
//   * the timer is wall clock (a start stamp + the time already banked): it survives tab switches
//     and restarts, and only ONE strat runs at a time;
//   * costs: maps run × the price of a map, + for each tablet line, maps run × its slots ÷ that
//     tablet's full uses (the pipeline's table: 10 for normal tablets, a unique's own) × its price —
//     or one overridden total — + fixed one-off costs;
//   * loot is priced by the backend's table (divines per unit), unless a row carries its own price.
import test from 'node:test'
import assert from 'node:assert/strict'
const sc = await import('../src/lib/stratcalc.js')

const H = 3_600_000
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} ${a} ≉ ${b}`)
const mk = (doc, id, name, now = 0) => sc.newStrat(doc, { id, name, now })

// ---------------------------------------------------------------- strats (the sidebar)
test('a blank calculator has no strats; a new strat opens blank, named, with the common currencies ready', () => {
  const d0 = sc.blankDoc()
  assert.equal(d0.v, sc.VERSION)
  assert.deepEqual(d0.strats, [])
  assert.equal(d0.active, null)
  const d = mk(d0, 'a', 'Ritual chains', 100)
  assert.equal(d.active, 'a')
  const s = sc.activeStrat(d)
  assert.equal(s.name, 'Ritual chains')
  assert.deepEqual(s.timer, { startedAt: null, elapsedMs: 0 })
  assert.deepEqual(s.loot.map(r => r.cur), ['divine', 'exalted', 'chaos'])
  assert.ok(s.loot.every(r => r.qty === 0 && r.price == null))
  assert.deepEqual(s.maps, { count: 0, price: 0, cur: 'chaos' })
  assert.deepEqual(s.tablets, { lines: [] })
  assert.deepEqual(s.override, { on: false, amount: 0, cur: 'chaos' })
  assert.deepEqual(s.fixed, [])
  assert.equal(s.updatedAt, 100)
})

test('a new strat prices its costs in the currency last used for a cost', () => {
  let d = mk(sc.blankDoc(), 'a', 'A')
  d = sc.setCostCur(d, 'a', 'maps', 'exalted', 5)
  assert.equal(d.lastCur, 'exalted')
  const b = sc.activeStrat(mk(d, 'b', 'B'))
  assert.equal(b.maps.cur, 'exalted')
  assert.equal(sc.activeStrat(sc.addTablet(mk(d, 'b', 'B'), 'b', { id: 't1', now: 6 })).tablets.lines[0].cur, 'exalted', 'and a new tablet line')
  assert.equal(b.override.cur, 'exalted')
})

test('selecting a strat resumes it exactly as it was left', () => {
  let d = mk(mk(sc.blankDoc(), 'a', 'A'), 'b', 'B')
  d = sc.edit(d, 'a', s => ({ ...s, maps: { ...s.maps, count: 7 } }), 50)
  d = sc.select(d, 'b')
  assert.equal(sc.activeStrat(d).id, 'b')
  d = sc.select(d, 'a')
  assert.equal(sc.activeStrat(d).maps.count, 7)
  assert.equal(sc.select(d, 'nope').active, 'a', 'selecting a strat that is not there changes nothing')
})

test('an edit stamps the strat it touched, and only that one', () => {
  let d = mk(mk(sc.blankDoc(), 'a', 'A', 1), 'b', 'B', 2)
  d = sc.edit(d, 'a', s => ({ ...s, name: 'A2' }), 99)
  assert.equal(d.strats.find(s => s.id === 'a').updatedAt, 99)
  assert.equal(d.strats.find(s => s.id === 'b').updatedAt, 2)
})

test('only one strat runs: starting one pauses whichever was running', () => {
  let d = mk(mk(sc.blankDoc(), 'a', 'A'), 'b', 'B')
  d = sc.toggle(d, 'a', 1000)
  assert.ok(sc.running(d.strats.find(s => s.id === 'a').timer))
  d = sc.toggle(d, 'b', 4000)
  const a = d.strats.find(s => s.id === 'a'), b = d.strats.find(s => s.id === 'b')
  assert.ok(!sc.running(a.timer), 'a paused')
  assert.equal(a.timer.elapsedMs, 3000, 'a banked the time it ran')
  assert.ok(sc.running(b.timer))
  d = sc.toggle(d, 'b', 6000)
  assert.ok(d.strats.every(s => !sc.running(s.timer)), 'toggling the running one pauses it')
  assert.equal(d.strats.find(s => s.id === 'b').timer.elapsedMs, 2000)
})

test('rename keeps the strat and trims the name; a blank name keeps the old one', () => {
  let d = mk(sc.blankDoc(), 'a', 'A')
  d = sc.rename(d, 'a', '  Abyss tablets  ', 3)
  assert.equal(sc.activeStrat(d).name, 'Abyss tablets')
  assert.equal(sc.rename(d, 'a', '   ', 4).strats[0].name, 'Abyss tablets')
})

test('duplicate runs the same strat again: the setup carries over, the counts and the clock do not', () => {
  let d = mk(sc.blankDoc(), 'a', 'Ritual')
  d = sc.edit(d, 'a', s => ({
    ...s,
    timer: { startedAt: 500, elapsedMs: 9000 },
    loot: [...sc.setQty(s.loot, 'divine', 12), { cur: 'omen-of-light', name: null, qty: 3, price: 8 }],
    maps: { count: 35, price: 6, cur: 'chaos' },
    tablets: { lines: [line({ slots: 3, price: 24 })] },
    override: { on: true, amount: 140, cur: 'divine' },
    fixed: [{ cur: 'head-of-the-king', name: null, qty: 7, price: null }],
  }), 10)
  d = sc.duplicate(d, 'a', { id: 'b', now: 20 })
  const b = sc.activeStrat(d)
  assert.equal(b.id, 'b')
  assert.equal(b.name, 'Ritual 2')
  assert.deepEqual(b.timer, { startedAt: null, elapsedMs: 0 })
  assert.deepEqual(b.loot.map(r => [r.cur, r.qty, r.price]), [['divine', 0, null], ['exalted', 0, null], ['chaos', 0, null], ['omen-of-light', 0, 8]])
  assert.deepEqual(b.maps, { count: 0, price: 6, cur: 'chaos' })
  assert.deepEqual(b.tablets, { lines: [line({ slots: 3, price: 24 })] }, 'the tablet setup carries over')
  assert.deepEqual(b.override, { on: true, amount: 140, cur: 'divine' })
  assert.deepEqual(b.fixed, [{ cur: 'head-of-the-king', name: null, qty: 7, price: null }])
  assert.equal(d.strats.find(s => s.id === 'a').loot[0].qty, 12, 'the original is untouched')
  assert.equal(sc.activeStrat(sc.duplicate(d, 'b', { id: 'c', now: 30 })).name, 'Ritual 3', 'the next free number')
})

test('removing a strat opens the next most recent; restoring puts it back exactly', () => {
  let d = mk(mk(mk(sc.blankDoc(), 'a', 'A', 1), 'b', 'B', 2), 'c', 'C', 3)
  const before = d
  const { doc, removed } = sc.removeStrat(d, 'c')
  assert.deepEqual(doc.strats.map(s => s.id).sort(), ['a', 'b'])
  assert.equal(doc.active, 'b')
  const back = sc.restoreStrat(doc, removed)
  assert.deepEqual(back.strats.map(s => s.id).sort(), ['a', 'b', 'c'])
  assert.equal(back.active, 'c')
  assert.deepEqual(back.strats.find(s => s.id === 'c'), before.strats.find(s => s.id === 'c'))
  assert.equal(sc.removeStrat(sc.removeStrat(sc.removeStrat(d, 'a').doc, 'b').doc, 'c').doc.active, null)
})

// ---------------------------------------------------------------- the timer
test('the timer is wall clock: start stamps, stop banks, a restart resumes from the stamp', () => {
  let t = sc.start({ startedAt: null, elapsedMs: 0 }, 1000)
  assert.equal(sc.elapsedMs(t, 6000), 5000)
  t = sc.stop(t, 6000)
  assert.deepEqual(t, { startedAt: null, elapsedMs: 5000 })
  assert.equal(sc.elapsedMs(t, 99_999_999), 5000, 'a stopped timer does not move')
  t = sc.start(t, 20_000)
  const reloaded = JSON.parse(JSON.stringify(t))
  assert.equal(sc.elapsedMs(reloaded, 22_000), 7000)
})

test('a clock running ahead of now (system clock moved back) never reads less than what was banked', () => {
  assert.equal(sc.elapsedMs({ startedAt: 10_000, elapsedMs: 300 }, 5_000), 300)
})

test('the clock reads h:mm:ss and keeps counting past a day', () => {
  assert.equal(sc.clock(0), '0:00:00')
  assert.equal(sc.clock(59_999), '0:00:59')
  assert.equal(sc.clock(H + 2 * 60_000 + 3000), '1:02:03')
  assert.equal(sc.clock(26 * H), '26:00:00')
})

test('the clock can be corrected: a running one keeps running from the new time', () => {
  assert.deepEqual(sc.setElapsed({ startedAt: null, elapsedMs: 9 }, H, 5000), { startedAt: null, elapsedMs: H })
  const t = sc.setElapsed({ startedAt: 0, elapsedMs: 0 }, H, 5000)
  assert.equal(sc.elapsedMs(t, 5000), H)
  assert.equal(sc.elapsedMs(t, 6000), H + 1000)
})

// ---------------------------------------------------------------- costs and the tally
const P = { divine: 1, exalted: 0.002, chaos: 0.125, 'omen-of-light': 8 }
const strat = (over = {}) => ({ ...sc.activeStrat(mk(sc.blankDoc(), 'a', 'A')), ...over })
// The pipeline's table (kv_ops `tablet_uses`, served with the prices): normal bases and uniques.
const USES = [{ name: null, base: 'Breach Tablet', uses: 10 }, { name: null, base: 'Ritual Tablet', uses: 10 },
  { name: 'Freedom of Faith', base: 'Ritual Tablet', uses: 5 }, { name: 'Mastered Domain', base: 'Irradiated Tablet', uses: 1 }]
const line = (o) => ({ id: 't', base: null, name: null, slots: 1, price: 0, cur: 'divine', ...o })
const TAB3 = { lines: [line({ slots: 3, price: 2 })] }        // three plain tablets a map at 2 div

test('maps cost maps run × the price of one; tablets cost maps run × slots ÷ full uses × the price of one', () => {
  const s = strat({
    timer: { startedAt: null, elapsedMs: 2 * H },
    maps: { count: 40, price: 4, cur: 'chaos' },          // 40 × 4c = 160c = 20 div
    tablets: TAB3,                                        // 40 × 3 ÷ 10 = 12 tablets × 2 div = 24 div
  })
  const t = sc.tally(s, P, 0, USES)
  near(t.maps, 20)
  near(t.tablets, 24)
  near(sc.tabletsUsed(s, USES), 12)
  near(t.costs, 44)
  near(t.net, -44)
  near(t.perHour, -22)
})

test('the override replaces the maps + tablets cost with one total; maps run no longer moves it', () => {
  const s = strat({
    timer: { startedAt: null, elapsedMs: H },
    maps: { count: 40, price: 4, cur: 'chaos' },
    tablets: TAB3,
    override: { on: true, amount: 30, cur: 'divine' },
  })
  const t = sc.tally(s, P, 0, USES)
  near(t.costs, 30)
  near(t.override, 30)
  assert.equal(t.maps, 0)
  assert.equal(t.tablets, 0)
  near(sc.tally({ ...s, maps: { ...s.maps, count: 99 } }, P, 0, USES).costs, 30)
  near(sc.tally({ ...s, override: { ...s.override, on: false } }, P, 0, USES).costs, 44, 'off again: the itemised costs are still there')
})

test('turning the override on starts it at the current calculated total, so the number does not jump', () => {
  const s = strat({ maps: { count: 40, price: 4, cur: 'chaos' }, tablets: TAB3,
    override: { on: false, amount: 0, cur: 'chaos' } })
  const o = sc.overrideOn(s, P, USES)
  assert.equal(o.override.on, true)
  near(o.override.amount, 44 / 0.125, 'the 44 div already counted, in the override currency (chaos)')
  near(sc.tally(o, P, 0, USES).costs, 44)
  assert.deepEqual(o.maps, s.maps, 'the itemised inputs are kept')
  const typed = { ...s, override: { on: false, amount: 12, cur: 'divine' } }
  assert.equal(sc.overrideOn(typed, P, USES).override.amount, 12, 'an amount already typed is kept')
})

test('fixed costs are currency × count, added to the costs', () => {
  const s = strat({ timer: { startedAt: null, elapsedMs: H }, fixed: [{ cur: 'divine', name: null, qty: 7, price: null }] })
  near(sc.tally(s, P, 0).fixed, 7)
  near(sc.tally(s, P, 0).costs, 7)
})

test('net divines per hour: loot minus every cost, over the hours on the clock', () => {
  const s = strat({
    timer: { startedAt: null, elapsedMs: 2 * H },
    loot: [{ cur: 'divine', name: null, qty: 10, price: null }, { cur: 'exalted', name: null, qty: 500, price: null },
      { cur: 'omen-of-light', name: null, qty: 2, price: null }],                       // 10 + 1 + 16 = 27
    maps: { count: 10, price: 8, cur: 'chaos' },                                        // 10 div
    tablets: { lines: [] },                                                             // 0
    fixed: [{ cur: 'chaos', name: null, qty: 8, price: null }],                         // 1
  })
  const t = sc.tally(s, P, 0)
  near(t.loot, 27)
  near(t.costs, 11)
  near(t.net, 16)
  near(t.perHour, 8)
  assert.deepEqual(t.unpriced, [])
})

test('a typed price beats the market; clearing it brings the market price back', () => {
  let loot = sc.setPrice(strat().loot, 'exalted', 0.005)
  loot = sc.setQty(loot, 'exalted', 200)
  near(sc.tally(strat({ loot }), P, 0).loot, 1)
  near(sc.tally(strat({ loot: sc.setPrice(loot, 'exalted', null) }), P, 0).loot, 0.4)
})

test('a custom item has a name and its own price; without a price it is named unpriced, never free', () => {
  let loot = sc.addCustom(strat().loot, "Rakiata's Flow", 196)
  loot = sc.setQty(loot, "custom:Rakiata's Flow", 2)
  near(sc.tally(strat({ loot }), P, 0).loot, 392)
  assert.equal(sc.addCustom(loot, " rakiata's flow ", 1), loot, 'the same name twice is one row')
  const bare = sc.setQty(sc.addCustom(strat().loot, 'Mystery Unique', null), 'custom:Mystery Unique', 1)
  const t = sc.tally(strat({ loot: bare }), P, 0)
  assert.equal(t.loot, 0)
  assert.deepEqual(t.unpriced, ['custom:Mystery Unique'])
})

test('a cost priced in a currency with no price is named unpriced and counts nothing', () => {
  const s = strat({ timer: { startedAt: null, elapsedMs: H }, maps: { count: 3, price: 2, cur: 'nope' } })
  const t = sc.tally(s, P, 0)
  assert.equal(t.maps, null, 'the line shows – rather than 0')
  assert.equal(t.costs, 0)
  assert.deepEqual(t.unpriced, ['nope'])
})

test('the rate waits for a minute on the clock; no time is no rate, not infinity', () => {
  const s = strat({ loot: sc.setQty(strat().loot, 'divine', 3) })
  assert.equal(sc.tally(s, P, 0).perHour, null)
  assert.equal(sc.tally({ ...s, timer: { startedAt: null, elapsedMs: sc.MIN_RATE_MS - 1 } }, P, 0).perHour, null)
  near(sc.tally({ ...s, timer: { startedAt: null, elapsedMs: sc.MIN_RATE_MS } }, P, 0).perHour, 180)
})

test('rows: a currency is added once, at zero; removing drops it', () => {
  const rows = strat().loot
  assert.equal(sc.addRow(rows, 'divine'), rows)
  assert.deepEqual(sc.addRow(rows, 'omen-of-light').at(-1), { cur: 'omen-of-light', name: null, qty: 0, price: null })
  assert.equal(sc.addRow(rows, ''), rows)
  assert.deepEqual(sc.removeRow(rows, 'divine').map(r => r.cur), ['exalted', 'chaos'])
})

// ---------------------------------------------------------------- tablet setups
// owner, 2026-10-01: "people don't always use the same tablets every time, sometimes they add in a
// unique tablet, sometimes they add in 2 or 3 kinds of tablets into the mix".
test('a tablet setup is lines; a map holds four tablets in all, so slots never pass four', () => {
  let d = mk(sc.blankDoc(), 'a', 'A')
  d = sc.addTablet(d, 'a', { id: 't1', now: 1 })
  assert.deepEqual(sc.activeStrat(d).tablets.lines, [line({ id: 't1', cur: 'chaos', slots: 1 })], 'a new line: one slot of any normal tablet')
  d = sc.editTablet(d, 'a', 't1', { slots: 9 }, 2)
  assert.equal(sc.activeStrat(d).tablets.lines[0].slots, 4)
  assert.equal(sc.addTablet(d, 'a', { id: 't2', now: 3 }), d, 'no free slot: no new line')
  d = sc.editTablet(d, 'a', 't1', { slots: 2 }, 4)
  d = sc.addTablet(d, 'a', { id: 't2', now: 5 })
  d = sc.editTablet(d, 'a', 't2', { slots: 4 }, 6)
  assert.deepEqual(sc.activeStrat(d).tablets.lines.map(l => l.slots), [2, 2], 'a line takes only the slots left')
  assert.equal(sc.tabletSlots(sc.activeStrat(d)), 4)
  d = sc.editTablet(d, 'a', 't2', { slots: 0 }, 7)
  assert.equal(sc.activeStrat(d).tablets.lines[1].slots, 1, 'a line holds at least one tablet')
  d = sc.editTablet(d, 'a', 't2', { name: 'Freedom of Faith', base: 'Ritual Tablet', price: 3, cur: 'divine' }, 8)
  assert.deepEqual(sc.activeStrat(d).tablets.lines[1], line({ id: 't2', name: 'Freedom of Faith', base: 'Ritual Tablet', price: 3 }))
  assert.equal(d.lastCur, 'divine', 'a tablet priced in a currency makes it the next default')
  assert.equal(sc.activeStrat(d).updatedAt, 8)
  d = sc.removeTablet(d, 'a', 't1', 9)
  assert.deepEqual(sc.activeStrat(d).tablets.lines.map(l => l.id), ['t2'])
})

test('each tablet spreads over its own full uses: normal 10, Freedom of Faith 5, Mastered Domain 1', () => {
  const s = strat({ maps: { count: 20, price: 0, cur: 'chaos' }, tablets: { lines: [
    line({ id: 'a', base: 'Breach Tablet', slots: 2, price: 1 }),                       // 20 × 2 ÷ 10 = 4 × 1 = 4
    line({ id: 'b', name: 'Freedom of Faith', base: 'Ritual Tablet', price: 2 }),       // 20 ÷ 5 = 4 × 2 = 8
    line({ id: 'c', name: 'Mastered Domain', base: 'Irradiated Tablet', price: 0.5 }),  // 20 ÷ 1 = 20 × 0.5 = 10
  ] } })
  near(sc.tally(s, P, 0, USES).tablets, 22)
  near(sc.tabletsUsed(s, USES), 4 + 4 + 20)
  assert.equal(sc.usesOf(line({ base: 'Ritual Tablet' }), USES), 10, 'a normal base')
  assert.equal(sc.usesOf(line({}), USES), 10, 'any normal tablet: every normal base agrees')
  assert.equal(sc.usesOf(line({ name: 'Freedom of Faith', base: 'Ritual Tablet' }), USES), 5)
})

test('a tablet whose full uses the data does not know is unpriced, never guessed', () => {
  const s = strat({ maps: { count: 20, price: 0, cur: 'chaos' }, tablets: { lines: [
    line({ id: 'a', slots: 2, price: 1 }), line({ id: 'b', name: 'Forgotten By Time', base: 'Expedition Tablet', price: 2 }),
  ] } })
  const t = sc.tally(s, P, 0, USES)
  near(t.tablets, 4, 'the known line still counts')
  assert.deepEqual(t.unpriced, ['tablet:Forgotten By Time'])
  assert.equal(sc.usesOf(line({}), []), null, 'no table yet: no number')
  assert.deepEqual(sc.tally(s, P, 0, []).unpriced, ['tablet:any', 'tablet:Forgotten By Time'])
  assert.equal(sc.usesOf(line({}), [...USES, { name: null, base: 'Odd Tablet', uses: 7 }]), null, 'bases that disagree: no single answer')
})

// ---------------------------------------------------------------- input: numbers, the clock, shortcuts
test('a number box takes what people type: decimals with a dot or a comma, thousands, k/m, and sums', () => {
  const cases = [['12', 12], ['1.5', 1.5], ['1,5', 1.5], ['0,25', 0.25], ['1,000', 1000], ['12,345,678', 12345678],
    [' 7 ', 7], ['3*12', 36], ['3 x 12', 36], ['10+5', 15], ['100-1', 99], ['10/4', 2.5], ['(2+3)*4', 20],
    ['40k', 40000], ['1.5k', 1500], ['2m', 2e6], ['.5', 0.5]]
  for (const [raw, want] of cases) assert.equal(sc.parseNum(raw), want, raw)
  for (const raw of ['', '  ', 'abc', '3*', '1/0', '-5', '2-3', '1e400', '((1)', '1..2', '5)']) assert.equal(sc.parseNum(raw), null, raw)
})

test('the clock takes a typed time: h:mm:ss, h:mm, 1h 20m, 90m, or bare minutes', () => {
  const cases = [['1:04:12', H + 4 * 60_000 + 12_000], ['1:30', 1.5 * H], ['0:45', 45 * 60_000], ['1h 20m', H + 20 * 60_000],
    ['2h', 2 * H], ['90m', 90 * 60_000], ['45', 45 * 60_000], ['1h20m30s', H + 20 * 60_000 + 30_000], ['1.5h', 1.5 * H]]
  for (const [raw, want] of cases) assert.equal(sc.parseDuration(raw), want, raw)
  for (const raw of ['', 'soon', '1:75', '-1h', '1:2:3:4']) assert.equal(sc.parseDuration(raw), null, raw)
})

test('shortcuts: Space starts or pauses, M counts a map, only when nothing is being typed or open', () => {
  const ctx = { typing: false, overlay: false }
  const key = (k, mods = {}) => ({ key: k, code: k === ' ' ? 'Space' : `Key${k.toUpperCase()}`, metaKey: false, ctrlKey: false, altKey: false, repeat: false, ...mods })
  assert.equal(sc.shortcut(key(' '), ctx), 'toggle')
  assert.equal(sc.shortcut(key('m'), ctx), 'map')
  assert.equal(sc.shortcut(key('M', { shiftKey: true }), ctx), 'map')
  assert.equal(sc.shortcut(key('x'), ctx), null)
  assert.equal(sc.shortcut(key(' '), { ...ctx, typing: true }), null, 'never while a box has the focus')
  assert.equal(sc.shortcut(key('m'), { ...ctx, overlay: true }), null, 'never under ⌘K, a menu or a dialog')
  for (const m of ['metaKey', 'ctrlKey', 'altKey']) assert.equal(sc.shortcut(key('m', { [m]: true }), ctx), null, `${m} passes through`)
  assert.equal(sc.shortcut(key(' ', { repeat: true }), ctx), null, 'holding Space does not flicker the clock')
})

test('what counts as typing: inputs, text areas, editable text and the currency search, not buttons', () => {
  assert.equal(sc.isTyping({ tagName: 'INPUT', type: 'text' }), true)
  assert.equal(sc.isTyping({ tagName: 'TEXTAREA' }), true)
  assert.equal(sc.isTyping({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(sc.isTyping({ tagName: 'BUTTON' }), false)
  assert.equal(sc.isTyping({ tagName: 'BODY' }), false)
  assert.equal(sc.isTyping(null), false)
})

// ---------------------------------------------------------------- what is stored
test('a strat saved before tablet setups loads as one plain line: same slots, same price, same cost', () => {
  const old = (tb) => sc.normalize({ v: sc.VERSION, strats: [{ id: 'a', name: 'A', maps: { count: 40, price: 0, cur: 'chaos' }, tablets: tb }] }).strats[0]
  const s = old({ perMap: 3, price: 2, cur: 'divine' })
  assert.deepEqual(s.tablets, { lines: [line({ id: 'tablets', slots: 3, price: 2 })] })
  near(sc.tally(s, P, 0, USES).tablets, 24, 'the number the user saw before')
  assert.deepEqual(old({ perMap: 0, price: 5, cur: 'divine' }).tablets, { lines: [] })
})

test('a stored calculator loads repaired: bad parts dropped, defaults filled, counts whole, one row per currency', () => {
  assert.deepEqual(sc.normalize(null), sc.blankDoc())
  assert.deepEqual(sc.normalize({ v: sc.VERSION + 1, strats: [{ id: 'x' }] }), sc.blankDoc(), 'another version opens blank')
  const d = sc.normalize({
    v: sc.VERSION, active: 'gone', lastCur: 'exalted',
    strats: [
      { id: 'a', name: 'A', updatedAt: 5, timer: { startedAt: 'x', elapsedMs: -3 },
        loot: [{ cur: 'divine', qty: 3.7 }, { cur: 'divine', qty: 9 }, { name: 'Unique', qty: 1, price: 2 }, { qty: 1 }, 'bad'],
        maps: { count: 2.5, price: 1.5, cur: 'chaos' }, tablets: { lines: [{ id: 'x', slots: 9, price: -1 }, { id: 'y', slots: 1, base: 'Ritual Tablet' }, 'bad', { slots: 1 }] } },
      { name: 'no id' },
      { id: 'a', name: 'dupe id' },
    ],
  })
  assert.equal(d.strats.length, 1)
  const s = d.strats[0]
  assert.equal(d.active, 'a', 'an open strat that is gone falls back to the most recent')
  assert.equal(d.lastCur, 'exalted')
  assert.deepEqual(s.timer, { startedAt: null, elapsedMs: 0 })
  assert.deepEqual(s.loot, [{ cur: 'divine', name: null, qty: 3, price: null }, { cur: null, name: 'Unique', qty: 1, price: 2 }])
  assert.deepEqual(s.maps, { count: 2, price: 1.5, cur: 'chaos' })
  assert.deepEqual(s.tablets, { lines: [line({ id: 'x', slots: 4, cur: 'exalted' })] }, 'slots cap at four in all; a line without an id is dropped')
  assert.deepEqual(s.override, { on: false, amount: 0, cur: 'exalted' })
  assert.deepEqual(s.fixed, [])
  const running = sc.normalize({ v: 1, strats: [{ id: 'a', name: 'A', timer: { startedAt: 1000, elapsedMs: 50 } }, { id: 'b', name: 'B', timer: { startedAt: 2000, elapsedMs: 0 } }] })
  assert.equal(running.strats.filter(x => sc.running(x.timer)).length, 1, 'two running strats load as one: the most recent start keeps running')
})

test('undoing a removed running strat while another runs keeps one clock: the restored one is paused', () => {
  let d = mk(mk(sc.blankDoc(), 'a', 'A'), 'b', 'B')
  d = sc.toggle(d, 'a', 1000)                     // a runs
  const { doc, removed } = sc.removeStrat(d, 'a')
  d = sc.toggle(doc, 'b', 5000)                   // b runs
  d = sc.restoreStrat(d, removed)
  assert.equal(d.strats.filter(s => sc.running(s.timer)).length, 1)
  assert.ok(sc.running(d.strats.find(s => s.id === 'b').timer), 'the one running now keeps running')
  assert.equal(d.strats.find(s => s.id === 'a').timer.elapsedMs, 4000, 'a banked its time up to when b started')
  const solo = sc.restoreStrat(sc.removeStrat(sc.toggle(mk(sc.blankDoc(), 'c', 'C'), 'c', 0), 'c').doc, sc.removeStrat(sc.toggle(mk(sc.blankDoc(), 'c', 'C'), 'c', 0), 'c').removed)
  assert.ok(sc.running(solo.strats[0].timer), 'with nothing else running, an undo puts it back running')
})

test('a new strat is named "Strat N", the next free number', () => {
  let d = sc.blankDoc()
  assert.equal(sc.nextName(d), 'Strat 1')
  d = mk(mk(d, 'a', 'Strat 1'), 'b', 'Ritual')
  assert.equal(sc.nextName(d), 'Strat 2')
  d = mk(d, 'c', 'Strat 3')
  assert.equal(sc.nextName(d), 'Strat 2', 'the first gap')
})

test('divine amounts read at a sensible precision: a few exalted is still more than zero', () => {
  assert.equal(sc.divDigits(0.0027), 3)
  assert.equal(sc.divDigits(0.37), 2)
  assert.equal(sc.divDigits(-4.2), 2)
  assert.equal(sc.divDigits(12.34), 1)
  assert.equal(sc.divDigits(-250), 0)
  assert.equal(sc.divDigits(0), 2)
})

// ---------------------------------------------------------------- uniques: a background trade search's price floor
test('a unique is a named row with its base; the same unique twice is one row', () => {
  let rows = sc.addUnique(strat().loot, { name: 'Mageblood', type: 'Utility Belt' })
  const u = rows.at(-1)
  assert.deepEqual(u, { cur: null, name: 'Mageblood', base: 'Utility Belt', qty: 0, price: null, floor: null })
  assert.equal(sc.rowKey(u), 'unique:Mageblood|Utility Belt')
  assert.equal(sc.addUnique(rows, { name: 'Mageblood', type: 'Utility Belt' }), rows)
  rows = sc.addUnique(rows, { name: 'Waistgate', type: 'Wide Belt' })
  rows = sc.addUnique(rows, { name: 'Waistgate', type: 'Heavy Belt' })
  assert.equal(rows.filter(r => r.name === 'Waistgate').length, 2, 'one name on two bases is two uniques')
})

test('the floor is the cheapest listing in divines; listings in an unpriced currency are skipped', () => {
  const P2 = { divine: 1, exalted: 0.002, chaos: 0.125 }
  assert.equal(sc.floorDiv([{ amount: 150, currency: 'divine' }, { amount: 70000, currency: 'exalted' }, { amount: 900, currency: 'chaos' }], P2), 112.5)
  assert.equal(sc.floorDiv([{ amount: 3, currency: 'mystery' }, { amount: 2, currency: 'divine' }], P2), 2)
  assert.equal(sc.floorDiv([], P2), null, 'nothing listed: no floor')
  assert.equal(sc.floorDiv([{ amount: 3, currency: 'mystery' }], P2), null)
})

test('a typed price beats the floor, and the floor beats nothing; with neither, the unique is unpriced', () => {
  const key = 'unique:Mageblood|Utility Belt'
  let loot = sc.setQty(sc.addUnique([], { name: 'Mageblood', type: 'Utility Belt' }), key, 1)
  assert.deepEqual(sc.tally(strat({ loot }), P, 0).unpriced, [key])
  loot = loot.map(r => ({ ...r, floor: { div: 140, at: 0 } }))
  near(sc.tally(strat({ loot }), P, 0).loot, 140)
  near(sc.tally(strat({ loot: sc.setPrice(loot, key, 120) }), P, 0).loot, 120)
})

test('a floor is searched for when there is none or it is over an hour old, never over a typed price', () => {
  const u = { cur: null, name: 'Mageblood', base: 'Utility Belt', qty: 1, price: null, floor: null }
  assert.equal(sc.needsFloor(u, 0), true)
  const T0 = 1_700_000_000_000                                   // floors are stamped with the clock
  assert.equal(sc.needsFloor({ ...u, floor: { div: 1, at: T0 } }, T0 + sc.FLOOR_TTL_MS - 1), false)
  assert.equal(sc.needsFloor({ ...u, floor: { div: 1, at: T0 } }, T0 + sc.FLOOR_TTL_MS), true)
  assert.equal(sc.needsFloor({ ...u, floor: { div: 1, at: 0 } }, T0), true, 'at 0: due now (⟳)')
  assert.equal(sc.needsFloor({ ...u, price: 99 }, 0), false, 'your price wins: no search')
  assert.equal(sc.needsFloor({ cur: 'divine', name: null, qty: 1, price: null }, 0), false, 'a currency is the market\'s')
  assert.equal(sc.FLOOR_TTL_MS, 3_600_000)
})

test('recording a found floor touches that one row and does not move the strat up the sidebar', () => {
  let d = mk(mk(sc.blankDoc(), 'a', 'A', 1), 'b', 'B', 2)
  d = sc.edit(d, 'a', s => ({ ...s, loot: sc.addUnique(s.loot, { name: 'Headhunter', type: 'Heavy Belt' }) }), 3)
  const r = sc.recordFloor(d, 'a', 'unique:Headhunter|Heavy Belt', 95, 5000)
  const a = r.strats.find(s => s.id === 'a')
  assert.deepEqual(a.loot.at(-1).floor, { div: 95, at: 5000 })
  assert.equal(a.updatedAt, 3, 'a background price is not an edit')
  assert.equal(sc.recordFloor(d, 'gone', 'x', 1, 1), d)
  for (const bad of [null, NaN, -1, Infinity]) assert.equal(sc.recordFloor(d, 'a', 'unique:Headhunter|Heavy Belt', bad, 5000), d, `no floor from ${bad}: a search that found nothing priced records nothing (fuzz, 2026-10-01)`)
})

test('a stored unique keeps its base and floor; a base on a currency row is dropped', () => {
  const d = sc.normalize({ v: 1, strats: [{ id: 'a', name: 'A', loot: [
    { cur: null, name: 'Mageblood', base: 'Utility Belt', qty: 1, price: null, floor: { div: 140, at: 9 } },
    { cur: null, name: 'Headhunter', base: 'Heavy Belt', qty: 1, floor: { div: -1, at: 9 } },
    { cur: 'divine', base: 'Ring', qty: 2 },
  ] }] })
  assert.deepEqual(d.strats[0].loot, [
    { cur: null, name: 'Mageblood', base: 'Utility Belt', qty: 1, price: null, floor: { div: 140, at: 9 } },
    { cur: null, name: 'Headhunter', base: 'Heavy Belt', qty: 1, price: null, floor: null },
    { cur: 'divine', name: null, qty: 2, price: null },
  ])
})

// ---------------------------------------------------------------- the time override
test('a new strat\'s time is the timer\'s; the time override starts off', () => {
  assert.deepEqual(strat().time, { on: false, ms: 0 })
})

test('the time override replaces the timer in the rate; the timer keeps its own time underneath', () => {
  const s = strat({ timer: { startedAt: null, elapsedMs: 4 * H }, loot: sc.setQty(strat().loot, 'divine', 12), time: { on: true, ms: 2 * H } })
  near(sc.tally(s, P, 0).hours, 2)
  near(sc.tally(s, P, 0).perHour, 6)
  near(sc.tally({ ...s, time: { ...s.time, on: false } }, P, 0).perHour, 3, 'off again: the timer\'s four hours')
  assert.equal(sc.tally({ ...s, time: { on: true, ms: 0 } }, P, 0).perHour, null, 'no time typed yet: no rate')
})

test('turning the time override on starts from the clock\'s time and pauses the timer', () => {
  const s = strat({ timer: { startedAt: 1000, elapsedMs: H } })
  const o = sc.timeOverrideOn(s, 1000 + 30 * 60_000)
  assert.deepEqual(o.time, { on: true, ms: 1.5 * H }, 'the time on the clock, so the rate does not jump')
  assert.deepEqual(o.timer, { startedAt: null, elapsedMs: 1.5 * H }, 'the timer is paused, its time banked')
  const typed = strat({ time: { on: false, ms: 3 * H } })
  assert.equal(sc.timeOverrideOn(typed, 0).time.ms, 3 * H, 'a time already typed is kept')
})

test('hours and minutes ↔ the override\'s time', () => {
  assert.deepEqual(sc.hm(H * 2 + 35 * 60_000), { h: 2, m: 35 })
  assert.deepEqual(sc.hm(59_999), { h: 0, m: 0 }, 'whole minutes')
  assert.equal(sc.fromHm(2, 35), H * 2 + 35 * 60_000)
  assert.equal(sc.fromHm(0, 90), 90 * 60_000, 'ninety minutes is fine as typed')
})

test('starting the timer while the time override is on turns the override off', () => {
  let d = mk(sc.blankDoc(), 'a', 'A')
  d = sc.edit(d, 'a', s => sc.timeOverrideOn(s, 0), 1)
  d = sc.toggle(d, 'a', 5000)
  const a = d.strats.find(s => s.id === 'a')
  assert.equal(a.time.on, false, 'you started the clock: the clock counts again')
  assert.ok(sc.running(a.timer))
})

test('a stored time override loads; a bad one loads off', () => {
  const ok = sc.normalize({ v: 1, strats: [{ id: 'a', name: 'A', time: { on: true, ms: 5400000 } }] })
  assert.deepEqual(ok.strats[0].time, { on: true, ms: 5400000 })
  const bad = sc.normalize({ v: 1, strats: [{ id: 'a', name: 'A', time: { on: 'yes', ms: -5 } }] })
  assert.deepEqual(bad.strats[0].time, { on: false, ms: 0 })
})

test('selecting the strat that is already open changes nothing (no save when you click its name)', () => {
  const d = mk(sc.blankDoc(), 'a', 'A')
  assert.equal(sc.select(d, 'a'), d)
})

// ---------------------------------------------------------------- folders: the sidebar's tree (like trade searches)
const ids = (tree) => tree.map(n => n.kind === 'folder' ? { [n.name]: ids(n.children) } : n.id)

test('every strat sits in the tree once: new strats go on top, a stored tree is reconciled with the strats', () => {
  let d = mk(mk(sc.blankDoc(), 'a', 'A'), 'b', 'B')
  assert.deepEqual(ids(d.tree), ['b', 'a'], 'newest on top')
  const raw = { ...d, tree: [{ id: 'f', kind: 'folder', name: 'Ritual', open: true, children: [{ id: 'a', kind: 'strat' }, { id: 'gone', kind: 'strat' }] }] }
  assert.deepEqual(ids(sc.normalize(raw).tree), ['b', { Ritual: ['a'] }], 'a strat missing from the tree comes back on top; a deleted one drops out')
})

test('folders: create on top, move strats in and out by drag, never a folder into itself', () => {
  let d = mk(mk(mk(sc.blankDoc(), 'a', 'A'), 'b', 'B'), 'c', 'C')
  d = sc.newFolder(d, { id: 'f', name: 'Breach' })
  assert.deepEqual(ids(d.tree), [{ Breach: [] }, 'c', 'b', 'a'])
  d = sc.moveNode(d, 'a', 'f', 0)
  d = sc.moveNode(d, 'c', 'f', 1)
  assert.deepEqual(ids(d.tree), [{ Breach: ['a', 'c'] }, 'b'])
  d = sc.moveNode(d, 'c', null, 0)
  assert.deepEqual(ids(d.tree), ['c', { Breach: ['a'] }, 'b'])
  d = sc.newFolder(d, { id: 'g', name: 'Inner' })
  d = sc.moveNode(d, 'g', 'f', 0)
  assert.deepEqual(ids(d.tree), ['c', { Breach: [{ Inner: [] }, 'a'] }, 'b'])
  assert.equal(sc.moveNode(d, 'f', 'g', 0), d, 'a folder never moves into its own folder')
  assert.equal(sc.moveNode(d, 'nope', null, 0), d)
})

test('a folder is renamed; removing it keeps its strats (they move up where it was) and can be undone', () => {
  let d = mk(mk(sc.blankDoc(), 'a', 'A'), 'b', 'B')
  d = sc.newFolder(d, { id: 'f', name: 'Breach' })
  d = sc.moveNode(sc.moveNode(d, 'a', 'f', 0), 'b', 'f', 1)
  d = sc.renameFolder(d, 'f', '  Breach farms ')
  assert.equal(d.tree[0].name, 'Breach farms')
  assert.equal(sc.renameFolder(d, 'f', '  ').tree[0].name, 'Breach farms')
  const { doc, removed } = sc.removeFolder(d, 'f')
  assert.deepEqual(ids(doc.tree), ['a', 'b'], 'its strats are kept, in its place')
  assert.equal(doc.strats.length, 2)
  assert.deepEqual(ids(sc.restoreFolder(doc, removed).tree), [{ 'Breach farms': ['a', 'b'] }])
})

test('a folder opens and closes; a new strat lands at the top; deleting a strat and undoing puts it back where it was', () => {
  let d = mk(sc.blankDoc(), 'a', 'A')
  d = sc.newFolder(d, { id: 'f', name: 'F' })
  d = sc.moveNode(d, 'a', 'f', 0)
  assert.equal(sc.setOpen(d, 'f', false).tree[0].open, false)
  d = mk(d, 'b', 'B')
  assert.deepEqual(ids(d.tree), ['b', { F: ['a'] }])
  const { doc, removed } = sc.removeStrat(d, 'a')
  assert.deepEqual(ids(doc.tree), ['b', { F: [] }])
  assert.deepEqual(ids(sc.restoreStrat(doc, removed).tree), ['b', { F: ['a'] }], 'back in its folder, at its place')
})

test('a duplicate lands right after the strat it copies, in the same folder', () => {
  let d = mk(mk(sc.blankDoc(), 'a', 'A'), 'b', 'B')
  d = sc.newFolder(d, { id: 'f', name: 'F' })
  d = sc.moveNode(sc.moveNode(d, 'a', 'f', 0), 'b', 'f', 1)
  d = sc.duplicate(d, 'a', { id: 'c', now: 5 })
  assert.deepEqual(ids(d.tree), [{ F: ['a', 'c', 'b'] }])
})

test('the tree\'s folders and every id in it, for the sidebar and its tests', () => {
  let d = mk(mk(sc.blankDoc(), 'a', 'A'), 'b', 'B')
  d = sc.moveNode(sc.newFolder(d, { id: 'f', name: 'F' }), 'a', 'f', 0)
  assert.deepEqual(sc.flattenFolders(d.tree).map(f => f.id), ['f'])
  assert.deepEqual(sc.treeIds(d.tree), ['f', 'a', 'b'])
})

test('deleting a folder with everything in it removes its strats too; one Undo brings all of it back', () => {
  let d = mk(mk(mk(sc.blankDoc(), 'a', 'A'), 'b', 'B'), 'c', 'C')
  d = sc.newFolder(d, { id: 'f', name: 'Breach' })
  d = sc.newFolder(d, { id: 'g', name: 'Inner' })
  d = sc.moveNode(sc.moveNode(sc.moveNode(d, 'g', 'f', 0), 'a', 'g', 0), 'b', 'f', 1)
  d = sc.select(d, 'a')
  const before = d
  const { doc, removed } = sc.removeFolderDeep(d, 'f')
  assert.deepEqual(doc.strats.map(s => s.id), ['c'], 'the strats inside (nested too) are gone')
  assert.deepEqual(ids(doc.tree), ['c'])
  assert.equal(doc.active, 'c', 'the open strat was inside: the next one opens')
  const back = sc.restoreFolderDeep(doc, removed)
  assert.deepEqual(ids(back.tree), ids(before.tree), 'the folder, its folders and its strats, in place')
  assert.deepEqual(back.strats.map(s => s.id).sort(), ['a', 'b', 'c'])
  assert.equal(back.active, 'a', 'and the strat that was open is open again')
  assert.deepEqual(sc.removeFolderDeep(d, 'nope'), { doc: d, removed: null })
})

test('undoing a deleted folder whose strat was running, after another started: one clock still', () => {
  let d = mk(mk(sc.blankDoc(), 'a', 'A'), 'b', 'B')
  d = sc.moveNode(sc.newFolder(d, { id: 'f', name: 'F' }), 'a', 'f', 0)
  d = sc.toggle(d, 'a', 1000)
  const { doc, removed } = sc.removeFolderDeep(d, 'f')
  d = sc.restoreFolderDeep(sc.toggle(doc, 'b', 5000), removed)
  assert.equal(d.strats.filter(s => sc.running(s.timer)).length, 1)
  assert.ok(sc.running(d.strats.find(s => s.id === 'b').timer))
  assert.equal(d.strats.find(s => s.id === 'a').timer.elapsedMs, 4000)
})

test('repro (review #1): a comma decimal with three digits is a decimal when it starts with 0', () => {
  assert.equal(sc.parseNum('0,005'), 0.005, 'was 5: a price typed the European way read 1000× too high')
  assert.equal(sc.parseNum('0,125'), 0.125)
  assert.equal(sc.parseNum('0,250k'), 250, 'k still multiplies')
  assert.equal(sc.parseNum('1,000'), 1000, 'a real thousands group is unchanged')
  assert.equal(sc.parseNum('12,345,678'), 12345678)
})

test('repro (review #2): nothing the view can do makes a document the backend refuses (names ≤ 120, rows ≤ 200, folders ≤ 8 deep)', () => {
  const long = 'x'.repeat(300)
  let d = mk(sc.blankDoc(), 'a', 'A')
  d = sc.rename(d, 'a', long, 1)
  assert.equal(sc.activeStrat(d).name.length, sc.MAX_NAME, 'a pasted name is cut to the limit')
  d = sc.rename(d, 'a', 'y'.repeat(119), 2)
  d = sc.duplicate(d, 'a', { id: 'b', now: 3 })
  assert.ok(sc.activeStrat(d).name.length <= sc.MAX_NAME, 'a copy of a long name stays within it ("… 2")')
  assert.ok(sc.activeStrat(d).name.endsWith(' 2'))
  d = sc.newFolder(d, { id: 'f0', name: long })
  d = sc.renameFolder(d, 'f0', long)
  assert.equal(d.tree[0].name.length, sc.MAX_NAME)
  assert.equal(sc.addCustom([], long, null)[0].name.length, sc.MAX_NAME)
  let rows = []
  for (let i = 0; i < sc.MAX_ROWS + 5; i++) rows = sc.addRow(rows, `c${i}`)
  assert.equal(rows.length, sc.MAX_ROWS, 'a list stops at the limit')
  assert.equal(sc.addCustom(rows, 'one more', null), rows)
  assert.equal(sc.addUnique(rows, { name: 'U', type: 'T' }), rows)
  for (let i = 1; i <= sc.MAX_DEPTH + 2; i++) { d = sc.newFolder(d, { id: `f${i}`, name: 'F' }); d = sc.moveNode(d, `f${i}`, `f${i - 1}`, 0) }
  const depth = (nodes, n = 0) => Math.max(n, ...nodes.filter(x => x.kind === 'folder').map(f => depth(f.children, n + 1)))
  assert.ok(depth(d.tree) <= sc.MAX_DEPTH, `folders stop at ${sc.MAX_DEPTH} deep (got ${depth(d.tree)})`)
})

test('repro (review #2): strats stop at the backend\'s 500, and a stored over-long folder name loads cut', () => {
  let d = sc.blankDoc()
  for (let i = 0; i < sc.MAX_STRATS + 3; i++) d = sc.newStrat(d, { id: `s${i}`, name: `S${i}`, now: i })
  assert.equal(d.strats.length, sc.MAX_STRATS)
  assert.equal(sc.duplicate(d, 's0', { id: 'extra', now: 9 }), d)
  const n = sc.normalize({ v: 1, strats: [{ id: 'a', name: 'A' }], tree: [{ id: 'f', kind: 'folder', name: 'q'.repeat(400), children: [] }] })
  assert.equal(n.tree.find(x => x.kind === 'folder').name.length, sc.MAX_NAME)
})

// ---------------------------------------------------------------- a linked trade search prices a tablet
// owner, 2026-10-01: a tablet line can carry a trade search built on the trade site ("Build on trade…");
// its price is the average of the cheapest 10 listings (owner: "avg the cheapest 10"), refreshed hourly,
// and a number the user types always wins ("the manual override of the price is good UI to keep").
const BREACH_Q = { query: { status: { option: 'securable' }, type: 'Breach Tablet', stats: [] }, sort: { price: 'asc' } }

test('linking a search puts it on the line and lets it price the line', () => {
  let d = mk(sc.blankDoc(), 'a', 'A')
  d = sc.addTablet(d, 'a', { id: 't1', now: 1 })
  d = sc.editTablet(d, 'a', 't1', { price: 3 }, 2)
  d = sc.linkTablet(d, 'a', 't1', { query: BREACH_Q, league: 'Forbidden Rites' }, 3)
  const l = sc.activeStrat(d).tablets.lines[0]
  assert.deepEqual(l.link, { query: BREACH_Q, league: 'Forbidden Rites', div: null, at: 0 })
  assert.equal(l.price, null, 'linking hands the price to the search')
  assert.equal(sc.needsLinkPrice(l, 10), true, 'never priced: search now')
  d = sc.recordLinkPrice(d, 'a', 't1', 0.4, 5000)
  assert.equal(sc.activeStrat(d).updatedAt, 3, 'a background price is not an edit')
  const priced = sc.activeStrat(d).tablets.lines[0]
  assert.deepEqual(priced.link, { query: BREACH_Q, league: 'Forbidden Rites', div: 0.4, at: 5000 })
  assert.equal(sc.needsLinkPrice(priced, 5000 + sc.FLOOR_TTL_MS - 1), false)
  assert.equal(sc.needsLinkPrice(priced, 5000 + sc.FLOOR_TTL_MS), true, 'an hour later: again')
  for (const bad of [null, NaN, -1]) assert.equal(sc.recordLinkPrice(d, 'a', 't1', bad, 9), d)
})

test('the linked price counts in divines; a typed number wins; clearing it goes back to the link', () => {
  const s = (l) => strat({ maps: { count: 20, price: 0, cur: 'chaos' }, tablets: { lines: [l] } })
  const linkedLine = line({ slots: 1, price: null, cur: 'chaos', link: { query: BREACH_Q, league: 'L', div: 0.5, at: 1 } })
  near(sc.tally(s(linkedLine), P, 0, USES).tablets, 20 / 10 * 0.5, 'the link (0.5 div), not chaos')
  near(sc.tally(s({ ...linkedLine, price: 8 }), P, 0, USES).tablets, 20 / 10 * 8 * 0.125, 'typed 8 chaos wins')
  const waiting = { ...linkedLine, link: { ...linkedLine.link, div: null } }
  assert.deepEqual(sc.tally(s(waiting), P, 0, USES).unpriced, ['tablet:any'], 'linked but not priced yet: unpriced, never free')
  assert.equal(sc.needsLinkPrice({ ...linkedLine, price: 8 }, 1e15), false, 'a typed price is never searched over')
})

test('the average of the cheapest ten listings, in divines', () => {
  const px = { divine: 1, exalted: 0.002, chaos: 0.125 }
  const ls = [...Array.from({ length: 12 }, (_, i) => ({ amount: i + 1, currency: 'chaos' }))]
  near(sc.avgDiv(ls, px), (55 / 10) * 0.125, 'the 10 cheapest of 12: 1..10 chaos')
  near(sc.avgDiv([{ amount: 1, currency: 'divine' }, { amount: 1000, currency: 'exalted' }], px), 1.5)
  assert.equal(sc.avgDiv([], px), null)
  assert.equal(sc.avgDiv([{ amount: 1, currency: 'nope' }], px), null)
})

test('unlinking keeps the last price it found, as a typed divine price', () => {
  let d = mk(sc.blankDoc(), 'a', 'A')
  d = sc.addTablet(d, 'a', { id: 't1', now: 1 })
  d = sc.linkTablet(d, 'a', 't1', { query: BREACH_Q, league: 'L' }, 2)
  d = sc.recordLinkPrice(d, 'a', 't1', 0.4, 3)
  d = sc.unlinkTablet(d, 'a', 't1', 4)
  const l = sc.activeStrat(d).tablets.lines[0]
  assert.equal(l.link, undefined)
  assert.equal(l.price, 0.4)
  assert.equal(l.cur, 'divine')
})

test('a stored link loads repaired; a broken one is dropped', () => {
  const load = (link, price = null) => sc.normalize({ v: sc.VERSION, strats: [{ id: 'a', name: 'A', tablets: { lines: [{ id: 't', slots: 1, price, cur: 'chaos', link }] } }] }).strats[0].tablets.lines[0]
  assert.deepEqual(load({ query: BREACH_Q, league: 'L', div: 0.4, at: 9 }).link, { query: BREACH_Q, league: 'L', div: 0.4, at: 9 })
  assert.deepEqual(load({ query: BREACH_Q, league: 'L', div: -1, at: 'x' }).link, { query: BREACH_Q, league: 'L', div: null, at: 0 })
  assert.equal(load({ query: 'x', league: 'L' }).link, undefined)
  assert.equal(load({ query: BREACH_Q }).link, undefined)
  assert.equal(load(undefined).price, null, 'a cleared price stays cleared')
  assert.equal(load(undefined, 4).price, 4)
})

test('a linked search over the backend\'s size limit is never linked (a refused save would stop all saving)', () => {
  assert.equal(sc.MAX_QUERY, 20_000, 'backend/app/stratcalc.py MAX_QUERY')
  let d = mk(sc.blankDoc(), 'a', 'A')
  d = sc.addTablet(d, 'a', { id: 't1', now: 1 })
  const huge = { query: { x: 'y'.repeat(sc.MAX_QUERY) } }
  assert.equal(sc.linkTablet(d, 'a', 't1', { query: huge, league: 'L' }, 2), d)
  const loaded = sc.normalize({ v: sc.VERSION, strats: [{ id: 'a', name: 'A', tablets: { lines: [{ id: 't', slots: 1, price: 1, cur: 'chaos', link: { query: huge, league: 'L', div: null, at: 0 } }] } }] })
  assert.equal(loaded.strats[0].tablets.lines[0].link, undefined)
})

// ---------------------------------------------------------------- a linked waystone search prices a map
// owner, 2026-10-01: "what about maps, those are also searchable". The same link as a tablet line.
const WAY_Q = { query: { status: { option: 'securable' }, filters: { type_filters: { filters: { category: { option: 'map.waystone' } } } } }, sort: { price: 'asc' } }

test('a map price can come from a linked waystone search; typed wins; unlink keeps the last price', () => {
  let d = mk(sc.blankDoc(), 'a', 'A')
  d = sc.edit(d, 'a', s => ({ ...s, maps: { ...s.maps, count: 30, price: 4 } }), 1)
  d = sc.linkMaps(d, 'a', { query: WAY_Q, league: 'L' }, 2)
  let m = sc.activeStrat(d).maps
  assert.equal(m.price, null)
  assert.deepEqual(m.link, { query: WAY_Q, league: 'L', div: null, at: 0 })
  assert.equal(sc.needsLinkPrice(m, 5), true)
  assert.deepEqual(sc.tally(sc.activeStrat(d), P, 0, USES).unpriced, ['maps'], 'linked, not priced yet: unpriced, never free')
  d = sc.recordMapsPrice(d, 'a', 0.25, 9)
  assert.equal(sc.activeStrat(d).updatedAt, 2, 'a background price is not an edit')
  near(sc.tally(sc.activeStrat(d), P, 0, USES).maps, 30 * 0.25)
  const typed = sc.edit(d, 'a', s => ({ ...s, maps: { ...s.maps, price: 8, cur: 'chaos' } }), 10)
  near(sc.tally(sc.activeStrat(typed), P, 0, USES).maps, 30 * 8 * 0.125, 'typed 8 chaos wins')
  d = sc.unlinkMaps(d, 'a', 11)
  m = sc.activeStrat(d).maps
  assert.equal(m.link, undefined)
  assert.deepEqual([m.price, m.cur], [0.25, 'divine'])
  for (const bad of [null, NaN, -1]) assert.equal(sc.recordMapsPrice(d, 'a', bad, 1), d)
  assert.equal(sc.linkMaps(d, 'a', { query: { query: { x: 'y'.repeat(sc.MAX_QUERY) } }, league: 'L' }, 12), d, 'over the size limit: never linked')
})

test('a stored map link loads repaired; a cleared map price stays cleared', () => {
  const load = (maps) => sc.normalize({ v: sc.VERSION, strats: [{ id: 'a', name: 'A', maps }] }).strats[0].maps
  assert.deepEqual(load({ count: 3, price: null, cur: 'chaos', link: { query: WAY_Q, league: 'L', div: 0.2, at: 5 } }),
    { count: 3, price: null, cur: 'chaos', link: { query: WAY_Q, league: 'L', div: 0.2, at: 5 } })
  assert.deepEqual(load({ count: 3, price: 2, cur: 'chaos', link: { query: 'bad' } }), { count: 3, price: 2, cur: 'chaos' })
})

// ---------------------------------------------------------------- ⟳ on a strat (owner, 2026-10-01: "a
// refresher spin on each individual strat to trigger a refresh")
test('refreshing a strat makes its unique floors and linked searches due now; typed prices and other strats untouched', () => {
  let d = mk(mk(sc.blankDoc(), 'b', 'B'), 'a', 'A', 1)
  const floor = { div: 140, at: 5000 }
  d = sc.edit(d, 'a', s => ({ ...s,
    loot: [{ cur: null, name: 'Mageblood', base: 'Utility Belt', qty: 1, price: null, floor },
      { cur: null, name: 'Headhunter', base: 'Heavy Belt', qty: 1, price: 90, floor }],
    maps: { count: 1, price: null, cur: 'chaos', link: { query: WAY_Q, league: 'L', div: 0.2, at: 5000 } },
    tablets: { lines: [line({ price: null, link: { query: BREACH_Q, league: 'L', div: 0.1, at: 5000 } })] } }), 2)
  d = sc.edit(d, 'b', s => ({ ...s, loot: [{ cur: null, name: 'Mageblood', base: 'Utility Belt', qty: 1, price: null, floor }] }), 3)
  const r = sc.restale(d, 'a')
  const a = r.strats.find(s => s.id === 'a')
  const now = 6000
  assert.equal(sc.needsFloor(a.loot[0], now), true)
  assert.equal(sc.needsFloor(a.loot[1], now), false, 'a typed price is never searched over')
  assert.equal(sc.needsLinkPrice(a.maps, now), true)
  assert.equal(sc.needsLinkPrice(a.tablets.lines[0], now), true)
  assert.equal(a.loot[0].floor.div, 140, 'the last price stays on screen until the new one lands')
  assert.equal(a.updatedAt, 2, 'a refresh is not an edit')
  assert.deepEqual(r.strats.find(s => s.id === 'b'), d.strats.find(s => s.id === 'b'))
  assert.equal(sc.restale(d, 'gone'), d)
})

// ---------------------------------------------------------------- sharing (owner, 2026-10-01: "a file
// format that we can read and write from so people can send eachother strats"; "file only")
function sharedDoc() {
  let d = mk(sc.blankDoc(), 'a', 'Ritual chains', 1)
  d = sc.edit(d, 'a', s => ({ ...s,
    timer: { startedAt: 1000, elapsedMs: 5 * H },
    loot: [{ cur: 'divine', name: null, qty: 12, price: null }, { cur: null, name: 'Mageblood', base: 'Utility Belt', qty: 1, price: null, floor: { div: 140, at: 9 } }],
    maps: { count: 30, price: null, cur: 'chaos', link: { query: WAY_Q, league: 'Forbidden Rites', div: 0.2, at: 9 } },
    tablets: { lines: [line({ id: 't1', base: 'Ritual Tablet', name: 'Freedom of Faith', price: null, link: { query: BREACH_Q, league: 'Forbidden Rites', div: 0.4, at: 9 } })] },
    fixed: [{ cur: 'chaos', name: null, qty: 40, price: null }] }), 2)
  d = mk(d, 'b', 'Breach', 3)
  d = sc.newFolder(d, { id: 'f', name: 'Juiced' })
  d = sc.moveNode(d, 'a', 'f', 0)
  return d
}

test('a strat or a folder exports as a .arbiterstrat document: everything about it, never market prices, never a running clock', () => {
  const d = sharedDoc()
  const file = JSON.parse(sc.exportStrats(d, 'a', 6000))
  assert.equal(file.kind, sc.SHARE_KIND)
  assert.equal(file.v, sc.SHARE_VERSION)
  assert.equal(file.strats.length, 1)
  const s = file.strats[0]
  assert.equal(s.name, 'Ritual chains')
  assert.deepEqual(s.timer, { startedAt: null, elapsedMs: 5 * H + 5000 }, 'the time so far, stopped')
  assert.equal(s.loot[1].floor, null, 'a unique\'s floor is looked up again by whoever imports it')
  assert.deepEqual(s.maps.link, { query: WAY_Q, league: 'Forbidden Rites', div: null, at: 0 }, 'the search travels; its price does not')
  assert.equal(s.tablets.lines[0].link.div, null)
  const folder = JSON.parse(sc.exportStrats(d, 'f', 6000))
  assert.deepEqual(folder.tree, [{ id: 'f', kind: 'folder', name: 'Juiced', open: true, children: [{ id: 'a', kind: 'strat' }] }])
  assert.deepEqual(folder.strats.map(x => x.name), ['Ritual chains'])
  assert.equal(sc.exportStrats(d, 'gone', 1), null)
})

test('importing gives copies in an "Imported" folder, the same strats back, nothing of yours touched', () => {
  const d = sharedDoc()
  const text = sc.exportStrats(d, 'f', 6000)
  let n = 0
  const r = sc.importStrats(d, text, { newId: (k) => `${k}${++n}`, now: 7000 })
  assert.equal(r.count, 1)
  const doc = r.doc
  assert.deepEqual(doc.strats.slice(0, 2), d.strats, 'your strats as they were')
  const imp = doc.tree.find(x => x.kind === 'folder' && x.name === sc.IMPORTED)
  assert.ok(imp, 'an Imported folder')
  assert.equal(imp.children[0].kind, 'folder', 'the file\'s folders come along')
  assert.equal(imp.children[0].name, 'Juiced')
  const copy = doc.strats.find(s => s.id === imp.children[0].children[0].id)
  assert.notEqual(copy.id, 'a', 'a copy: its own id')
  const want = JSON.parse(text).strats[0]
  assert.deepEqual({ ...copy, id: 0, updatedAt: 0 }, { ...want, id: 0, updatedAt: 0 }, 'export → import is the same strat')
  assert.equal(doc.active, d.active, 'importing does not switch what you are looking at')
  const twice = sc.importStrats(doc, text, { newId: (k) => `${k}${++n}`, now: 8000 }).doc
  assert.equal(twice.tree.filter(x => x.name === sc.IMPORTED).length, 1, 'one Imported folder')
})

test('a broken, foreign, too-large or too-deep file imports nothing (never half a file)', () => {
  const d = sharedDoc()
  const ok = JSON.parse(sc.exportStrats(d, 'f', 6000))
  const ids = { newId: (k) => `${k}${Math.random()}`, now: 1 }
  for (const bad of ['', 'not json', '[]', JSON.stringify({ ...ok, kind: 'other' }), JSON.stringify({ ...ok, v: 99 }),
    JSON.stringify({ ...ok, strats: [] }), JSON.stringify({ ...ok, strats: 'x' })]) {
    assert.equal(sc.importStrats(d, bad, ids), null, bad.slice(0, 40))
  }
  let deep = { id: 'a', kind: 'strat' }
  for (let i = 0; i < sc.MAX_DEPTH; i++) deep = { id: `f${i}`, kind: 'folder', name: 'F', open: true, children: [deep] }
  assert.equal(sc.importStrats(d, JSON.stringify({ ...ok, tree: [deep] }), ids), null, 'inside Imported it would be one level too deep')
  const many = { ...ok, strats: Array.from({ length: sc.MAX_STRATS }, (_, i) => ({ ...ok.strats[0], id: `s${i}` })), tree: [] }
  assert.equal(sc.importStrats(d, JSON.stringify(many), ids), null, 'over the strat limit')
  const hostile = { ...ok, strats: [{ ...ok.strats[0], name: 'x'.repeat(5000), loot: [{ cur: 'divine', qty: -5, price: 'free' }, 'junk'] }] }
  const r = sc.importStrats(d, JSON.stringify(hostile), ids)
  const s = r.doc.strats.at(-1)
  assert.equal(s.name.length, sc.MAX_NAME, 'repaired like saved data')
  assert.deepEqual(s.loot, [{ cur: 'divine', name: null, qty: 0, price: null }])
})

// Owner (2026-10-03): "a plus button that is small and adds one to the count instead of having to plug in
// the numbers directly" — on a loot row; right-click takes one back (like the Maps run +1).
test('bumping a row adds one (or takes one back), never below zero, and leaves the other rows alone', () => {
  const rows = [{ cur: 'divine', qty: 2, price: null }, { cur: 'chaos', qty: 0, price: null }]
  assert.deepEqual(sc.bump(rows, 'divine', 1).map(r => r.qty), [3, 0])
  assert.deepEqual(sc.bump(rows, 'chaos', -1).map(r => r.qty), [2, 0])
  assert.deepEqual(sc.bump(rows, 'divine', -1).map(r => r.qty), [1, 0])
  assert.deepEqual(sc.bump([{ cur: 'vaal', qty: null }], 'vaal', 1).map(r => r.qty), [1], 'an empty count starts from zero')
})

// QA (2026-10-03): a line that followed its search into Vaal Orbs came back as "0.84 Divine Orb" on unlink.
test('unlinking keeps the last price in the line\'s own currency (divine only when that currency has no price)', () => {
  let d = mk(sc.blankDoc(), 'a', 'A')
  d = sc.edit(d, 'a', s => ({ ...s, maps: { ...s.maps, count: 3 } }), 1)
  d = sc.linkMaps(d, 'a', { query: WAY_Q, league: 'L' }, 2)
  d = sc.recordMapsPrice(d, 'a', 0.5, 3, 'chaos')
  const kept = sc.activeStrat(sc.unlinkMaps(d, 'a', 4, P)).maps
  assert.equal(kept.cur, 'chaos')
  near(kept.price, 0.5 / P.chaos)
  near(sc.tally(sc.activeStrat(sc.unlinkMaps(d, 'a', 4, P)), P, 0, USES).maps, 3 * 0.5, 'the cost does not move')
  d = sc.addTablet(d, 'a', { id: 't1', now: 5 })
  d = sc.linkTablet(d, 'a', 't1', { query: BREACH_Q, league: 'L' }, 6)
  d = sc.recordLinkPrice(d, 'a', 't1', 0.4, 7, 'mystery-orb')
  const l = sc.activeStrat(sc.unlinkTablet(d, 'a', 't1', 8, P)).tablets.lines[0]
  assert.deepEqual([l.price, l.cur], [0.4, 'divine'], 'a currency with no price falls back to divines')
})
