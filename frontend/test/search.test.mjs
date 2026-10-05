// One search for every box (Discord idea 2026-10-03: trade-site "~" keyword search; owner: make it "just work for
// everyone", KISS). Design: docs/search-design.md. Every typed word must be in the name, in any order; today's tiers;
// typo tolerance only when nothing else matches. These names are test data, never shipped.
import test from 'node:test'
import assert from 'node:assert/strict'
const { search, matching } = await import('../src/lib/search.js')

const O = (name, extra = {}) => ({ id: name.toLowerCase().replace(/\W+/g, '-'), name, ...extra })
const NAMES = ['Exalted Orb', 'Greater Exalted Orb', 'Perfect Exalted Orb', 'Omen of Greater Exaltation', 'Omen of Dextral Exaltation',
  'Divine Orb', 'Chaos Orb', 'Greater Chaos Orb', 'Omen of Chaotic Rarity', 'Orb of Augmentation', "Uhtred's Augury", 'Vaal Orb',
  "Vaal Armourer's Infuser", 'Vaal Siphoner', 'Ancient Vaal Relic', "Xoph's Pyre", "Xoph's Catalyst", "Uul-Netol's Embrace",
  'Perfect Essence of Ruin', 'Lesser Essence of Ruin', 'Thaumaturgic Flux (Level 11)', 'Thaumaturgic Flux (Level 2)',
  "Cholotl's Soul Core of War", 'Orb of Annulment', "Gemcutter's Prism", "Blacksmith's Whetstone", "Armourer's Scrap",
  'Simulacrum Splinter', 'Simulacrum', 'Cold Snap Rune', 'Expedition Logbook']
const items = NAMES.map(n => O(n))
const pick = (q, list = items) => search(list, q, o => [[o.name], o.keywords, o.id]).map(o => o.name)
const filter = (rows, q) => matching(rows, q, r => [r])

// --- today's picker contract (was test/picker-match.test.mjs) still holds ---
const vaal = [O("Vaal Armourer's Infuser"), O("Vaal Blacksmith's Infuser"), O('Vaal Cultivation Orb'), O('Ancient Vaal Relic'),
  O('Vaal Orb'), O('Ruby Charm', { keywords: ['ruby'] }), O('Ruby')]

test('an exact name comes first, then names starting with the text (shorter first), then names containing it', () => {
  assert.deepEqual(pick('vaal orb', vaal), ['Vaal Orb', 'Vaal Cultivation Orb'], 'the exact name, then other names with both words')
  assert.deepEqual(pick('vaal', vaal).slice(0, 5),
    ['Vaal Orb', 'Vaal Cultivation Orb', "Vaal Armourer's Infuser", "Vaal Blacksmith's Infuser", 'Ancient Vaal Relic'])
  assert.equal(pick('vaal', [...vaal, O('Vaal')])[0], 'Vaal', 'the exact name leads')
  assert.deepEqual(pick('ruby', vaal), ['Ruby', 'Ruby Charm'])
  assert.equal(pick('vaal o', vaal)[0], 'Vaal Orb')
})

test('a blank search returns the list itself, in its own order', () => {
  assert.equal(search(items, '  ', o => [[o.name]]), items)
})

test('an exact trade id ranks first; an id containing the text ranks with the contains hits, not as a name', () => {
  const real = [O("Vaal Arcanist's Infuser"), O('Vaal Cultivation Orb'), { id: 'vaal', name: 'Vaal Orb' }, O('Vaal Siphoner')]
  assert.equal(pick('vaal', real)[0], 'Vaal Orb')
  assert.equal(pick('vaal', [O('Vaal Gem'), ...real])[0], 'Vaal Orb', 'the exact id beats a shorter name')
  const gcp = [O('Gold Coin Purse'), { id: 'gcp', name: "Gemcutter's Prism" }]
  assert.equal(pick('gcp', gcp)[0], "Gemcutter's Prism", 'players type the trade id')
  const pools = [{ id: 'map', name: 'Waystones' }, { id: 'mana', name: 'Mana Flasks' }]
  assert.deepEqual(pick('ma', pools), ['Mana Flasks', 'Waystones'], 'a name start beats an id that merely contains the text')
})

