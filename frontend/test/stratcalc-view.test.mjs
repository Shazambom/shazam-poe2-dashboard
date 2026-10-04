// Strategy → Strat Calculator: the view's wiring. The math, the strats and the input rules are pinned
// in stratcalc.test.mjs and backend/tests/test_stratcalc_e2e.py; this pins how the screen uses them
// and that it follows the styleguide (docs/ui-styleguide.md).
import test from 'node:test'
import assert from 'node:assert/strict'
const { DESTS } = await import('../src/lib/dests.js')
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const view = read('../src/components/StratCalcView.jsx')
const code = view.replace(/\/\/.*$/gm, '')
const css = read('../src/styles.css')
const scCss = css.slice(css.indexOf('/* ---------- strat calculator'), css.indexOf('/* ----------', css.indexOf('/* ---------- strat calculator') + 10))

test('Strategy has a Strat Calculator sub-tab', () => {
  const sv = read('../src/components/StrategyView.jsx')
  assert.ok(sv.includes("subsOf('Strategy')") && sv.includes('<StratCalcView'))
  assert.ok(DESTS.some(d => d.section === 'Strategy' && d.sub === 'calc' && d.label === 'Strat Calculator'), 'the tab, in the one screen list')
})

test('the sidebar: a "Strats" card with a drag-and-drop folder tree, like trade searches (owner, 2026-10-01)', () => {
  assert.ok(code.includes("from 'react-arborist'") && code.includes('<Tree'), 'the same tree library as the trade searches')
  assert.ok(code.includes('className="capcard scalc-stratcard"') && code.includes('<h2>Strats'), 'a card like "What you hold"')
  assert.ok(code.includes('aria-label="New strat"') && code.includes('aria-label="New folder"'), 'the trade rail\'s icon buttons: 📁 and a gold +')
  assert.ok(code.includes('className="ws-icon-btn primary"'))
  for (const fn of ['sc.moveNode(', 'sc.newFolder(', 'sc.renameFolder(', 'sc.setOpen(', 'sc.removeFolder(', 'sc.restoreFolder(', 'sc.newStrat(', 'sc.duplicate(', 'sc.select('])
    assert.ok(code.includes(fn), fn)
  assert.ok(code.includes('className={`ws-node'), 'rows reuse the trade-search tree\'s row style')
  assert.ok(code.includes('<ContextMenu') && /label: 'Duplicate'/.test(code) && /label: 'Rename'/.test(code) && /label: 'Delete'/.test(code))
})

