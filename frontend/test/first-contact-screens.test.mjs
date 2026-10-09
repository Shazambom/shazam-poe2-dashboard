// The first-contact changes that are a screen's shape (docs/first-contact-audit.md, rulings 2026-10-08), pinned
// in the source: Settings knobs on beta/dev, Inflation in ink, Market amounts with units, Board cards without
// source badges, the top bar's one action while nothing is held, inbox entries with a price.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')

test('Settings: gold fees, recipes, the currency linker and the market switches show on beta and dev only', () => {
  const s = src('components/SettingsView.jsx')
  assert.match(s, /useTweaks\(\)/)
  for (const k of ['Gold fees (automatic', '<RecipesView', 'Unmapped currencies', 'Fill missing pairs']) {
    const i = s.indexOf(k); assert.ok(i > 0, k)
    assert.match(s.slice(Math.max(0, i - 900), i), /tweaks && /, `${k} is behind the tweaks gate`)
  }
  const diag = s.indexOf('<summary>Diagnostics</summary>')
  assert.doesNotMatch(s.slice(diag - 120, diag), /tweaks && /, 'Diagnostics (the beta opt-in) stays on stable')
  assert.match(src('components/AccountsPanel.jsx'), /<h2>Account<\/h2>/)
})

test('Inflation: measured against the anchor, drawn in ink with an arrow, no Hours column', () => {
  const s = src('components/InflationView.jsx')
  assert.match(s, /\}>Against\s/)
  assert.doesNotMatch(s, /<th className="num">Hours<\/th>/)
  assert.doesNotMatch(s, /\? 'loss' : 'gain'/, 'inflation is neither a gain nor a loss')
  assert.match(s, /▲|▼/)
  assert.match(s, /Now \(start = 100\)/)
})

test('Market: each side of a volume carries its currency, the row shows the market\'s rate, recipes sort last', () => {
  const s = src('components/MarketView.jsx')
  assert.match(s, /fmt\.compact\(m\.volume_a\)/)
  assert.match(s, /fmt\.compact\(m\.volume_b\)/)
  assert.match(s, /<th className="num">Rate<\/th>/)
  assert.doesNotMatch(s, />Hours active</)
  assert.match(s, /kind === 'recipe'\) - \(/, 'recipe rows sort after real markets')
})

