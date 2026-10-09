// ⌘K starts with the current screen's actions (docs/learnability-plan.md part 1). Owner, 2026-10-05: "if you're
// in the workspace view then your example makes sense, but if you're in the board view I'd expect add a currency
// to be first or if you're on stash I'd assume add a currency".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildPaletteItems } from '../src/lib/palette.js'
import { DESTS, SUB_DESTS, SCREEN_COMMANDS } from '../src/lib/dests.js'
import { runTarget } from '../src/lib/paletteRun.js'

const TABS = ['Board', 'Stash', 'Strategy', 'Trading', 'Economy', 'Settings']
const withRuns = () => Object.fromEntries(Object.entries(SCREEN_COMMANDS).map(([s, cs]) => [s, cs.map(c => ({ ...c, run: () => {} }))]))
const GLOBAL = [{ id: 'send-feedback', label: 'Report a problem…', hint: 'Help', aka: ['bug', 'feedback'], run: () => {} },
  { id: 'theme-vault', label: 'Theme: Vault', hint: 'Appearance', run: () => {} }]
const items = (screen, q = '') => buildPaletteItems({ tabs: TABS, subDests: SUB_DESTS, screen, screenCommands: withRuns(),
  commands: GLOBAL, rows: [{ id: 'divine', name: 'Divine Orb' }], leagues: [{ id: 'Standard', text: 'Standard' }],
  tree: [{ id: 's1', kind: 'search', name: 'Headhunter Heavy Belt' }], q })

test('an empty ⌘K starts with this screen\'s actions', () => {
  assert.equal(items('board')[0].label, 'Add a currency')
  assert.equal(items('stash')[0].label, 'Add a currency')
  assert.deepEqual(items('trading-workspace').slice(0, 2).map(i => i.label), ['New search', 'New group'])
  assert.equal(items('strategy-arbitrage')[0].label, 'Convert…')
  assert.equal(items('trading-live')[0].label, 'Jump to newest ping')
})

test('Enter on a just-opened ⌘K never changes anything: each screen\'s first action only focuses or reads', () => {
  // QA 2026-10-05: on the Strat Calculator ⌘K → Enter started the timer
  // QA pass 2: Settings → Enter packaged a report, Mods → Enter pasted the clipboard, Regex → Enter overwrote it.
  // An allowlist (code review): a first action only focuses, unless it is named here as checked and harmless.
  const HARMLESS = new Set(['settings-test-sound'])   // plays the ping sound; changes nothing
  for (const [screen, cs] of Object.entries(SCREEN_COMMANDS)) {
    if (screen === 'trading-workspace') continue   // the owner's own example: New search first
    assert.ok(cs[0].act === 'focus' || HARMLESS.has(cs[0].id), `${screen}: first action "${cs[0].label}" must only focus`)
  }
  assert.equal(items('strategy-calc')[0].label, 'Add loot…')
  assert.equal(items('trading-regex')[0].label, 'Filter modifiers…')
  assert.equal(items('trading-mods')[0].label, 'Filter modifiers…')
  assert.equal(items('settings')[0].label, 'Test ping sound')
})

test('"league" finds the leagues', () => {
  assert.ok(items('board', 'league').some(i => i.kind === 'league'))
})

test('after the actions come the tabs, with their ⌘1–⌘5 shortcuts', () => {
  const list = items('board')
  const tabs = list.filter(i => i.kind === 'view')
  assert.deepEqual(tabs.map(t => [t.label, t.hint]), TABS.map((t, i) => [t, `⌘${i + 1}`]))
  assert.ok(list.indexOf(tabs[0]) > list.findIndex(i => i.label === 'Add a currency'))
})

test('themes, leagues and other screens\' actions wait until you type', () => {
  const labels = items('board').map(i => i.label)
  assert.ok(!labels.includes('Theme: Vault'))
  assert.ok(!labels.includes('Standard'))
  assert.ok(!labels.includes('New search'), 'a Workspace action is not offered on the Board until typed')
  assert.ok(items('board', 'vault').some(i => i.label === 'Theme: Vault'))
  assert.ok(items('board', 'standard').some(i => i.label === 'Standard'))
  assert.ok(items('board', 'new search').some(i => i.label === 'New search'))
})

test('typing still puts this screen\'s matching actions first', () => {
  const add = items('board', 'add')
  assert.equal(add[0].label, 'Add a currency')
  assert.equal(add[0].hint, '', 'the Board\'s own action, not the Stash\'s')
})

test('the words players use find the right place', () => {
  const first = (q, screen = 'board') => items(screen, q)[0]
  assert.equal(first('bug').label, 'Report a problem…')
  for (const [q, want] of [['waystone', 'Regex'], ['tablet', 'Regex'], ['affix', 'Mods'], ['craft', 'Mods'],
    ['flip', 'Arbitrage'], ['convert', 'Arbitrage'], ['farm', 'Strat Calculator'], ['invest', 'Hold'], ['sound', 'Settings'],
    ['notification', 'Settings']]) {
    assert.ok(items('board', q).slice(0, 3).some(i => i.label === want || i.hint === want), `${q} → ${want}`)
  }
})

test('the Stash offers no action that fetches trade history (it spends the shared allowance)', () => {
  for (const c of SCREEN_COMMANDS['stash']) assert.doesNotMatch(c.label + (c.aka || []).join(' '), /history|fetch|refresh|merchant/i)
})