test('the clock ticks only where time shows: the lists and pickers never re-render each second', () => {
  assert.ok(code.includes('function Live('), 'a small live part owns the 1 s tick')
  assert.equal((code.match(/setInterval\(\(\) => setNow/g) || []).length, 1, 'one ticking interval, inside Live')
  assert.ok(!/export default function StratCalcView[\s\S]*const \[now, setNow\]/.test(code), 'the view itself holds no clock state')
})

test('one background search at a time is one key; a poll after the first load fetches prices only', () => {
  assert.ok(code.includes('pending === key') || code.includes('pending === sc.rowKey'), 'the row being searched')
  assert.ok(!code.includes('searching.current'), 'no second flag for the same thing')
  assert.ok(code.includes('api.stratPrices()'), 'the minute poll reads prices, not the whole saved document')
})

test('deleting a strat or removing a row is undone from a toast, never confirmed', () => {
  assert.ok(code.includes('sc.removeStrat(') && code.includes('sc.restoreStrat('))
  assert.ok((code.match(/undoToast\('sc-undo'/g) || []).length >= 3, 'strats, folders and rows all offer Undo (the shared toast)')
  assert.ok(!/\bconfirm\(/.test(code), 'never a native confirm: it freezes the window')
})

test('Start/Pause and +1 act on the latest state; +1 repeats when held and right-click takes one back', () => {
  assert.ok(code.includes('sc.toggle('))
  assert.ok(code.includes('onPointerDown') && code.includes('onContextMenu'), '+1 holds to repeat; right-click is −1')
})

test('shortcuts listen only while the calculator is on screen, and never while typing or under a menu', () => {
  assert.ok(/addEventListener\('keydown'/.test(code) && /removeEventListener\('keydown'/.test(code), 'added on mount, removed on unmount')
  assert.ok(code.includes('sc.shortcut(') && code.includes('sc.isTyping('))
  assert.ok(code.includes('.cmdk-backdrop') && code.includes('.ctx-menu'), 'the palette and menus count as open')
  assert.ok(!/globalShortcut|ipcRenderer/.test(code), 'never a system-wide shortcut')
})

test('number boxes are forgiving text boxes; the clock takes a typed time', () => {
  assert.ok(code.includes('sc.parseNum('), '1,5 / 3*12 / 40k')
  assert.ok(code.includes('inputMode="decimal"') && !code.includes('type="number"'), 'text boxes: a scroll never changes a value')
  assert.ok(code.includes('ArrowUp') && code.includes('shiftKey'), '↑/↓ by one, Shift by ten')
  assert.ok(code.includes('sc.parseDuration(') && code.includes('sc.setElapsed('))
})

test('costs: maps run, per map, a tablet setup of lines, and the override as a toggle', () => {
  // owner, 2026-10-01: "we will have to accomadate multiple tablet setups"
  assert.ok(!code.includes('TABLET_CHOICES') && !code.includes('setPerMap'), 'no single tablets-per-map number any more')
  assert.ok(code.includes('sc.addTablet(') && code.includes('sc.editTablet(') && code.includes('sc.removeTablet('))
  assert.ok(/<TabletLine[\s\S]*?<Seg/.test(code) || /function TabletLine[\s\S]*?<Seg/.test(code), 'a line\'s slots are one tap')
  assert.ok(code.includes('sc.tabletSlots(') && code.includes('sc.MAX_TABLETS'), 'Add tablet stops at four slots')
  assert.ok(code.includes('<Toggle') && code.includes('sc.overrideOn('), 'the override is the house on/off control')
  assert.ok(code.includes('sc.setCostCur('), 'cost currencies are remembered for the next strat')
})

test('every currency field is the CurrencyPicker; custom items come from the same picker', () => {
  assert.ok((code.match(/<CurrencyPicker/g) || []).length >= 3)
  assert.ok(!/<select/.test(code), 'never a raw select of currencies')
  assert.ok(code.includes('onCreate=') && code.includes('sc.addCustom('))
  const picker = read('../src/components/CurrencyPicker.jsx')
  assert.ok(picker.includes('onCreate'), 'the picker can offer a typed name as a new item')
  assert.ok(code.includes('sc.setPrice('), 'any row can carry its own price')
})

test('styleguide: tokens only, house sizes, motion only on edits with a reduced-motion fallback', () => {
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(view), 'no raw hex in the view')
  assert.ok(!/style=\{\{[^}]*color/.test(view), 'no inline colour')
  assert.ok(scCss.includes('.scalc-clock') && /\.scalc-clock[^}]*font-size: 27px/.test(scCss), 'the clock is the big-stat size')
  assert.ok(!/font-size: 34px/.test(scCss), 'no new type size')
  assert.ok(/@media \(prefers-reduced-motion: reduce\)/.test(scCss), 'the flash has a reduced-motion fallback')
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(scCss), 'no raw hex in the calculator css')
})

test('a cost line shows its value only once it costs something: no "0 ◆" before anything is typed', () => {
  assert.ok(code.includes('lineVal('), 'one rule for every cost line')
  assert.ok(!/<span className="scalc-val"><Div v=\{t\.(maps|tablets|override)\}/.test(code), 'never an unguarded line value')
})

test('narrow windows: a cost line\'s picker shrinks so its value is never squeezed out', () => {
  assert.ok(/\.scalc-line \.curpick \{[^}]*min-width: 0/.test(scCss), 'the picker gives way')
  assert.ok(/\.scalc-line \{[^}]*grid-template-columns:[^;]*minmax\(3\.5rem, auto\)/.test(scCss), 'the value column keeps room for a number')
})

test('controls are labelled with names people read: "Remove Divine Orb", never a trade id', () => {
  assert.ok(!code.includes('aria-label={`Remove ${r.cur ?? r.name}`}'))
  assert.ok(code.includes('const label = r.cur ? names[r.cur] ?? r.cur : r.name'))
})

test('uniques: listed in the picker, priced by one background trade search at a time, only when needed', () => {
  assert.ok(code.includes('poe2desktop?.trade?.uniques') && code.includes('sc.addUnique('), 'the trade site\'s uniques are in "Add currency or item…"')
  const pricing = read('../src/lib/stratPricing.js')   // the queue (tested against a fake trade site in stratcalc-pricing.test.mjs)
  assert.ok(code.includes('poe2desktop?.trade') && code.includes('SP.nextPricing(') && pricing.includes('uniqueQuery(r.name, r.base)'), 'the search runs in the desktop shell (the user\'s session), one pricer for everything')
  assert.ok(!code.includes('priceUnique'))
  assert.ok(pricing.includes('sc.needsFloor(') && pricing.includes('sc.floorDiv(') && pricing.includes('sc.recordFloor('))
  assert.ok(/if \(!trade\?\.priceQuery \|\| !open \|\| !league \|\| pending/.test(code), 'one search in flight at a time (uniques and linked lines share the queue); the budget paces the rest')
  assert.ok(/error === 'auth'/.test(code), 'not logged in: stop searching, the row stays open for a typed price')
  const sv = read('../src/components/StrategyView.jsx')
  assert.ok(sv.includes('<StratCalcView league={league}'), 'the search runs in the league the app is on')
})

test('clearing a typed price gives the row back to the market or the trade search', () => {
  assert.ok(/if \(onBlank && !String\(draft\)\.trim\(\)\) \{ onBlank\(\);/.test(code), 'an emptied box says so')
  assert.ok(code.includes('onBlank={() => onPrice(null)}'), 'the price cell treats empty as "no typed price"')
})

test('a price box closes when you click away, not only on Enter', () => {
  assert.ok(code.includes('<span className="scalc-val" onBlur={() => setEditing(false)}>'))
})

test('sizes follow the window, with minimums: no fixed pixel columns, widths or caps in the calculator', () => {
  for (const m of scCss.matchAll(/grid-template-columns:([^;]+);/g)) assert.ok(!/\d+px/.test(m[1]), `columns are relative: ${m[1]}`)
  assert.ok(!/[{;]\s*max-width: \d+px/.test(scCss), 'no pixel cap on the page width (a media query is a window size, not a cap)')
  assert.ok(!/(?:^|[\s;{])(?:min-)?width: \d+px/.test(scCss), 'no fixed pixel widths')
  assert.ok(/\.workspace\.scalc \{[^}]*grid-template-columns: clamp\(/.test(scCss), 'the sidebar grows with the window between a minimum and a maximum')
  const picker = read('../src/components/CurrencyPicker.jsx')
  assert.ok(!/need: Math\.min\(window\.innerHeight \* 0\.44, \d+\)/.test(picker), 'the list\'s room is the window\'s share, not a pixel cap')
})

test('the open strat\'s name is edited right in the sidebar: click it and type (owner: "make the name editable on the sidebar")', () => {
  assert.ok(code.includes('className="scalc-strat-input"'), 'the open strat\'s name is a text box styled as text')
  assert.ok(/scalc-strat-input[\s\S]{0,400}onRename\(/.test(code), 'Enter or clicking away renames it')
  assert.ok(!code.includes('className="scalc-title"'), 'no second place to rename it')
  assert.ok(/\.scalc-strat-input \{[^}]*background: transparent/.test(scCss))
})

test('the time override: hours and minutes in place of the timer, with the house toggle', () => {
  assert.ok(code.includes('sc.timeOverrideOn(') && code.includes('sc.fromHm(') && code.includes('sc.hm('))
  assert.ok(code.includes('label="Hours"') && code.includes('label="Minutes"'))
  assert.ok(code.includes('ariaLabel="Override the session time"'))
})

test('a folder\'s name box selects its text; open/closed is saved from what the tree shows, never flipped blind', () => {
  assert.ok(/<input[^>]*autoFocus[^>]*aria-label="Folder name"/.test(code), 'typing replaces "New folder": it takes focus, and every box selects on focus (select-on-focus.test)')
  assert.ok(/setTimeout\(\(\) => change\(d => sc\.setOpen\(d, id, !!treeRef\.current\?\.get\(id\)\?\.isOpen\)\)/.test(code), 'the tree\'s own state, read once its toggle has landed (onToggle fires before it)')
  assert.ok(code.includes('openByDefault={true}') || code.includes('openByDefault'), 'a new folder opens')
})

test('sidebar polish: every row has an icon so names line up, rates always show, the running strat carries the status dot', () => {
  assert.ok(code.includes('📈'), 'a strat row\'s icon, beside the folder\'s 📁')
  assert.ok(!/ws-trailing scalc-rate/.test(code), 'rates are not hover-only (.ws-trailing hides until hover)')
  assert.ok(code.includes('className="dot ok"'), 'the running strat: the app\'s status dot (it pulses; reduced motion stills it)')
  assert.ok(/\.scalc-tree \{[^}]*padding: 0/.test(scCss), 'the tree measures its real width, so the open row is never clipped')
  assert.ok(/\.scalc-rate \{[^}]*font-variant-numeric: tabular-nums/.test(scCss))
})

test("a red × on each row deletes it right there (owner: right-click isn't intuitive); right-click stays", () => {
  assert.ok(code.includes('className="scalc-x"') && code.includes('aria-label={`Delete ${d.name}`}'), 'one × per row, labelled')
  assert.ok(/scalc-x[\s\S]{0,200}e\.stopPropagation\(\)[\s\S]{0,80}onDelete\(d\)/.test(code), 'deleting never also opens the row')
  assert.ok(code.includes('sc.removeFolderDeep(') && code.includes('sc.restoreFolderDeep('), "a folder's × takes its strats too, with one Undo")
  assert.ok(/label: 'Delete folder, keep strats'/.test(code) && /label: 'Delete folder and its strats'/.test(code))
  assert.ok(/\.scalc-x \{[^}]*color: var\(--loss\)/.test(scCss), 'red: the loss token')
  assert.ok(/\.ws-node:hover \.scalc-x, \.ws-node\.active \.scalc-x/.test(scCss), "shown on hover and on the open strat, like the trade tree's row buttons")
})

// Repros from the 2026-10-01 review, each seen in the packaged app before the fix.
test('repro (review #4): leaving the calculator takes its Undo toast with it, so Undo can never silently fail', () => {
  assert.ok(/useEffect\(\(\) => \(\) => bus\.emit\(\{ id: 'sc-undo', dismiss: true \}\), \[\]\)/.test(code), 'unmount dismisses the toast')
})

test('repro (review #5): a refused trade fetch pauses every unique search until the site says, not just that row', () => {
  assert.ok(/res\?\.error === 'rate'\) \{[\s\S]{0,300}pauseUntil\.current = until/.test(code), 'one refusal pauses every search')
  assert.ok(/t < pauseUntil\.current\) return/.test(code), 'no search starts while paused')
})

test('repro (review #6): typing the name of something already listed goes to its row, never a priceless copy', () => {
  assert.ok(/onCreate: \(name\) => \{\s*const hit = options\.find\(o => o\.name\.toLowerCase\(\) === name\.toLowerCase\(\)\)/.test(code))
})

test('repro (review #9): Escape in a number box cancels; it never commits the half-typed text', () => {
  assert.ok(code.includes('cancelled.current = true') && code.includes('if (cancelled.current) { cancelled.current = false; setDraft(null); return }'))
})

test('repro (review #6): the picker never offers "Add" for a name that already exists, listed or not', () => {
  const picker = read('../src/components/CurrencyPicker.jsx')
  assert.ok(picker.includes('known = null') && picker.includes('known?.has(t)'), 'a host can name what already exists')
  assert.ok(code.includes('known={known}'), 'the calculator passes every name it knows')
})

test('the open strat\'s name box uses the whole row: "Strat 1" is never clipped (owner screenshot, 2026-10-01)', () => {
  const row = code.slice(code.indexOf('function StratRow('), code.indexOf('function StratTree('))
  assert.ok(!row.includes('<span className="spacer" />'), 'no spacer competing with the name box; the rate pushes itself right')
  assert.ok(/\.scalc-tree \.ws-node input\.scalc-strat-input \{[^}]*flex: 1 1 0/.test(scCss), 'the name box takes the free width')
})

test('a tablet is picked from the pipeline\'s table (full uses known), and every tally gets the uses', () => {
  assert.ok(code.includes('setUses(d.uses'), 'the uses come with the strats from GET /api/strategy/calc')
  assert.ok(/function tabletOptions[\s\S]*?uses/.test(code), 'the tablet picker offers what the table knows: never a tablet the cost cannot be worked out for')
  assert.ok(!/sc\.tally\([^)]*now\)/.test(code) && !/sc\.tally\([^)]*Date\.now\(\)\)/.test(code), 'no tally without the uses')
  assert.ok(code.includes('sc.overrideOn(x, prices, uses)'))
})

test('"+ Add tablet" reads on one line: its cell spans the inputs\' columns (drive, 2026-10-01: it wrapped)', () => {
  assert.ok(/\.scalc-addtab-cell\s*\{[^}]*grid-column:\s*2 \/ 4/.test(scCss))
  assert.ok(/\.scalc-addtab\s*\{[^}]*white-space:\s*nowrap/.test(scCss))
  assert.ok(code.includes('className="scalc-addtab-cell"'))
})

// ---------------------------------------------------------------- Build on trade (owner, 2026-10-01)
// "a pop open tab that just temporarily opens a trade filter site that people can edit and a save
// button on it and we just rip the URL from that constructor"; "It doesn't work because there is no
// trade window which allows me to filter for specific mods".
const builder = read('../src/components/TradeBuilder.jsx')

test('Build on trade: the real trade site in a dialog; "Use this search" takes the search the user ran', () => {
  // The window's own address IS its search (a run search lands on a gzip slug, measured 2026-10-01):
  // follow it through the app's existing webview-nav event, read it with searchOfLink. No request capture.
  assert.ok(builder.includes('<webview') && builder.includes('getWebContentsId()'), 'a real trade window, its own address only')
  assert.ok(builder.includes('trade.onWebviewNav(') && builder.includes('shouldAcceptNav('), 'the existing navigation event, filtered to this window')
  assert.ok(!/capture(Start|Take|Stop)/.test(builder), 'no second mechanism, no poll')
  assert.ok(builder.includes('Use this search'))
  assert.ok(builder.includes('detail-backdrop') && builder.includes('card-detail'), 'the app\'s own dialog')
  assert.ok(/Escape/.test(builder), 'Esc closes it')
  assert.ok(!/executeJavaScript|loadURL\(/.test(builder), 'the trade page is never scripted or navigated by the app')
})

test('a tablet line links a search, starts it at full uses, and prices it in the background', () => {
  assert.ok(code.includes('<TradeBuilder') && code.includes('sc.linkTablet(') && code.includes('sc.unlinkTablet('))
  assert.ok(/fullTabletQuery\(/.test(code), 'the window opens, and every price search runs, held to full uses')
  const pricing = read('../src/lib/stratPricing.js')
  assert.ok(code.includes('trade.priceQuery(') && pricing.includes('sc.needsLinkPrice(') && pricing.includes('sc.avgDiv(') && pricing.includes('sc.recordLinkPrice('))
})

test('"Per map" links a waystone search the same way (owner, 2026-10-01: "what about maps")', () => {
  const pricing = read('../src/lib/stratPricing.js')
  assert.ok(code.includes('sc.linkMaps(') && code.includes('sc.unlinkMaps(') && pricing.includes('sc.recordMapsPrice('))
  assert.ok(code.includes('waystonePriceQuery') && pricing.includes('waystonePriceQuery('), 'priced as a buyer pays: Instant Buyout, cheapest first')
  assert.ok(code.includes("map.waystone"), 'a new map search starts on waystones')
  assert.ok(/sc\.needsLinkPrice\(s\.maps/.test(pricing), 'the map search shares the one background queue')
})

test('the trade window also links a pasted trade link or one of the Trading tab\'s searches (no request: the link is the search)', () => {
  assert.ok(builder.includes('searchOfLink('), 'one reader for both')
  assert.ok(builder.includes('Paste a trade link'), 'the paste box says what to do')
  assert.ok(builder.includes('useWorkspace(') && builder.includes('savedSearches(') && builder.includes('Your searches'),
    'the Trading tab\'s saved searches, from the loaded store (no refetch), by the store\'s own rule (no History)')
  assert.ok(!builder.includes('api.workspace()'))
  assert.ok(builder.includes('<CurrencyPicker'), 'the app\'s own picker, not a raw select')
})

test('⟳ on a strat row: the app\'s refresh button; re-prices that strat now and spins while its searches run', () => {
  assert.ok(code.includes("import RefreshButton from './RefreshButton.jsx'") && code.includes('<RefreshButton'))
  assert.ok(code.includes('sc.restale('), 'its floors and linked searches are due now')
  assert.ok(/onRefresh[\s\S]*?retryAt\.current\.clear\(\)/.test(code), 'a refresh forgets this visit\'s back-off')
  assert.ok(/onRefresh[\s\S]*?api\.stratPrices\(\)/.test(code), 'and the market prices come again')
  assert.ok(/\.ws-node:hover \.scalc-refresh/.test(scCss) && /\.ws-node\.active \.scalc-refresh/.test(scCss), 'like the ×: shown on hover and on the open strat')
})

test('"Open in Trading" in the trade window of a linked cost: the search as it is priced, on the Trading tab', () => {
  assert.ok(builder.includes('Open in Trading') && builder.includes('onOpenTrading'))
  assert.ok(code.includes('openInTrading(') && code.includes('nav.goTrading'), 'through lib/stratTrading.js; the app switches tab')
  assert.ok(/priced: \(q\) => fullTabletQuery\(q, n/.test(code) && /onOpenTrading=[\s\S]*?toTrading\(target\.priced\(target\.x\.link\.query\)/.test(code),
    'a tablet opens held to full uses: the listings its price came from')
  const app = read('../src/App.jsx')
  assert.ok(/e\.type === 'goTrading'/.test(app) && app.includes("nav.openTrading('workspace')"))
  const navSrc = read('../src/lib/nav.js')
  assert.ok(navSrc.includes("goTrading(sub = 'workspace')"), 'no target = the Workspace')
})

test('sharing: Export… on a strat or folder (to Downloads), ⤓ Import and a dropped file (copies, "Imported")', () => {
  assert.ok(code.includes("label: 'Export…'") && code.includes('sc.exportStrats('), 'right-click a strat or a folder')
  assert.ok(code.includes('poe2desktop?.ws?.exportFile('), 'the desktop\'s existing file writer: no new bridge')
  assert.ok(code.includes('.arbiterstrat'))
  assert.ok(code.includes('type="file"') && code.includes('accept=".arbiterstrat'), 'the system picker, the right files')
  assert.ok(code.includes('onDrop=') && code.includes('sc.importStrats('), 'a file dropped on the sidebar')
  assert.ok(code.includes("Couldn't read this strat file"), 'one short message when a file is no good')
})

test('a search opened in Trading is named after what it searches for (drive, 2026-10-01: "Any tablet" for a Ritual Tablet search)', () => {
  assert.ok(/onOpenTrading=[\s\S]*?target\.x\.link\.query\.query\?\.type \?\? target\.title/.test(code))
})

test('Esc closes an open list inside the trade window, not the window (drive, 2026-10-01: Esc on "Your searches…" closed it)', () => {
  // the picker marks Esc handled (preventDefault); the window's own Esc listener leaves those alone
  assert.ok(/e\.key === 'Escape' && !e\.defaultPrevented\) onClose\(\)/.test(builder))
  const picker = read('../src/components/CurrencyPicker.jsx')
  assert.ok(/e\.key === 'Escape'\) \{ e\.preventDefault\(\)/.test(picker), 'the picker does mark it')
})

test('a search the trade site asked to wait on is retried when the wait ends, and the queue wakes for it (drive, 2026-10-01: ⟳ left a line due)', () => {
  // the refused item must not keep its hour-long back-off, and nothing else would re-run the queue
  assert.ok(/error === 'rate'\)[\s\S]{0,300}SP\.retryLater\(retryAt\.current, job, until - Date\.now\(\), Date\.now\(\)\)/.test(code), 'due again at the end of the wait, not an hour later (stratPricing.retryLater: unless relinked meanwhile)')
  assert.ok(/error === 'rate'\)[\s\S]{0,400}setTimeout\(\(\) => setWake\(/.test(code), 'a wake-up at the end of the wait')
  assert.ok(/\}, \[open, league, pending, change, uses, wake\]\)/.test(code), 'the wake-up re-runs the queue')
})

test('a row\'s ⟳ and × take no room until shown, so names are not cut short (owner, 2026-10-01: "the truncation bug is back again")', () => {
  // visibility:hidden keeps their width and squeezed every name ("Str…"); display:none gives it back
  assert.ok(!/\.scalc-(x|refresh)[^{]*\{[^}]*visibility:\s*hidden/.test(scCss), 'never a hidden button holding its width')
  assert.ok(/\.scalc-tree \.refresh-btn\.scalc-refresh\s*\{[^}]*display:\s*none/.test(scCss))
  assert.ok(/\.scalc-x\s*\{[^}]*display:\s*none/.test(scCss))
  assert.ok(/\.ws-node:hover \.scalc-x[^{]*\{[^}]*display:/.test(scCss), 'shown on hover and on the open strat')
})

test('loot rows carry a small "+" that adds one (right-click: one back); fixed costs do not', () => {
  assert.match(code, /className="cap-x scalc-inc"/)
  assert.match(code, /aria-label=\{`Add one \$\{label\}`\}/)
  assert.match(code, /onContextMenu=\{e => \{ e\.preventDefault\(\); onBump\(key, -1\) \}\}/)
  const loot = code.slice(code.indexOf('<h2>Loot</h2>'), code.indexOf('scalc-costs'))
  const fixed = code.slice(code.indexOf('scalc-micro">Fixed'))
  assert.match(loot, /\{\.\.\.rowsEdit\('loot'\)\} bump/)
  assert.doesNotMatch(fixed.slice(0, fixed.indexOf('/>')), /\bbump\b/)
  assert.match(scCss + css, /\.scalc-inc\s*\{/)
})

test('the trade window follows the page\'s own search, and linking prices the new search at once', () => {
  const tb = read('../src/components/TradeBuilder.jsx')
  assert.match(tb, /windowSearch\(/)
  assert.match(tb, /trade\.onTap\?\.\(/)
  assert.match(code, /SP\.relinked\(retryAt\.current, building\)/)
  assert.match(code, /SP\.nextPricing\(/)
})

test('unlinking hands the prices over, and a found price reads as a price, not an empty box', () => {
  assert.match(code, /sc\.unlinkMaps\(d, d\.active, Date\.now\(\), prices\)/)
  assert.match(code, /sc\.unlinkTablet\(d, d\.active, built\.id, Date\.now\(\), prices\)/)
  assert.match(code, /className=\{`scalc-in\$\{found \? ' scalc-found' : ''\}`\}/)
  assert.match(scCss + css, /\.scalc-found::placeholder\s*\{/)
})

// code review (2026-10-03)
test('a line re-pricing shows its "…" as pending, not as a found price', () => {
  assert.doesNotMatch(code, /found=\{!!foundIn\(/)
  assert.match(code, /foundBox\(/)
})

test('"Use this search" on the linked search changes nothing; any other search relinks', () => {
  assert.match(code, /SP\.sameSearch\(/)
})

test('the view keys its pending marker with the queue\'s own keys and imports nothing it no longer uses', () => {
  assert.match(code, /SP\.linkKey\('maps'\)/)
  assert.match(code, /SP\.linkKey\(l\.id\)/)
  assert.doesNotMatch(read('../src/components/StratCalcView.jsx').split('\n').find(l => l.includes("from '../lib/regex/trade.js'")), /uniqueQuery/)
})