test('Board cards: no source badge or source colour; one caption; long names shrink', () => {
  const s = src('components/BoardView.jsx'), css = src('styles.css')
  assert.doesNotMatch(s, /pt-src/)
  assert.doesNotMatch(s, /'daily close'/)
  assert.match(s, /r\.source === 'scout' \? 'updated' : 'traded'/)
  assert.match(s, /pt-name\$\{[^}]*' long'/)
  assert.doesNotMatch(css, /\.price-tile\.src-(live|digest) \{ border-left/)
})

test('Top bar: while nothing is held, one action replaces the zero', () => {
  const s = src('App.jsx')
  assert.match(s, /Add what you hold ›/)
  assert.match(s, /nav\.goStash\(\)/)
})

test('Inbox: an entry names the price, not the volume multiple', () => {
  const s = src('components/DivinePingOrb.jsx')
  assert.doesNotMatch(s, /vol_z/)
  assert.match(s, /<Rate value=\{s\.close\}/)
})

// QA pass (2026-10-08) on the first-contact build: four defects and the polish that follows the same rules.
test('QA 1: Convert drops its last result when the currencies change (no stale route under new icons)', () => {
  const s = src('components/ConvertView.jsx')
  assert.match(s, /useEffect\(\(\) => \{ setRes\(null\) \}, \[have, want\]\)/)
})

test('QA 2: ⌘K opens a currency that is not on the board by its name, in the app-wide card', () => {
  const p = src('components/CommandPalette.jsx'), a = src('App.jsx')
  assert.match(p, /onOpenCurrency\(it\)/, 'the palette hands over the item, not just the id')
  assert.match(a, /onOpenCurrency=\{\(it\) => \{ if \(!it\.onBoard\) return assetModal\.open\(it\.label\)/)
})

test('QA 3: the Per day tile says what it measures', () => {
  assert.match(src('components/InflationView.jsx'), /<div className="stat-sub">24h trend<\/div>/)
})

test('QA 4: the Loop header always means best first, and shows it', () => {
  const s = src('components/RoutesView.jsx')
  assert.match(s, /onClick=\{\(\) => setSort\(\{ key: 'score', dir: 'desc' \}\)\}>Loop/)
  assert.match(s, /\{sort\.key === 'score' \? ' ▾' : ''\}/)
})

test('QA polish: the zoomed card has no source badge or colour; pills run in day order; low confidence is not red', () => {
  const cd = src('components/CardDetail.jsx'), arc = src('components/LeagueArc.jsx'), css = src('styles.css')
  assert.doesNotMatch(cd, /pt-src/)
  assert.doesNotMatch(cd, /card-detail src-\$\{/)
  assert.match(arc, /\.sort\(\(a, b\) => a\.age - b\.age\)/)
  const lo = css.slice(css.indexOf('.conf-lo'), css.indexOf('.conf-lo') + 120)
  assert.doesNotMatch(lo, /--loss/)
  assert.match(src('components/RoutesView.jsx'), /Sized to 10 <Cur id=\{ref\}/)
})

// Code review (2026-10-08), the verified findings that are a screen's shape.
test('review: the empty-state chip keys on holdings, not on their price', () => {
  const a = src('App.jsx')
  assert.match(a, /!capital\.rows\?\.some\(r => r\.qty > 0\)/)
  assert.doesNotMatch(a, /!\(capital\.total_ref > 0\)/)
  assert.doesNotMatch(a, /className="chip act"/, 'no one-off pill class')
  // owner 2026-10-08: a real button (the top bar's Connect style), with a mirror on it
  assert.match(a, /className="btn primary connect-live nudge"[\s\S]{0,120}><Cur id="mirror"[^>]*\/> Add what you hold ›/)
  assert.doesNotMatch(src('styles.css'), /\.chip\.act/)
})

test('review: an inbox price is an Exalted close and says so', () => {
  const s = src('components/DivinePingOrb.jsx')
  assert.match(s, /<Rate value=\{s\.close\} num="exalted"/)
  assert.doesNotMatch(s, /settings\?\.reference/)
})

test('review: no header tooltips narrate the loop columns; the Where cell carries no source colour; no dead metric', () => {
  const rv = src('components/RoutesView.jsx'), steps = src('components/RouteSteps.jsx')
  const cols = rv.slice(rv.indexOf('const COLS = ['), rv.indexOf(']\n', rv.indexOf('const COLS = [')))
  assert.doesNotMatch(cols, /What you must have|Among the loops shown|markets' own pace/)
  assert.doesNotMatch(steps, /className=\{`k \$\{s\.kind\}`\}/)
  assert.doesNotMatch(rv, /metric:/)
  assert.match(rv, /tweaks \? 'Loosen a filter on the left/, 'stable has no filter to loosen: it gets "Try a looser preset"')
})

test('review: Inflation\'s three tiles share one formatter', () => {
  const s = src('components/InflationView.jsx')
  assert.equal((s.match(/arrowPct\(/g) || []).length, 4, 'three tiles and the table, one formatter')
  assert.doesNotMatch(s, /Math\.abs\(vel\)/)
})

test('review + owner: the one ⟳ in the top bar also syncs market data; Settings has no sync button; the dead source badge is gone', () => {
  const s = src('components/SettingsView.jsx')
  assert.equal((s.match(/api\.syncDigest\(\)/g) || []).length, 0, 'no sync button in Settings')
  assert.match(src('lib/syncStore.js'), /requestRefresh: \(\) => \{ api\.syncDigest\(\)/)
  assert.doesNotMatch(s, /\{!tweaks && \(/)
  const cd = src('components/CardDetail.jsx'), css = src('styles.css')
  assert.doesNotMatch(cd, /srcBadge|SRC_SHORT|SRC_LABEL/)
  assert.doesNotMatch(css, /\.pt-src/)
})

test('owner: on desktop the one Connect opens the in-app login; the F12 paste flow is under "Other ways"', () => {
  const s = src('components/AccountsPanel.jsx')
  const desk = s.slice(s.indexOf(') : desktop ? ('), s.indexOf('// Web build'))
  const primary = desk.slice(0, desk.indexOf('<details'))
  assert.match(primary, /onClick=\{bridgeConnect\}/, 'the first thing on desktop is the in-app login')
  assert.doesNotMatch(primary, /F12|POESESSID/, 'no F12 steps before the fold')
  const other = desk.slice(desk.indexOf('<details'))
  assert.match(other, /POESESSID/, 'the paste flow stays available, demoted')
})
