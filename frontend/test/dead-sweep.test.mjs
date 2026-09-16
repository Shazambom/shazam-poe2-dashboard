// Batch 10 — dead client surface, style tokens, chrome-extension retirement (audit F-26, F-27).
// Run:  node --test frontend/test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const ROOT = new URL('../../', import.meta.url).pathname
const src = (p) => readFileSync(`${ROOT}frontend/src/${p}`, 'utf8')

test('unmounted views, their API wrappers, CSS and deps are gone', () => {
  assert.ok(!existsSync(`${ROOT}frontend/src/components/WatchesView.jsx`))
  assert.ok(!existsSync(`${ROOT}frontend/src/components/TradeView.jsx`))
  const api = src('lib/api.js')
  for (const dead of ['routes:', 'watches:', 'putWatches:', 'refreshBook:']) assert.ok(!api.includes(dead), dead)
  assert.ok(!src('lib/session.js').includes('searchFromParsed'))
  const css = src('styles.css')
  for (const dead of ['.trade-wrap', '.watch-folder', '.wf-add', '.live-srow', '.ls-name', '.tos-note', '.feeds ', '.feed.as-btn', '.pulse-group.prices', '.pulse-label', '.gold-slider-hint', '.topbar .league', '.update-chip.ok']) assert.ok(!css.includes(dead), dead)
  const pkg = readFileSync(`${ROOT}frontend/package.json`, 'utf8')
  assert.ok(!pkg.includes('dockview'))
})

test('dead exports and stale comments are gone', () => {
  assert.ok(!src('lib/ping-sound.js').includes('soundReady'))
  assert.ok(!src('lib/nav.js').includes('focusLive'))
  const ws = src('lib/workspaceStore.js')
  for (const dead of ['openTab:', 'closeTab:', 'dockview']) assert.ok(!ws.includes(dead), dead)
  assert.ok(!src('components/RouteSteps.jsx').includes('export const RECIPE_GLYPH'))
  assert.ok(!src('components/AccountsPanel.jsx').includes('tools/connect.py --server {host} session'))
})

test('gold recipe, card gradient and the movers accent are tokens', () => {
  const css = src('styles.css')
  for (const tok of ['--ink-on-gold:', '--gold-3:', '--card-gradient:']) assert.ok(css.includes(tok), tok)
  // each surviving hex lives exactly once: on its token line in :root
  for (const hex of ['#1b1608', '#b8862f']) assert.equal(css.split(hex).length - 1, 1, hex)
  for (const hex of ['#1a1400', '#7aa2d6', '#93b6e4']) assert.ok(!css.includes(hex), hex)
  assert.ok(css.includes('.pulse-group.movers { border-left: 3px solid var(--live)'))
})

test('chrome extension is retired', () => {
  assert.ok(!existsSync(`${ROOT}tools/chrome-extension`))
  const s = src('lib/session.js')
  assert.ok(!s.includes('poe2arb-ext') && !s.includes("'extension'"))
})
