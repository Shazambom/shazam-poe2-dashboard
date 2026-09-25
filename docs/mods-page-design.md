# Trading → Mods: the design

The UI for the mods page in [`mods-page-roadmap.md`](mods-page-roadmap.md). Decided 2026-09-25 after
driving poe2db's Modifiers Calc live and running four independent designs against each other (the
synthesis note is at the end). Nothing here is built yet.

The tab answers one question: **on this kind of item, what can this orb add at this item level, and
how likely is each thing?** Everything else is one level down or cut.

## The facts the page is built on

- **PoE2 spawn weights are 0 or 1.** A tier either rolls on a base or it does not, and every tier
  in the pool is equally likely. So a family's weight is its number of tiers in the pool, the
  overall weight is the sum over the affix type, and the chance is the ratio. poe2db prints tiers
  × 1000 and a banner admitting it; we print the count and the real percentage.
- **The pool has two edges.** The item level is the top (a tier above it cannot roll). The
  minimum modifier level is the bottom, and it comes from the currency used. A tier below the
  floor is out of the pool: it cannot roll, it carries no weight, it leaves the totals. Strict,
  no exceptions (poe2db keeps each family's top tier under its Min iLvL; that is poe2db's quirk,
  not the game). The complete index of currencies that bound the pool is below.

## Currencies that bound the pool

Indexed 2026-09-25 from every stackable currency on poe2db (263 items), which renders the game's
`TieredCurrency` (MinimumModLevel per orb tier) and `AbyssBenchTicketTypes` (MaximumItemLevel and
MinimumModLevel per bone) tables. ggpk.exposed refuses those two files (error 1101), so the
values were read off the item pages. Sixteen items carry a level rule; nothing else does
(essences add a fixed modifier, jeweller's orbs add sockets, Vaal and fracturing orbs do not
touch the pool, Preserved bones have no bound).

| Currency | Floor (min modifier level) | Cap (max item level) | Applies to |
|---|---|---|---|
| Orb of Transmutation / Augmentation / Regal / Exalted / Chaos | none | | the base orbs |
| Greater Orb of Transmutation | 44 | | normal → magic, 1 mod |
| Perfect Orb of Transmutation | 70 | | |
| Greater Orb of Augmentation | 44 | | magic, +1 mod |
| Perfect Orb of Augmentation | 70 | | |
| Greater Regal Orb | 35 | | magic → rare, +1 mod |
| Perfect Regal Orb | 50 | | |
| Greater Exalted Orb | 35 | | rare, +1 mod |
| Perfect Exalted Orb | 50 | | |
| Greater Chaos Orb | 35 | | rare, remove 1 + add 1 |
| Perfect Chaos Orb | 50 | | |
| Gnawed Jawbone / Rib / Collarbone | none | 64 | desecration; weapons and quivers / armour / amulet, ring, belt; usable only on items of level 64 or below |
| Preserved Jawbone / Rib / Collarbone | none | none | desecration, no bound |
| Ancient Jawbone / Rib / Collarbone | 40 | none | desecration |

So the floor takes one of six values: 0, 35, 40, 44, 50, 70. The magic-item orbs (Transmutation,
Augmentation) sit higher than the rare-item orbs (Regal, Exalted, Chaos), and the bones have
their own value. The Gnawed cap is not a pool edge; it is a rule on which items the bone can be
used on, and it matters for the phase 2 Desecrated section (an item above 64 cannot take a
Gnawed bone at all).
- **The unit of lookup is a pool, not a base.** The pool is decided by the base's tags, so every
  ring shares one pool while gloves split by attribute. Collapsing bases by their spawn-tag set
  reproduces poe2db's index (Rings 1, Amulets 1, Belts 1, Gloves and Boots and Body Armour and
  Helmets by str/dex/int, Shields 3) and is finer where poe2db is wrong: Bone, Galvanic, Volatile,
  Frigid and Withered wands carry tags that exclude the other elements' spell mods, so they get
  their own entries instead of poe2db's single Wands page. Verified on the export 2026-09-25.