test('hidden keyword hits come after every name hit', () => {
  const pools = [{ id: 'jewel-ruby', name: 'Jewels · Ruby' }, { id: 'ring', name: 'Rings', keywords: ['Ruby Ring', 'Sapphire Ring'] }]
  assert.deepEqual(pick('ruby', pools), ['Jewels · Ruby', 'Rings'])
  assert.deepEqual(pick('sapphire ring', pools), ['Rings'])
})

// QA (2026-10-04): typing the whole word dropped the item below longer names ("alchemy" put Omen of Sinistral
// Alchemy above Orb of Alchemy). Among names that only contain the text, shorter names come first too.
test('a whole word finds the shortest name holding it first', () => {
  const real = ['Omen of Sinistral Alchemy', 'Omen of Dextral Alchemy', 'Orb of Alchemy', 'Greater Orb of Augmentation',
    'Orb of Augmentation', 'Omen of Dextral Annulment', 'Omen of Sinistral Annulment', 'Orb of Annulment'].map(n => O(n))
  assert.equal(pick('alchemy', real)[0], 'Orb of Alchemy')
  assert.equal(pick('augmentation', real)[0], 'Orb of Augmentation')
  assert.equal(pick('annulment', real)[0], 'Orb of Annulment')
})

// --- the idea: key words, any order, no special character ---
test('every typed word must be in the name, in any order, and a typed ~ is ignored', () => {
  assert.deepEqual(pick('gre exa').slice(0, 2), ['Greater Exalted Orb', 'Omen of Greater Exaltation'])
  assert.deepEqual(pick('~gre exa'), pick('gre exa'))
  assert.deepEqual(pick('ess ruin perf'), ['Perfect Essence of Ruin'])
  assert.deepEqual(pick('soul core war'), ["Cholotl's Soul Core of War"])
  assert.deepEqual(pick('flux 11'), ['Thaumaturgic Flux (Level 11)'])
})

test('case, accents, apostrophes and hyphens are ignored', () => {
  assert.deepEqual(pick('xophs'), ["Xoph's Pyre", "Xoph's Catalyst"])
  assert.deepEqual(pick('XOPH’S PYRE'), ["Xoph's Pyre"])
  assert.deepEqual(pick('uulnetol'), ["Uul-Netol's Embrace"])
  assert.deepEqual(pick('morrigan', [O('Mórrigan’s Rune')]), ['Mórrigan’s Rune'])
})

test('2-3 letter text still matches inside a word, so nothing found today is lost (owner, 2026-10-04)', () => {
  assert.ok(pick('aug').includes("Uhtred's Augury") && pick('aug').includes('Orb of Augmentation'))
  const real = items.map(o => (o.name === 'Orb of Augmentation' ? { ...o, id: 'aug' } : o))   // its real trade id
  assert.equal(pick('aug', real)[0], 'Orb of Augmentation', 'players type the trade id; it ranks first')
  assert.ok(filter(['Crossbows', 'Bows'], 'bow').length === 2)
  assert.ok(pick('ex').includes('Omen of Dextral Exaltation'))
})

// --- typos: only when nothing else matches ---
test('a misspelled name is found when nothing matches as typed', () => {
  assert.equal(pick('exalterd')[0], 'Exalted Orb')
  assert.deepEqual(pick('devine'), ['Divine Orb'])
  assert.equal(pick('chaoss orb')[0], 'Chaos Orb')
  assert.equal(pick('annulmnet')[0], 'Orb of Annulment', 'two swapped letters are one slip')
})

test('the typo pass never adds lookalikes to a search that already matches', () => {
  assert.deepEqual(pick('chaos'), ['Chaos Orb', 'Greater Chaos Orb'], 'no Chaotic omen')
  assert.deepEqual(pick('cold'), ['Cold Snap Rune'])
})

test('short words must be typed right, and the slip budget is 1 from 4 letters, 2 from 8', () => {
  assert.deepEqual(pick('vaql'), ['Vaal Orb', 'Vaal Siphoner', 'Ancient Vaal Relic', "Vaal Armourer's Infuser"], '4 letters: 1 slip; shorter first')
  assert.deepEqual(pick('vab'), [], '3 letters: no slips, though "vab" is 1 from "vaa"')
  assert.deepEqual(pick('anull'), [], '"anull" is 2 slips from "annul": over the 1-slip budget')
  assert.equal(pick('gemcuttrs prsm')[0], "Gemcutter's Prism")
})