test('every screen has its actions, keyed by the one screen list', () => {
  const ids = DESTS.map(d => d.id)
  assert.deepEqual(Object.keys(SCREEN_COMMANDS).sort(), [...ids].sort())
  for (const [s, cs] of Object.entries(SCREEN_COMMANDS)) assert.ok(cs.length > 0, s)
})

// each action names the control it works; that control carries the marker in its screen's source
const SOURCE = {
  board: ['BoardView'], 'strategy-arbitrage': ['ConvertView'], 'strategy-hold': ['HoldView'], 'strategy-calc': ['StratCalcView'],
  'economy-inflation': ['InflationView'], 'economy-market': ['MarketView'], 'trading-live': ['LiveView'], stash: ['StashView'],
  'trading-regex': ['RegexView', 'RegexResult'], 'trading-mods': ['ModsBar'], settings: ['NotificationsPanel'],
}
// a control is marked by `data-cmd="x"`, a picker's `cmd="x"`, or a segment option's third element 'x'
const marks = (src, t) => src.includes(`cmd="${t}"`) || src.includes(`'${t}'`)
test('every action\'s control is marked in its screen', () => {
  const picker = readFileSync(new URL('../src/components/CurrencyPicker.jsx', import.meta.url), 'utf8')
  const seg = readFileSync(new URL('../src/components/Seg.jsx', import.meta.url), 'utf8')
  assert.match(picker, /<div className="curpick" ref=\{boxRef\} data-cmd=\{cmd\}>/, 'a picker renders its marker')
  assert.match(seg, /data-cmd=\{cmd\}/, 'a segment option renders its marker')
  for (const [screen, cs] of Object.entries(SCREEN_COMMANDS)) {
    for (const c of cs.filter(c => c.target)) {
      const found = (SOURCE[screen] || []).some(f => marks(readFileSync(new URL(`../src/components/${f}.jsx`, import.meta.url), 'utf8'), c.target))
      assert.ok(found, `${screen}: ${c.label} → ${c.target}`)
      assert.ok(['focus', 'click'].includes(c.act), c.label)
    }
  }
})

test('running an action focuses or clicks its control once the screen has drawn it', async () => {
  const log = []
  const el = { focus: () => log.push('focus'), click: () => log.push('click'), querySelector: () => null }
  let drawn = false
  const doc = { querySelector: (sel) => (drawn && sel === '[data-cmd="board-add"]' ? el : null) }
  const frames = []
  const raf = (fn) => frames.push(fn)
  const p = runTarget('board-add', 'focus', { doc, raf })
  frames.shift()()                     // not drawn yet: tries again next frame
  drawn = true
  frames.shift()()
  await p
  assert.deepEqual(log, ['focus'])
})

test('a marked wrapper hands focus to the input inside it', async () => {
  const log = []
  const input = { focus: () => log.push('input'), click: () => log.push('click') }
  const wrap = { focus: () => log.push('wrap'), click: () => {}, querySelector: (s) => (s.includes('input') ? input : null) }
  const doc = { querySelector: () => wrap }
  await runTarget('x', 'focus', { doc, raf: (fn) => fn() })
  assert.deepEqual(log, ['input'])
})

test('a control that never appears gives up instead of waiting forever', async () => {
  const doc = { querySelector: () => null }
  let n = 0
  const raf = (fn) => { n++; fn() }
  assert.equal(await runTarget('missing', 'click', { doc, raf }), false)
  assert.ok(n > 0 && n <= 120)
})

test('App feeds ⌘K the current screen, and the sub-tab views report theirs', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  assert.match(app, /screen=\{screen\}/)
  assert.match(app, /screenCommands=\{screenCommands\}/)
  assert.match(app, /onGoSub=\{goSub\}/, 'one section\/sub-view dispatch, shared by ⌘K\'s screens and actions')
  assert.match(app, /if \(d\) goSub\(d\.section, d\.sub\)/)
  for (const [file, section] of [['StrategyView', 'Strategy'], ['EconomyView', 'Economy'], ['TradingView', 'Trading']]) {
    const src = readFileSync(new URL(`../src/components/${file}.jsx`, import.meta.url), 'utf8')
    assert.match(src, new RegExp(`nav\\.reportSub\\('${section}', sub\\)`), file)
  }
})

// Code review 2026-10-05: an action whose control isn't drawn (Start timer with Override on) or is disabled (Copy regex
// with no regex, Category on Positive movers) did nothing at all. ⌘K lists this screen's actions only when usable.
import { usableHere } from '../src/lib/paletteRun.js'

test('this screen lists only the actions whose control is drawn and enabled', () => {
  const els = { 'calc-loot': { disabled: false }, 'regex-copy': { disabled: true } }
  const doc = { querySelector: (sel) => els[sel.match(/data-cmd="([^"]+)"/)[1]] || null }
  const cmds = [{ id: 'calc-loot', target: 'calc-loot' }, { id: 'calc-timer', target: 'calc-timer' }, { id: 'regex-copy', target: 'regex-copy' }, { id: 'send-feedback' }]
  assert.deepEqual(usableHere(cmds, doc).map(c => c.id), ['calc-loot', 'send-feedback'], 'no control → hidden; disabled → hidden; App-run → kept')
})

test('the palette filters the current screen\'s actions when it opens', () => {
  const src = readFileSync(new URL('../src/components/CommandPalette.jsx', import.meta.url), 'utf8')
  assert.match(src, /usableHere\(screenCommands\[screen\] \|\| \[\]\)/)
})