## Layout

Trading → Mods, the last sub-tab. One sticky bar, two tables. No modal, no simulator.

```
 Workspace   Live   Sales   Regex   Mods
 ┌ bar (sticky) ──────────────────────────────────────────────────────────────────────────┐
 │ [Rings                    ▾]   Item level [ 82 ]   Min level [ any ]  Orb [Any              ▾]   [Filter modifiers   ] │
 │  Life  Mana  Attack  Caster  Fire  Cold  Lightning  Chaos  Physical  Speed  Attribute  Resistance      │
 └─────────────────────────────────────────────────────────────────────────────────────────┘

 ┌ PREFIX ────────────────────────────── Tiers  Chance ┐ ┌ SUFFIX ─────────────────────── Tiers  Chance ┐
 │ ▸ +# to maximum Life              Life     8 / 8   11.9% │ │ ▸ +#% to Fire Resistance   Fire    8 / 8   7.3% │
 │ ▸ +# to maximum Mana              Mana    12 / 12  17.9% │ │ ▸ +# to Strength           Attrib  8 / 8   7.3% │
 │ ▸ Adds # to # Physical Damage     Phys     8 / 8   11.9% │ │ ▸ #% increased Cast Speed  Speed   6 / 6   5.5% │
 │ ▸ …                                                      │ │ ▸ …                                              │
 │──────────────────────────────────────────────────────── │ │─────────────────────────────────────────────── │
 │   Total                              67        100%      │ │   Total                          110      100%  │
 └──────────────────────────────────────────────────────────┘ └─────────────────────────────────────────────────┘
```

The same pool with Greater Exalted chosen (floor 35), item level 50, Life expanded:

```
 │ [Rings                    ▾]   Item level [ 50 ]   Min level [ 35 ]  Orb [Greater Exalted  ▾]   [life               ] │

 ┌ PREFIX ────────────────────────────── Tiers  Chance ┐
 │ ▾ +# to maximum Life              Life     2 / 8    7.7% │
 │   ┌ Each tier 3.8%                                      ┐ │
 │   │  T1   Virile      54   +(100–119) to maximum Life  – │ │   above the item level: muted
 │   │  ──────────────────────────────────────────────────  │ │
 │   │  T2   Rotund      46   +(85–99) to maximum Life      │ │   in the pool: ink
 │   │  T3   Robust      38   +(70–84) to maximum Life      │ │
 │   │  ──────────────────────────────────────────────────  │ │
 │   │  T4   Stout       33   +(60–69) to maximum Life    – │ │   below the min level: muted
 │   │  …                                                   │ │
 │   │  T8   Hale         1   +(10–19) to maximum Life    – │ │
 │   │                                  [Search on trade]   │ │
 │   └──────────────────────────────────────────────────────┘ │
 │ ▸ +# to maximum Mana              Mana     4 / 12  14.3% │
 │──────────────────────────────────────────────────────── │
 │   Total                              26        100%      │
 └──────────────────────────────────────────────────────────┘
```

(Ring Life tiers are T8 Hale 1, T7 Healthy 6, T6 Sanguine 16, T5 Stalwart 24, T4 Stout 33, T3
Robust 38, T2 Rotund 46, T1 Virile 54, read off poe2db; between 35 and 50 the pool holds T3 and
T2. Ranges and percentages in the sketches are illustrative. Tiers list best first.)

Two hairlines split the tier list into three bands: above the item level, in the pool, below the
minimum level. A band with nothing in it draws no line. Position, ink and the dash carry the
state; colour is never the only mark. The row under an expanded family does not move, and the
Total stays on screen while tiers are read, which poe2db's modal hides.

## Controls