test('a misspelled name hit ranks before a misspelled keyword hit', () => {
  const list = [{ id: 'a', name: 'Rings', keywords: ['Sapphire Ring'] }, { id: 'b', name: 'Sapphire Charm' }]
  assert.deepEqual(pick('saphire', list), ['Sapphire Charm', 'Rings'])
})

// --- modifier filters ---
const MODS = ['+#% to Fire Resistance', '+#% to Cold Resistance', '+# to maximum Life', '#% increased Movement Speed', 'Adds # to # Fire Damage']
test('modifier filters: words in any order, and a typed number fills the # slot', () => {
  assert.deepEqual(filter(MODS, 'res fire'), ['+#% to Fire Resistance'])
  assert.deepEqual(filter(MODS, '30 fire res'), ['+#% to Fire Resistance'])
  assert.deepEqual(filter(MODS, '+30% to Fire Resistance'), ['+#% to Fire Resistance'], 'a pasted modifier line')
  assert.deepEqual(filter(MODS, 'max life'), ['+# to maximum Life'])
  assert.deepEqual(filter(MODS, 'fire'), ['+#% to Fire Resistance', 'Adds # to # Fire Damage'], 'a filter keeps its list order')
})

// --- the guarantee: never lose a result today's picker finds ---
// Today's rankMatches (frontend/src/lib/pickerMatch.js before this change), kept here as the oracle.
function todays(options, q) {
  const t = String(q || '').trim().toLowerCase()
  if (!t) return options
  const name = (o) => o.name.toLowerCase()
  const direct = options.filter(o => name(o).includes(t) || String(o.id).toLowerCase().includes(t))
  const viaKeyword = options.filter(o => !direct.includes(o) && o.keywords?.some(k => k.toLowerCase().includes(t)))
  return [...direct, ...viaKeyword]
}
test('every substring of every name finds at least what today finds', () => {
  let checked = 0
  for (const o of items) for (let i = 0; i < o.name.length; i++) for (const L of [2, 3, 5, 9]) {
    const q = o.name.slice(i, i + L)
    if (!q.trim()) continue
    const now = new Set(pick(q).map(String))
    for (const was of todays(items, q)) assert.ok(now.has(was.name), `"${q}" lost ${was.name}`)
    checked++
  }
  assert.ok(checked > 500)
})

// --- every search box uses it ---
import { readFileSync, existsSync } from 'node:fs'
const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8')

