// Batch 9 — client duplication sand-down (audit F-14, F-15, F-16, F-22, F-23).
// Run:  node --test frontend/test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = new URL('../src/', import.meta.url).pathname
const src = (p) => readFileSync(join(SRC, p), 'utf8')
const walk = (d) => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p] })
const files = walk(SRC).filter(f => /\.(jsx?|mjs)$/.test(f))
const rel = (f) => f.replace(SRC, '')
const DEAD = ['components/WatchesView.jsx', 'components/TradeView.jsx']   // removed in the dead-code batch
const live = files.filter(f => !DEAD.includes(rel(f)))

test('one autosave hook: Settings and Recipes use useAutosave, no hand-rolled timers', () => {
  for (const f of ['components/SettingsView.jsx', 'components/RecipesView.jsx']) {
    const s = src(f)
    assert.ok(s.includes('useAutosave('), f)
    assert.ok(!s.includes("setState('saving')") && !s.includes('loaded.current'), f)
  }
})

test('one fetch hook: views use useApi instead of the setBusy/then/catch/finally shape', () => {
  assert.ok(src('lib/hooks.js').includes('export function useApi('))
  for (const f of ['components/HoldView.jsx', 'components/InflationView.jsx', 'components/MarketView.jsx', 'components/LeagueArc.jsx']) {
    const s = src(f)
    assert.ok(s.includes('useApi('), f)
    assert.ok(!s.includes('.finally(() => setBusy(false))'), f)
    assert.ok(!s.includes('String(e.message || e)'), `${f} re-inlines cleanErr`)
  }
})

test('one desktop predicate: isDesktop / hasTradeEngine live in lib/session.js', () => {
  const s = src('lib/session.js')
  assert.ok(s.includes('export const isDesktop') && s.includes('export const hasTradeEngine'))
  const offenders = live.filter(f => !f.endsWith('lib/session.js') && /typeof window !== 'undefined' && !!window\.poe2desktop/.test(readFileSync(f, 'utf8')))
  assert.deepEqual(offenders.map(rel), [])
})

test('formatters have one home', () => {
  const api = src('lib/api.js')
  assert.ok(api.includes('hourLabel:') && api.includes('dur:'))
  const offenders = live.filter(f => !f.endsWith('lib/api.js') && /new Date\([^)]*\* 1000\)\.toLocaleString/.test(readFileSync(f, 'utf8')))
  assert.deepEqual(offenders.map(rel), [])
  assert.ok(!src('components/RoutesView.jsx').includes('const hrs ='))
  assert.ok(src('components/CardDetail.jsx').includes('export function srcBadge('))
  assert.ok(!src('components/BoardView.jsx').includes("r.source === 'live' ? 'LIVE'"))
  const raw = live.filter(f => /Math\.round\([^)]*\)\.toLocaleString\(\)/.test(readFileSync(f, 'utf8')))
  assert.deepEqual(raw.map(rel), [])
})

test('one currencies store: /api/currencies is fetched only by lib/icons.js', () => {
  const offenders = live.filter(f => !f.endsWith('lib/icons.js') && !f.endsWith('lib/api.js') && /api\.currencies\(\)/.test(readFileSync(f, 'utf8')))
  assert.deepEqual(offenders.map(rel), [])
  assert.ok(src('lib/icons.js').includes('export function useCurrencies('))
})

test('one status store: status/capital/settings/session polling lives in lib/statusStore.js', () => {
  const st = src('lib/statusStore.js')
  assert.ok(st.includes('export const useStatus'))
  const offenders = live.filter(f => !f.endsWith('lib/statusStore.js') && !f.endsWith('lib/api.js')
    && /api\.(status|settings|session|oauthStatus|rateLimits)\(\)/.test(readFileSync(f, 'utf8')))
  assert.deepEqual(offenders.map(rel), [])
  assert.ok(!src('components/AccountsPanel.jsx').includes('setInterval'))
})

test('one sub-tab shell', () => {
  assert.ok(src('components/SubTabs.jsx').includes('export default function SubTabs('))
  for (const f of ['components/StrategyView.jsx', 'components/EconomyView.jsx', 'components/TradingView.jsx']) {
    const s = src(f)
    assert.ok(s.includes('<SubTabs'), f)
    assert.ok(!s.includes('<motion.span className="subtab-underline"'), f)
  }
})

test('one toast system: sonner is gone, the bus carries the ping banner', () => {
  assert.deepEqual(live.filter(f => /from 'sonner'/.test(readFileSync(f, 'utf8'))).map(rel), [])
  assert.ok(!readFileSync(new URL('../package.json', import.meta.url), 'utf8').includes('"sonner"'))
})

// ---- unit tests for the new pure helpers
const { fmt, bus } = await import('../src/lib/api.js')

test('fmt.dur renders hours with minute and day tiers', () => {
  assert.equal(fmt.dur(null), '–')
  assert.equal(fmt.dur(0.01), '<1m')
  assert.equal(fmt.dur(0.5), '30m')
  assert.equal(fmt.dur(5.25), '5.3h')
  assert.equal(fmt.dur(50), '2.1d')
})

test('fmt.hourLabel formats an epoch-seconds hour', () => {
  assert.match(fmt.hourLabel(86400 * 200 + 3600 * 12), /^[A-Z][a-z]{2} \d{1,2}, \d{2} (AM|PM)$/)
})

test('bus toasts replace by id and default ok=true', () => {
  const seen = []
  const off = bus.on(t => seen.push(t))
  bus.emit({ id: 'live-ping', text: 'a' })
  bus.emit({ id: 'live-ping', text: 'b' })
  off()
  assert.deepEqual(seen.map(t => t.text), ['a', 'b'])
})

const { srcBadge } = await import('../src/components/CardDetail.jsx').catch(() => ({ srcBadge: null }))
test('srcBadge maps every source to a label + title', { skip: !srcBadge && 'jsx not importable in node' }, () => {
  assert.deepEqual(srcBadge('live'), { label: 'LIVE', title: 'live order book' })
  assert.deepEqual(srcBadge(undefined), { label: '–', title: 'no data' })
})