| Control | Widget | Default | Recomputes | Persisted |
|---|---|---|---|---|
| Pool | `CurrencyPicker` (`renderIcon={null}`), one option per pool variant, named `Rings`, `Body Armour · Str/Int`, `Wand · Bone, Offering`; base names are hidden keywords so "siph" finds the right wand | last used, else Rings | the pool, the tag chips | yes |
| Item level | `Num` (lifted out of `RegexView.jsx` into `components/Num.jsx`), 1..100 | 82 | the pool's top edge: every count, total and % | yes |
| Min level | `Num`, 0..100, placeholder `any` (0 = no floor) | any | the pool's bottom edge: every count, total and % | yes |
| Orb | `CurrencyPicker` with the currency icon, options = the 16 currencies in the index above grouped by orb (Any; Greater / Perfect Transmutation 44 / 70; Augmentation 44 / 70; Regal 35 / 50; Exalted 35 / 50; Chaos 35 / 50; Ancient bones 40); choosing one writes the floor | Any | the floor, hence the same | no, derived from the floor: the picker shows the first orb whose floor matches the number, or `Any` when none does |
| Tag chips | pill buttons built from the pool's own tags, multi-select, OR | none | which rows show (never the numbers) | yes |
| Filter | `.ws-filter-input` over family text and tag names | empty | which rows show (never the numbers) | no |

The two level boxes are separate and uncoupled. The item level is a fact about the item you
hold; the floor is a fact about the orb. A floor above the item level is a real question with a
real answer (nothing), so the boxes never drag each other along the way the Regex tier range
does. The orb picker is derived from the floor number: choosing an orb writes its floor, the
picker shows the orb the number matches (the first of a tie, so 35 reads `Greater Exalted` and
44 `Greater Transmutation`), and a typed 60 shows `Any`. One persisted value, no way to disagree.
The box stays because the owner types numbers and a new orb grade would otherwise need a release.
It is a picker rather than a `Seg` because six floors across five orb families is past a Seg's
two to four options, and the icon says which orb you are modelling at a glance. The pool the
picker gives is exactly what that orb rolls from, whatever the item's current mod count; how
many mods an item can still take is phase 3 (your item against the pool).

Row order is game order and never changes with a level, so the row under the pointer stays
there. No sort controls, no Prefix/Suffix/Both switch (the two columns are the split), no Reset.

**Cut from poe2db** and why: the weight banner and the ×1000 badges (placeholder, provenance);
the crafting simulator and its currency row (a different workflow, out of phase 1); Import Item
and Toggle Hide (phase 3, the EE2 clipboard parser does it better); the per-source tables
(Otherworldly, Genesis Tree, Desecrated, Essence, Perfect Essence, Corrupted, Sacrifice: phase 2,
as sections under the base tables); the tier modal with its internal family name, info icon and
"+"; the max-ilvl column and the legend row; the fixed 27-chip tag row and the pile of chips per
row (ours come from the pool, two per row at most); a base picker (a control whose every option
gives the same table).

## The numbers

For a family at item level `L` and min level `F`, a tier is in the pool iff it has weight 1 on
the pool's tags (RePoE rule: the first tag the base carries decides) and `F ≤ level ≤ L`.