test('the item picker ranks with search(), matching names, hidden keywords and the exact trade id', () => {
  const p = src('components/CurrencyPicker.jsx')
  assert.match(p, /import \{ norm, search \} from '\.\.\/lib\/search\.js'/)
  assert.match(p, /search\(options, q, o => \[\[o\.name\], o\.keywords, o\.id\]\)/)
  assert.match(p, /found\.some\(o => norm\(o\.name\) === norm\(q\)\)/, '"Add …" is offered unless a name already matches, apostrophes and case aside')
  // Owner (2026-10-04): "always prioritize a currency we know of": the typed wording is offered last, even when the
  // only matches are typo matches, so Enter takes the known item and the user picks their own wording on purpose.
  assert.match(p, /return onCreate && !exact \? \[\.\.\.found, \{ id: CREATE/)
  assert.doesNotMatch(p, /\.typos/)
  assert.ok(!existsSync(new URL('../src/lib/pickerMatch.js', import.meta.url)), 'the old matcher is gone')
})

test('the filter boxes keep their own order and use the shared search', () => {
  const m = src('components/ModPicker.jsx')
  assert.match(m, /matching\(pool, filter, m => \[m\.text\]\)/)
  assert.match(m, /\[mods, hide, norm\(filter\), settled\]/, 'a trailing space or a case change never reorders the list')
  const mk = src('components/MarketView.jsx')
  assert.match(mk, /useMemo\(\(\) => matching\(edges, q, e => \[`\$\{e\.from_name\} \$\{e\.to_name\} \$\{e\.from\} \$\{e\.to\}`\]\), \[edges, q\]\)/, 'one joined text, so "div chaos" spans both names; searched only when the text or the list changes')
  assert.match(src('components/StashView.jsx'), /stashMatches\(rows, q\)/)
  assert.match(src('components/SearchTree.jsx'), /filterHits\(data, filter\)/)
  const mv = src('components/ModsView.jsx')
  assert.match(mv, /modMatches\(levels, filter\)/, 'one typo decision across the whole tab')
  for (const f of ['lib/palette.js', 'lib/stash.js', 'lib/tree.js', 'lib/mods/pool.js', 'components/MarketView.jsx', 'components/ModPicker.jsx'])
    assert.doesNotMatch(src(f), /toLowerCase\(\)\)?\.includes\(|\.includes\((needle|term|q|t)\)/, `${f} has no hand-rolled substring filter left`)
})

test('matching() is the rows the shared search keeps, every row for a blank search', () => {
  const rows = [{ t: 'Fire Resistance' }, { t: 'Cold Resistance' }]
  assert.deepEqual(matching(rows, 'res fire', r => [r.t]), [rows[0]])
  assert.deepEqual(matching(rows, ' ', r => [r.t]), rows)
})

// code review (2026-10-04)
test('letters in any script are kept: a Cyrillic or Chinese name narrows the list like any other', () => {
  assert.deepEqual(filter(['Мой билд', 'Belt', '金币 farm'], 'билд'), ['Мой билд'])
  assert.deepEqual(filter(['Мой билд', 'Belt', '金币 farm'], 'билд мой'), ['Мой билд'], 'words in any order, in any script')
  assert.deepEqual(filter(['Мой билд', 'Belt', '金币 farm'], '金币'), ['金币 farm'])
  assert.deepEqual(filter(['Æther Ring', 'Belt'], 'æther'), ['Æther Ring'])
})

test('text that is only punctuation matches as typed, as before; a blank box still lists everything', () => {
  for (const q of ['+', '='])
    assert.deepEqual(search(items, q, o => [[o.name]]), [], JSON.stringify(q))
  assert.equal(search(items, ' ~ ', o => [[o.name]]), items, 'QA 2: a lone ~ (trade-site habit) is a blank box')
  assert.deepEqual(pick('-'), ["Uul-Netol's Embrace"])
  assert.deepEqual(filter(MODS, '%'), ['+#% to Fire Resistance', '+#% to Cold Resistance', '#% increased Movement Speed'])
  assert.equal(search(items, '', o => [[o.name]]), items)
})

test('an id matches as typed (hyphens kept), and an id-only hit comes after the name hits', () => {
  const list = [{ id: 'omen-of-chaotic-effectiveness', name: 'Omen of Chaotic Effectiveness' }, { id: 'ice', name: 'Essence of Ice' }]
  assert.deepEqual(pick('ice', list), ['Essence of Ice'], '"ice" never matches across the hyphens of chaotic-effectiveness')
  const vaal = [{ id: 'vaal-shard', name: 'Shard' }, { id: 'x', name: 'Big Vaal Thing' }]
  assert.deepEqual(pick('vaal', vaal), ['Big Vaal Thing', 'Shard'])
})

test('matching() keeps the list order', () => {
  const rows = ['Greater Chaos Orb', 'Chaos Orb', 'Chaotic Omen']
  assert.deepEqual(matching(rows, 'chaos', r => [r]), ['Greater Chaos Orb', 'Chaos Orb'])
})

// QA pass 2 (2026-10-04): typo matches came back in list (alphabetical) order, so "anullment" put Orb of Annulment
// behind the Omens and "vall orb" put Vaal Cultivation Orb above Vaal Orb. Among equal slips, shorter names first.
test('typo matches put the shortest name first among equal slips', () => {
  const real = ['Omen of Dextral Annulment', 'Omen of Greater Annulment', 'Omen of Sinistral Annulment', 'Orb of Annulment',
    'Vaal Cultivation Orb', 'Vaal Orb', 'Ancient Concentrated Liquid Isolation', 'Concentrated Liquid Isolation'].map(n => O(n))
  assert.equal(pick('anullment', real)[0], 'Orb of Annulment')
  assert.equal(pick('vall orb', real)[0], 'Vaal Orb')
  assert.equal(pick('concentratd isolation', real)[0], 'Concentrated Liquid Isolation')
})

// Owner (2026-10-05): holding ↓ in a picker moved the highlight past the bottom of the list without scrolling it.
test('the picker keeps the highlighted row in view as you arrow through, as the ⌘K palette does', () => {
  const p = src('components/CurrencyPicker.jsx')
  assert.match(p, /querySelector\('\.cmdk-item\.sel'\)\?\.scrollIntoView\(\{ block: 'nearest' \}\)/)
  assert.match(p, /\}, \[sel, open\]\)/, 'runs whenever the highlight moves while the list is open')
})
