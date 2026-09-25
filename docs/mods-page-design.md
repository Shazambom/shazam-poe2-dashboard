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
  minimum modifier level is the bottom, and it comes from the orb: Exalted, Chaos and Regal have
  none, the Greater versions have 35, the Perfect versions have 50. A tier below the floor is out
  of the pool: it cannot roll, it carries no weight, it leaves the totals. Strict, no exceptions
  (poe2db keeps each family's top tier under its Min iLvL; that is poe2db's quirk, not the game).
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
 │ [Rings                    ▾]   Item level [ 82 ]   Min level [ any ] [Any|Greater|Perfect]   [Filter modifiers   ] │
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

The same pool with Greater pressed (floor 35), item level 50, Life expanded:

```
 │ [Rings                    ▾]   Item level [ 50 ]   Min level [ 35 ] [Any|GREATER|Perfect]   [life               ] │

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
| Min level | `Num`, 0..100, placeholder `any` (0 = no floor), with a `Seg` beside it: `Any` 0 · `Greater` 35 · `Perfect` 50 | any | the pool's bottom edge: every count, total and % | yes, the number only |
| Tag chips | pill buttons built from the pool's own tags, multi-select, OR | none | which rows show (never the numbers) | yes |
| Filter | `.ws-filter-input` over family text and tag names | empty | which rows show (never the numbers) | no |

The two level boxes are separate and uncoupled. The item level is a fact about the item you
hold; the floor is a fact about the orb. A floor above the item level is a real question with a
real answer (nothing), so the boxes never drag each other along the way the Regex tier range
does. The orb Seg is derived from the floor number: pressing a segment writes the number, the
segment lights when the box matches, and a typed 40 lights nothing. One persisted value, no way
to disagree. The box stays because the owner types numbers and a fourth orb grade would
otherwise need a release.

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
name · level · text with the range substituted. **Footer**: `Search on trade` (Instant Buyout
query on the pool's trade category plus the family's stat ids, through `useWorkspace.ingest` as
`RegexView.onTrade` does) and, for waystone and tablet pools once they arrive, `Find in stash`
into the Regex tab with the mod ticked.

## The loop, made robust

Owner's loop: expand a family, type an item level or a floor (or press an orb), read the
weights and the total, repeat.

- **Keyboard.** Family rows are a roving-tabindex list per column: ↑/↓ move, Home/End jump,
  Enter/Space toggle, Esc collapses and keeps focus, ←/→ hop to the other column. Tab order:
  pool, item level, min level, the orb Seg, filter, chips, prefix rows, suffix rows. Both boxes
  select on focus, ↑/↓ step 1, Shift+↑/↓ step 10.
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
  ModsBar.jsx       pool picker, two Num boxes, the orb Seg, filter, tag chips
  ModTable.jsx      one affix column: sticky header, rows, total; roving focus
  ModFamily.jsx     one family row + its tier bands (memo; plain-value props)
  Num.jsx           lifted from RegexView.jsx unchanged (RegexView imports it)
frontend/src/lib/mods/
  index.js          load(): lazy import of ../../data/mods/*.json, cached
  pool.js           PURE: poolFor(pool, data), atLevel(pool, ilvl, floor), tagsOf(pool), visible(rows, {tags, q})
  defaults.js       defaults, merge(stored); ORB_FLOORS = [[0,'Any'],[35,'Greater'],[50,'Perfect']]
  trade.js          PURE: familyQuery(pool, family) → trade2 query, Instant Buyout, reusing regex/trade.js
  session.js        module store: expanded Set per pool
frontend/src/data/mods/   pools.json, mods.json, MANIFEST.json  (frontend/scripts/sync-mods-data.mjs)
frontend/test/            mods-data.test.mjs, mods-pool.test.mjs
```

Pure shapes (`pool.js`, no React):

```
pool   = { id, name, tags, prefix: Family[], suffix: Family[] }
Family = { id, affix, text, tags, tiers: Tier[] }          // best first
Tier   = { id, tier, name, ilvl, text }                     // range substituted
atLevel(pool, L, F) = { prefix: { rows: Row[], total: N }, suffix: {...} }
Row    = { family, k, n, chance, tiers: (Tier & { state: 'above'|'in'|'below' })[] }
```

Tests, exhaustive over every pool × L 1..100 × F ∈ {0, 1, 35, 50, 82, 100}: chances sum to 1 per
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
  **A 26-orb dropdown**: three values exist.
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
orb Seg, strict exclusion, `k / n` and `k / N`, in-place expansion, Search on trade one level
down, pure `pool.js`, `useAutosave`, no debounce. The base was the design that kept game order
under every level change, kept the two boxes uncoupled and specified focus, scroll and edge
states most fully. Grafted from the others: base names as picker keywords; the per-tier chance
stated once instead of a column; the Total row's summed chance of the shown rows; the
denominator rule as a tested invariant. Dropped from the base: its opt-in sortable headers, by
its own argument against reordering.