- **Weight** (the owner's "mod weight") = tiers in the pool, `k`, shown as `k / n` against the
  family's full tier count.
- **Overall weight** = `N = Σ k` over the affix type, the Total row. Moves with both edges.
- **Chance** = `k / N`, one decimal. Sums to 100% per column.
- **Each tier** = `1 / N`, the same for every tier in the pool, so it is stated once at the top of
  the expanded list rather than repeated per row.

Raising the item level admits tiers from the top and grows `N`, so an untouched family's share
falls. Raising the floor removes tiers from the bottom, shrinks `N`, and drops whole families
whose ladder sits under it to `0 / n`; the survivors' shares rise. That step is the reason to buy
the more expensive orb, and it is one click.

**The denominator rule.** Only the two level boxes change a number. Filter text and tag chips
hide rows; the chances still measure each family against the whole pool. The Total row shows
`N` and the summed chance of the rows on screen: 100% unfiltered, and with a filter the chance the
orb adds any of the families shown. That is a `pool.js` invariant with a test, not a UI nicety.

**Family row**: chevron · text with `#` for the roll (game markup stripped at sync) · up to two
tag chips, muted · `Tiers` as `k / n` · `Chance`. A family with `k = 0` stays in place, muted,
`0 / n`, `–`, still expandable so the user sees which edge shut it. **Tier row**: `T#` · tier
name · level · text with the range substituted. **Tier header** (desktop only): `Search on trade`
(built 2026-09-25): an Instant Buyout query for items of the pool's kind carrying the family,
into the Workspace through `useWorkspace.ingest` as `RegexView.onTrade` does. Nothing about it
is hand-listed: the desktop's `trade/modsearch.js` reads the trade site's stat catalogue and
EE2's item catalogue (both in `vendor/ee2-query/data`, synced every release) once; a family's
text finds its stat ids (the site prints a stat without its sign), a hybrid is one count group
per line, and the kind's category is the one most of the pool's bases fall under in EE2's
category table (none for claws and traps: the stat alone). Where the site lists a mod was
measured over every pool: a prefix or suffix under `explicit` and `desecrated` (both searched),
a corrupted mod and its upgrade under `enchant`. A text the site lacks (some hybrids, a few
socketable mods) gets a toast to search by hand. `Find in stash` for waystone and tablet pools
into the Regex tab is still to come.

## The other pools (built 2026-09-25)

Every item class with a pool is an item type in the picker, 94 in all: the equipment classes
(class × spawn-tag variant), jewels (each jewel is its own pool: Ruby, Emerald, Sapphire, Diamond
and the Time-Lost four), life and mana flasks, charms, relics (small, medium, large), waystones
(the four tier bands Low T1–5, Mid T6–10, High T11–15, Top T16), the eight tablets, and
expedition logbooks (whose mods key on the areas a logbook can hold, so its pool is every tag
its domain uses). Each lives in its own mod domain; the pool's `domain` field says which.
Sanctified relics have no mod that keys on them and are not a pool.

Below the base tables, one collapsed section per currency that opens its own pool on the item,
shown only when it has something for this item type, remembered open or closed for the session.
These are equipment's; a jewel, flask, relic, waystone, tablet or logbook has its base pool only.

- **Desecrated**: one section for the game's desecrated domain, as poe2db shows it: the families
  keyed on the bones (`ulaman_mod`, `amanamu_mod`, `kurgal_mod`) and on breach desecration
  (Tul's, Xoph's, Esh's, Uul-Netol's), each family carrying its key as a tag, so the bones are
  chips. Keys of one non-item domain always share a section; item-domain keys get their own.
  The pool is the base tags plus the keys; every bone mod is level 65.
- **Genesis Tree · Caster / Minion** on amulets, rings and belts: the families keyed on the
  tree's tags, with the mods' own base weights.
- **Thrud's Might** (weapons), **Kolr's Hunt** and **Katla's Gloom** (gloves), **Vorana's Carnage**
  (helmets), **Medved's Tending** (body armour), **Uhtred's Sidereus** (boots): the families keyed
  on the socketable's tag; the mods carry no base tag, so the class list is the socketable's.
- **Corrupted**: the Vaal Orb implicits, one column. **Corrupted upgrade**: the stronger implicit a
  Vaal Orb can turn the base implicit into (the game files it as a unique mod), one column.
- **Essence**: what every essence forces on this class, Lesser to Perfect, with affix and level.
  **Alloy**: the same for the thirteen alloys. The game keeps both in tables ggpk.exposed refuses
  to serve, so `scripts/mods-essences.mjs` reads poe2db's essence and alloy pages (which render
  those tables) into `essences.json`.
