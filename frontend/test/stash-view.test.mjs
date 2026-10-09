// Trading → Stash and the Arbitrage rail: how the screens use lib/stash.js (the rules are pinned in
// stash.test.mjs and backend/tests/test_stash.py) and follow the styleguide.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const { DESTS } = await import('../src/lib/dests.js')

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const strip = (s) => s.replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
const css = read('../src/styles.css')

test('the Stash is its own tab (owner, 2026-10-08), right after the Board; nothing is called Sales', () => {
  const d = DESTS.find(x => x.id === 'stash')
  assert.equal(d.label, 'Stash')
  assert.equal(d.section, 'Stash')
  assert.equal(d.sub, 'stash')
  assert.ok(!DESTS.some(x => x.label === 'Sales'))
})

test('the app mounts the Stash view on its own tab', () => {
  const tab = strip(read('../src/components/StashTab.jsx'))
  assert.match(tab, /sub === 'stash' && <StashView /)
  assert.doesNotMatch(tab, /SalesView/)
})

test('the Stash view groups, totals and switches through lib/stash.js and saves choices in settings', () => {
  const v = strip(read('../src/components/StashView.jsx'))
  for (const fn of ['stashGroups', 'netWorth', 'liquidNetWorth', 'flipGroup', 'isFolded', 'groupAccent'])
    assert.ok(v.includes(fn), `uses ${fn}`)
  assert.match(v, /saveSettings\(\{ stash_counted:/, 'switches persist in the settings blob')
  assert.match(v, /<Toggle/, 'the app\'s only on/off control')
  assert.doesNotMatch(v, /type="checkbox"/)
  assert.match(v, /group_icons/, 'a group\'s icon is the server\'s most-traded item, not a picked one')
  assert.doesNotMatch(v, /'(Ritual|Abyss|Breach|Delirium|Expedition)'/, 'no category is named in the view')
})

test('the Arbitrage rail shows only arbitrage capital and links to Stash; the editor lives on Stash', () => {
  const rv = strip(read('../src/components/RoutesView.jsx'))
  assert.doesNotMatch(rv, /<CapitalCard/)
  assert.match(rv, /arbitrageHoldings\(/)
  assert.match(rv, /goStash\(\)/)
})

test('the sticky sales column fits the viewport and scrolls its own overflow (bug XWZGZ0)', () => {
  const m = css.match(/\.stash-sales\s*\{([^}]*)\}/)
  assert.ok(m, '.stash-sales rule present')
  if (!/position:\s*sticky/.test(m[1])) return
  assert.match(m[1], /max-height:\s*[^;]*(vh|dvh|svh|100%)/)
  assert.match(m[1], /overflow(-y)?:\s*(auto|scroll)/)
})

test('group accents are tokens in :root; every theme preset sets how much of the hue survives', () => {
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')))
  assert.match(root, /--grp-mix:/)
  assert.match(root, /--grp-currency:\s*#[0-9a-f]{6}/i)
  for (const t of ['ash', 'divinity', 'azmeri']) {
    assert.match(css, new RegExp(`html\\[data-theme="${t}"\\][^{]*\\{[^}]*--grp-mix`), `${t} tunes --grp-mix`)
  }
  assert.match(css, /color-mix\(in oklab, var\(--grp\) var\(--grp-mix\), var\(--ink-2\)\)/, 'accents blend toward the theme\'s ink')
})

test('the compact Toggle exists for dense rows, and the half state reads as mixed', () => {
  const t = read('../src/components/Toggle.jsx')
  assert.match(t, /size === 'sm'/)
  assert.match(t, /aria-checked=\{checked === 'some' \? 'mixed'/)
  assert.match(css, /\.toggle\.sm \.toggle-track\s*\{/)
  assert.match(css, /\.toggle\.some \.toggle-thumb\s*\{/)
})

// QA pass 1 (2026-10-03)
test('removing a holding clears its switch choice, so re-adding it starts at the default', () => {
  const v = strip(read('../src/components/StashView.jsx'))
  assert.match(v, /choose\(\{ \[c\]: null \}\)/)
})

test('a quantity box keeps a whole, non-negative count', () => {
  const v = strip(read('../src/components/StashView.jsx'))
  assert.match(v, /setOne\(r\.currency, cleanQty\(e\.target\.value\)\)/)
})

test('a row shows its worth without a second, different number on hover', () => {
  const v = strip(read('../src/components/StashView.jsx'))
  assert.doesNotMatch(v, /cashes out to/)
})

test('an added currency opens its group so its quantity can be typed', () => {
  const v = strip(read('../src/components/StashView.jsx'))
  assert.match(v, /unfold\(id\)/)
})

test('the page waits for a holdings save in flight before it reads holdings again', () => {
  const v = strip(read('../src/components/StashView.jsx'))
  assert.match(v, /saveCapital\(/)
  assert.match(v, /capitalSaving/)
})

test('"Start from" names currencies, it does not print their ids', () => {
  const rv = strip(read('../src/components/RoutesView.jsx'))
  assert.match(rv, /<option key=\{c\} value=\{c\}>\{nameOf\(c\)\}<\/option>/)
})

test('groups read left to right in value order, not down one column then the next', () => {
  const m = css.match(/\.stash-groups\s*\{([^}]*)\}/)
  assert.doesNotMatch(m[1], /(^|[;{\s])columns:/, 'not CSS multi-column (it flows down, then across)')
  assert.match(m[1], /display:\s*grid/)
})

test('⌘K finds Stash by its old name too', async () => {
  const { buildPaletteItems } = await import('../src/lib/palette.js')
  const { SUB_DESTS } = await import('../src/lib/dests.js')
  const tabs = ['Board', 'Stash', 'Trading', 'Economy', 'Settings']
  const hits = buildPaletteItems({ tabs, subDests: SUB_DESTS, q: 'sales' })
  assert.deepEqual(hits.map(h => [h.kind, h.label]), [['sub', 'Stash']])
})

// code review (2026-10-03)
test('Mods section headers keep the header style the old Sales head shared with them', () => {
  const mods = read('../src/components/ModSection.jsx')
  assert.match(mods, /className="sales-head/)
  assert.match(css, /\.sales-head\s*\{[^}]*display:\s*flex/)
})

test('the Stash reads holdings from the store only, and a save does not re-fetch them', () => {
  const v = strip(read('../src/components/StashView.jsx'))
  assert.doesNotMatch(v, /setSaved|saved \?\? shared/)
  assert.doesNotMatch(v, /saveCapital\(entries\)\)\s*\n?\s*refreshHeader\(\)/)
  assert.match(v, /addCredit\(qtyRef\.current, r\.added\)/, 'a credit merges exactly what the server added into unsaved edits')
  assert.match(v, /flush\(\)/, 'pending edits are sent before a credit is read')
})

test('stored switch choices merge under ones made before settings loaded', () => {
  const v = strip(read('../src/components/StashView.jsx'))
  assert.match(v, /setChoices\(c => \(\{ \.\.\.stored, \.\.\.\(c \|\| \{\}\) \}\)\)/)
})

test('the worth bar shows counted against not counted, not group identity by colour alone', () => {
  const v = strip(read('../src/components/StashView.jsx'))
  const bar = v.slice(v.indexOf('stash-bar'), v.indexOf('stash-body'))
  assert.doesNotMatch(bar, /groupAccent/)
})

test('net worth and liquid net worth use the app\'s hero number style', () => {
  const v = strip(read('../src/components/StashView.jsx'))
  assert.match(v, /className="stat-val"/)
  assert.doesNotMatch(css, /\.stash-val\s*\{/)
})

test('a half-on group switch is announced as mixed (a checkbox), a plain switch as a switch', () => {
  const t = read('../src/components/Toggle.jsx')
  assert.match(t, /role=\{checked === 'some' \? 'checkbox' : 'switch'\}/)
})

test('cash rows wait with "…" while the market syncs, like every other row', () => {
  const v = strip(read('../src/components/StashView.jsx'))
  assert.doesNotMatch(v, /!CASH\.includes\(r\.currency\) \? <span className="muted">…/)
})

test('the Arbitrage card sums with the Stash\'s own helper; no dead save plumbing remains', () => {
  const rv = strip(read('../src/components/RoutesView.jsx'))
  assert.match(rv, /netWorth\(held\)/)
  for (const f of ['RoutesView', 'StashTab']) assert.doesNotMatch(read(`../src/components/${f}.jsx`), /onCapitalSaved/)
  assert.doesNotMatch(read('../src/App.jsx'), /onCapitalSaved/)
})

test('the notional notice says what to do now that holdings live on Stash', () => {
  const rv = strip(read('../src/components/RoutesView.jsx'))
  assert.doesNotMatch(rv, /Enter what you hold on the left/)
  assert.doesNotMatch(rv, /from every currency/)
})

test('no CSS left for the deleted holdings card', () => {
  for (const sel of ['.cap-sub', '.cap-ghost', '.cap-row input[type="number"]']) assert.ok(!css.includes(sel), sel)
})

test('every --grp- token is never themed, without a second list', async () => {
  const { isNeverThemed } = await import('../src/lib/themeCss.js')
  assert.equal(isNeverThemed('--grp-some-future-category'), true)
  assert.equal(isNeverThemed('--gold'), false)
  assert.doesNotMatch(read('../src/lib/themeCss.js'), /'--grp-ritual'/)
})

test('after a switch is saved the holdings are re-read, so the Arbitrage card follows it', () => {
  const v = strip(read('../src/components/StashView.jsx'))
  assert.match(v, /saveSettings\(\{ stash_counted: patch \}\)\.then\(\(\) => refreshHeader\(\)\)/)
})

test('the add bar sits in the pinned Stash header: a currency, an amount, and Add', () => {
  const v = strip(read('../src/components/StashView.jsx'))
  const head = v.slice(v.indexOf('className="stash-head"'), v.indexOf('className="stash-worth"'))
  assert.match(head, /className="stash-addbar"/)
  assert.match(head, /<CurrencyPicker value=\{pick\}/)
  assert.match(head, /aria-label="Amount to add"/)
  assert.match(head, /className="btn primary small"[^>]*disabled=\{!pick/)
  assert.match(v, /addAmount\(/)
  assert.doesNotMatch(v, /className="stash-add"/, 'the old box under the groups is gone')
  assert.match(css, /\.stash-head\s*\{[^}]*position:\s*sticky/)
})

test('clearing the add bar\'s picker drops its currency, and one press adds once', () => {
  const v = strip(read('../src/components/StashView.jsx'))
  assert.match(v, /onClear=\{\(\) => setPick\(''\)\}/)
  assert.match(v, /const id = pickRef\.current/)
})

// Owner (2026-10-03): the top bar shows both, labelled — net worth and liquid net worth, the Stash's own figures.
test('the top bar shows net worth and liquid net worth, computed as on the Stash', () => {
  const app = strip(read('../src/App.jsx'))
  const pill = app.slice(app.indexOf('className="capital-pill"'), app.indexOf('</span>', app.indexOf('className="capital-pill"')))
  assert.match(pill, /net worth <b><Wealth v=\{capital\?\.total_ref\}/)
  assert.match(pill, /liquid <b><Wealth v=\{liquidTop\}/)
  assert.match(app, /liquidNetWorth\(capital\?\.rows, settings\?\.stash_counted, capital\?\.counted_by_default\)/)
  assert.match(app, /capital\?\.syncing \? null/, 'no liquid figure until the market has synced, as on the Stash')
})

// code review 3 (2026-10-03)
test('the picker: a second Enter after choosing changes nothing; typing drops the old pick', () => {
  const p = read('../src/components/CurrencyPicker.jsx')
  assert.match(p, /e\.key === 'Enter'\) \{ e\.preventDefault\(\); if \(open\) choose\(matches\[sel\]\) \}/)
  assert.match(p, /if \(value\) onClear\?\.\(\)/)
})

test('holding autosave also stops a save already scheduled, keeping the edit pending', () => {
  const h = read('../src/lib/hooks.js')
  assert.match(h, /const hold = \(\) => \{ held\.current = true; clearTimeout\(timer\.current\); timer\.current = null \}/)
})

test('adding through the bar opens its group for now, without changing the saved folds', () => {
  const v = strip(read('../src/components/StashView.jsx'))
  const unfold = v.slice(v.indexOf('const unfold'), v.indexOf('\n', v.indexOf('const unfold')))
  assert.doesNotMatch(unfold, /writeFolds/)
})

test('the add amount is a text box read by parseAmount; the compact boxes really are compact', () => {
  const v = strip(read('../src/components/StashView.jsx'))
  assert.match(v, /aria-label="Amount to add"[^>]*|inputMode="decimal"/)
  assert.match(v, /parseAmount\(amount\)/)
  assert.match(css, /\.stash-addbar input\s*\{[^}]*!important/)
  assert.match(css, /\.stash-row input\[type="number"\]\s*\{[^}]*padding:[^;]*!important/)
})

test('the pinned sales column starts below the pinned header\'s real height', () => {
  const v = strip(read('../src/components/StashView.jsx'))
  assert.match(v, /new ResizeObserver\(/)
  assert.match(v, /--stash-head-h/)
  assert.match(css, /\.stash-sales\s*\{[^}]*top:\s*calc\(var\(--stash-head-h/)
  assert.match(css, /\.stash-sales\s*\{[^}]*max-height:\s*calc\(100vh - var\(--stash-head-h/)
})

// Sales credit only after the user last COUNTED a currency (backend/tests/test_sales_credit.py): typing a
// total or removing a holding is a count; the add bar ("+N") and the Stash's own re-save after a credit are not.
test('only a typed total or a removal tells the server the user counted that currency', () => {
  const v = strip(read('../src/components/StashView.jsx'))
  assert.match(v, /saveCapital\(entries, counted\)/, 'the save sends which totals were counted')
  const fn = (name) => v.slice(v.indexOf(`const ${name} =`), v.indexOf('\n  const ', v.indexOf(`const ${name} =`) + 1))
  assert.match(fn('setOne'), /recounted\.current\.add\(c\)/, 'typing a total is a count')
  assert.match(fn('remove'), /recounted\.current\.add\(c\)/, 'removing a holding is a count (none left)')
  assert.doesNotMatch(fn('addPicked'), /recounted/, 'the add bar adds; it is not a count')
})

// QA (2026-10-04): a hook placed after the "Loading your stash…" early return blanked the app once the stash loaded
// (React error #310). Every hook runs before that return.
test('StashView calls every hook before its loading return', () => {
  const v = strip(read('../src/components/StashView.jsx'))
  const body = v.slice(v.indexOf('export default function StashView'))
  const early = body.indexOf('if (!qty) return')
  assert.ok(early > 0)
  assert.doesNotMatch(body.slice(early, body.indexOf('\n  return (', early)), /\buse[A-Z]\w*\(/, 'no hook after the early return')
})