- **Socketables**: every rune, soul core and idol that fits the class, with what it grants there
  and its bonded effect (from the export's augments table).

The orb floor applies where regular orbs roll the pool: the base pool and the socketable
uniques' pools. A bone, the Genesis Tree and a Vaal Orb have no minimum modifier level, so
those sections ignore it (a bone's own floor never bites: every desecrated mod is level 65).
The item level applies everywhere. Filter and tag chips apply to every table; chips are
counted over every table. All of it is the same `atLevel` arithmetic over a section's pool
(`sectionsFor` in `pool.js`), so the numbers mean the same thing in every table.

Not modelled, and why: poe2db's PoE1 leftovers (influences, Delve, Synthesis, Bestiary,
Recombinator) are not PoE2; Liquid Emotions instil passives, not mods; Haunted modifiers and
Rotmother's Ducat are not in the export; the Kulemak set is granted skills with no text; the
Watcher set belongs to a unique the export does not name a base for; the 411 "hand wraps" mods
and the other zero-weight leftovers (`of the Stars`, `of the Hunt`) have no tag anything carries.

## The loop, made robust

Owner's loop: expand a family, type an item level or a floor (or pick an orb), read the
weights and the total, repeat.

- **Keyboard.** Family rows are a roving-tabindex list per column: ↑/↓ move, Home/End jump,
  Enter/Space toggle, Esc collapses and keeps focus, ←/→ hop to the other column. Tab order:
  pool, item level, min level, the orb picker, filter, chips, prefix rows, suffix rows. Both
  boxes select on focus, ↑/↓ step 1, Shift+↑/↓ step 10.
- **Focus.** Rows keyed by family id, tables keyed by pool id, never by a level, the filter or
  the tags. A level change re-renders values inside existing nodes, so focus in a box or on a row
  survives. A filter that hides the focused row moves focus to the nearest visible row.
- **Scroll.** The bar is sticky (the `.rx-result` recipe), each column header sticky under it,
  columns scroll with the page (no inner scroll box). Expansion is in place; if the opened list's
  bottom is below the fold, `scrollIntoView({ block: 'nearest' })` on the panel, not the row.
- **Latency.** `pools.json` and `mods.json` (~1.8 MB) are one lazy `import()` on first mount,
  cached at module scope, skeleton rows meanwhile. `poolFor(pool)` memoised on the pool id;
  `atLevel(pool, L, F)` is a pass over ~300 tiers, microseconds, so no debounce anywhere.
- **Persistence.** `settings.mods_tools = { poolId, ilvl, floor, tags }` through `useAutosave`
  exactly like `regex_tools`: `ensureSettings()`, `merge(stored)`, then `arm()`, so a failed load
  shows defaults and never writes them. Expanded families live in a module store so a hop to
  Workspace and back keeps them open; they are not user data.
- **Edge states**, copy as instruction only: data not loaded → skeleton; load failed → "Reopen the
  tab to load the modifier tables."; stored pool id gone after a sync → first pool, silently;
  empty pool (item level below every tier, or floor above the item level) → every row `0 / n`,
  Total 0, one hint "Lower the min level or raise the item level to open the pool."; filter or
  tags leave nothing → "Clear the filter or a tag to see more.", chips stay pressed.

## Component plan

```
frontend/src/components/
  ModsView.jsx      the tab: settings load/autosave, lazy data, bar, two ModTable
  ModsBar.jsx       pool picker, two Num boxes, the orb picker, filter, tag chips
  ModTable.jsx      one affix column: sticky header, rows, total; roving focus
  ModFamily.jsx     one family row + its tier bands (memo; a data-id for the table's delegated handlers)
  ModSection.jsx    a collapsed section (header + body) and the one GrantList (essences, alloys, socketables)
  Num.jsx           lifted from RegexView.jsx unchanged (RegexView imports it)
frontend/src/lib/mods/
  index.js          the session store for open rows and sections
  pool.js           PURE: prepare (search text), atLevel (two binary searches per family, no copies), inPool, bandOf, visible, shownChance, tagLabel
  orbs.js           PURE: currencyFor, floorOf, orbOptions over the fetched currencies
  defaults.js       defaults, merge(stored)
  format.jsx        pct and lines, the two formatters every Mods component shares
backend/app/modpool.py   the producer: derive → assemble → store; pools()/pool()/currencies() for the endpoints; refresh() for shazam
  defaults.js       defaults, merge(stored)
  currency.js       the 16 bounded currencies: { id, name, floor, cap, group } (the index above; hand-maintained like data/regex/pools until the game tables are fetchable)
  trade.js          PURE: familyQuery(pool, family) → trade2 query, Instant Buyout, reusing regex/trade.js
  session.js        module store: expanded Set per pool
frontend/test/            mods-pool, mods-settings;  backend/tests/test_modpool.py with fixtures/mods (a trimmed export + page cuts)
```

Pure shapes (`pool.js`, no React):

```
pool   = { id, name, tags, prefix: Family[], suffix: Family[] }
Family = { id, affix, text, tags, tiers: Tier[] }          // best first
Tier   = { id, tier, name, ilvl, text }                     // range substituted
atLevel(pool, L, F) = { prefix: { rows: Row[], total: N }, suffix: {...} }
Row    = { family, k, n, chance, tiers: (Tier & { state: 'above'|'in'|'below' })[] }
```

Tests, exhaustive over every pool × L 1..100 × F ∈ {0, 1, 35, 40, 44, 50, 70, 82, 100}: chances sum to 1 per
affix when N > 0; k is non-decreasing in L and non-increasing in F; k equals the count of tiers
with `F ≤ level ≤ L`, no exception; `F > L` gives N = 0; bands are contiguous in tier order;
every tier belongs to exactly one family; `visible()` never changes a chance or a total; Rings,
a `Body Armour · Str/Int` and a wand reproduce committed golden family lists and tier counts
(Rings: Life 8 tiers with T1 at 54, Mana 12). `mods-data.test.mjs` pins the variant collapse
(Rings 1, Gloves by attribute, Wand split by element exclusions) and the manifest hashes.

Data files from the sync script at a pinned commit: `pools.json` = one entry per distinct
spawn-tag set within an equipment class `{ id, name, class, tags, keywords, trade: { category } }`;
`mods.json` = item-domain prefix and suffix families with tiers `{ id, tier, name, ilvl, weights,
ranges }`, markup stripped. Zero outbound calls in the app.

CSS: a new `/* ---------- trading: mods ---------- */` section, tokens only. `.mods-bar` (`.rx-surface`,
sticky), `.mods-tag` / `.mods-tag.on` (pill; on = the `.seg-btn.on` gold), `.mods-body` (two
columns, stacks under 980px like `.rx-body`), `.mods-table` (`.rx-surface`), `.mods-fam` (the
`.rx-row` recipe: hairline, hover `--panel-hi`, focus inset `--gold-dim`), `.mods-fam[aria-expanded="true"]`
(the `.rx-row.on` recipe), `.mods-fam.out` (`--muted`), `.mods-tiers` (`--bg` inset), `.mods-tier.above`
/ `.mods-tier.below` (`--muted`), `.mods-tier-cut` (hairline `--line`), `.mods-total` (top border
`--line-strong`, `--ink-2`), skeleton rows on the existing `shimmer` keyframe.

## Decisions and rejections

- **Tier modal** (poe2db, craftofexile): hides the Total and the boxes at the moment you compare
  against them. In-place expansion.
- **One From/To range for the two levels**: tidy and wrong. The ends are different facts, the
  drag rule would move the item level when a floor is typed, and a floor above the level is a
  legitimate query the pair forbids.
- **Presets instead of the floor box**: the owner types numbers; a new grade would need a release.
  **A three-way Seg (Any / Greater / Perfect)**: the first draft, wrong once the currencies were
  indexed: Greater means 35 on an Exalt and 44 on a Transmute, Perfect 50 and 70, and Ancient
  bones are 40. A picker of the actual orbs, with icons, replaces it.
- **Sort by chance, or sortable headers**: rows walk under the pointer during the most-used
  interaction. Game order only.
- **Prefix / Suffix / Both switch**: hides a column that already fits.
- **Chances renormalised to the filter**: two people on the same pool would see different numbers
  depending on a search box.
- **A per-tier chance column, a cumulative "this tier or better" column, a chance bar, a Best
  column with the top range on the base row, captions like "PERFECT ADDS · 50–82", exclusion
  reasons ("from 86") on the base row**: each is a second number or a narration on the base row;
  the expanded list carries the depth (styleguide §0).
- **Sliders** for either level: owner rule, numbers are typed.
- **Inner-scrolling columns**: a list scrolling inside a scrolling page.
- **A prefix-sum index per family** for the recompute: the plain pass is microseconds.
- **Persisting the filter or the expanded set in user settings**: a stale filter on return looks
  like an empty pool; open rows are not user data.
- **A provenance line on screen**: `PROVENANCE.md`.

## How this was chosen

Four independent designs were written against the same brief, revised twice (after the live
poe2db drive and after the owner's correction that the floor is a strict pool exclusion, then
the Greater 35 / Perfect 50 orb facts), scored by a separate judge on six criteria, and read in
full. All four converged on the shape above: class × variant picker, two typed levels with an
orb control, strict exclusion, `k / n` and `k / N`, in-place expansion, Search on trade one
level down, pure `pool.js`, `useAutosave`, no debounce. The orb control was a three-way Seg in
every candidate; the currency index written afterwards turned it into a picker. The base was the design that kept game order
under every level change, kept the two boxes uncoupled and specified focus, scroll and edge
states most fully. Grafted from the others: base names as picker keywords; the per-tier chance
stated once instead of a column; the Total row's summed chance of the shown rows; the
denominator rule as a tested invariant. Dropped from the base: its opt-in sortable headers, by
its own argument against reordering.

## The tables ride the market pipeline (built 2026-09-25)

Game data must update with every release with nobody editing files, so the tables are market
data, not files in the repo:

- **Producer.** `backend/app/modpool.py` derives everything from the sources: the RePoE PoE2
  export (mods, base items, item classes, socketables) and poe2db's currency pages (the orbs with
  a minimum modifier level; the essences and alloys, found as the currencies whose text says they
  add a guaranteed modifier, and what each forces per class from its page's table). Nothing is
  hand-listed: a class's pool domain is where its bases' tags reach under the first-match rule;
  a pool is one class × one spawn-tag set, named from its attribute tags, a shared stem with a
  numeric range (Waystones · T1–5) or its bases; a section is every spawn tag no base carries,
  titled and placed by the socketable that says "Can roll X modifiers" or, for keys whose mods
  name base tags (the bones, the Genesis Tree), by the tag itself; corruption implicits and their
  upgrades (the `upgraded_corruption_mod` tag) are two more. A new patch's data lands by running
  it again. Tests: `backend/tests/test_modpool.py` over a trimmed export fixture.
- **Where it runs.** On shazam only, as the first step of `ops/publish-market-snapshot.sh`
  (`python -m app.modpool --force` inside the backend container), so every seed carries this
  patch's pools; a failed rebuild keeps the previous tables and is logged. Fetches go through the
  gateway (a `poe2db` policy, spaced out) into the gold-fee loader's cache. Desktop installs
  never fetch.
- **Storage and delivery.** `mod_pools` (one row per item type, its precomputed sections, chips
  and grants as JSON) and `mod_currencies`, market tables in `datapolicy.SEED_TABLES`, so the
  exporter ships them unchanged; `mods_meta` in `kv_ops` carries the source hashes. The snapshot
  version is the export's timestamp, so a rebuilt seed is newer by construction.
- **API and client.** `GET /api/mods/pools` (the list plus the currencies) and
  `GET /api/mods/pool/{id}` (one item type: sections with tiers sorted best first, no spawn
  weights, ~9 KB gzip), through `useApi`. `pool.js` keeps the arithmetic only: `atLevel`,
  `inPool`, `bandOf`, `visible`, `shownChance`. The orb picker's options are the fetched
  currencies with a floor. `POST /api/mods/refresh` exists for shazam and for a dev backend.

Verifying after a market-side change (CLAUDE.md): deploy the backend to shazam, run the
publisher, confirm the `market-seed-latest` asset's version advances and a fresh install shows
the Mods tab populated.
