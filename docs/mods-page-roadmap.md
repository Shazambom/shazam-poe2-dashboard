# Mods page: roadmap

Status: research done 2026-09-25, nothing built. Goal (owner): look up an item type and see every
modifier that can roll on it, with the pools and weights, from metadata we already pull. Not a
copy of poe2db; a place to build on.

## What poe2db's page is

Read on `poe2db.tw/us/Wands#ModifiersCalc` and `/us/Modifiers`, driven in a browser.

An item class page has a "Modifiers Calc" tab. Top to bottom:

- A banner: "Modifier weight information cannot be obtained from game files." (See below: this
  is the single most useful fact in the research.)
- A row of tag chips: crafting tags (Ulaman, Amanamu, Kurgal: the three desecration bones) then
  mod tags (Armour, Gem, Caster, Fire, Cold, Lightning, Chaos, Physical, Life, Elemental, Attack,
  Minion, Aura, Mana, Speed, Critical, Evasion, Energy Shield, Damage, Resistance, Attribute,
  Ailment, Curse, Charm). Clicking filters the tables by tag.
- Inputs: "Filter:" (text), "Min iLvL:", "Max iLvL:", "Import Item" (paste an item), "Toggle Hide".
- A "Crafting Project" panel: Item Level (default 100), Reset, P / S counters, Craft, and a row of
  currency icons with II / III variants (greater / perfect). It is a crafting simulator.
- The tables, two columns, Base Prefix and Base Suffix, then one pair per source: a named unique
  affix family ("Thrud's Might"), Desecrated Modifiers, Essence, Perfect Essence / Alloy, Augment,
  Bonded Modifiers, Corrupted, Orb of Sacrifice, and a separate "Vaal Orb Corrupted Enchantment"
  tab. Each row is a mod family: the stat text with `#` for the roll, its tag chips, then three
  badges: tier count, highest item level, "weight". A "Total" row per table.
- Clicking a family opens a modal listing its tiers: T11..T1, tier name (Beryl, Cobalt, ...),
  item level, text with the range, tag, a weight badge, an info link, and a "+" that adds the
  tier to the crafting project. The modal footer links related hybrid families.

The `/us/Modifiers` index is a directory: item classes (weapons, armour, jewellery, flasks,
jewels, relics, tablets), gems, monster mods, map and waystone mods, and misc domains; each links
to that class's calculator.

## The data, and the fact about weights

**PoE2's spawn weights are 0 or 1.** Across the 2,586 item-domain prefix and suffix mods in the
game data, every spawn-weight entry is 0 (not on this base) or 1 (on this base). There are no
generation weights. poe2db's "11000" on a wand's mana family is 11 tiers × a placeholder 1000, and
its banner says as much. So the honest numbers a mods page can show are:

- which mod families roll on a base, and which tiers, with their item levels and ranges;
- the count of tiers eligible at an item level, per family and in total;
- the chance of a family at that item level = its eligible tiers ÷ all eligible tiers of that
  affix type (every eligible tier is equally likely). That is the real "weight" and poe2db does
  not compute it.

### Source: the RePoE PoE2 export

`https://repoe-fork.github.io/poe2/` publishes the game's tables as JSON, the way RePoE does for
PoE1: `mods.json` (13 MB, 16,784 mods: id, name, domain, generation type, required level,
families ("groups"), tags, spawn weights per tag, stats with min and max, and the rendered text
with the game's `[EnergyShield|Energy Shield]` markup), `base_items.json` (8 MB, 5,496 bases:
class, tags, drop level, implicits, requirements, properties), `tags.json` (1,339),
`item_classes.json` (118). No stat-translation step is needed: the text is already rendered.

Proven against poe2db for a Siphoning Wand (tags `wand`, `onehand`, `default`): 7 prefix families
with 11, 8, 7, 40, 6, 6, 6 tiers and 13 suffix families, the same families and the same tier
counts poe2db shows. The pool rule is the RePoE convention: walk a mod's spawn weights in order,
the first tag the base carries decides.

What it does not cover on its own: the essence, desecrated (domain `desecrated`, 322 prefix and
suffix mods with a `map` weight, keyed by the bone tags), corrupted and rune sections need their
own selection rules (generation type `essence`, `corrupted`, the desecrated domain) and a later
phase.

### The other road, and why not yet

The backend already downloads raw `.datc64` tables from ggpk.exposed with the community schema
(gold fees: `CurrencyExchange`, `BaseItemTypes`, `CurrencyExchangeCategories`). `Tags`,
`BaseItemTypes` and `ItemClasses` are served; `Mods`, `ModType` and `Stats` return 500 today, and
rendering a mod's text from `Stats` needs the stat-description files and their formatting
language, which is the hard part RePoE already did. Not worth re-doing; keep it as the fallback.

### Licence and provenance

The data is GGG's game data, the same footing as the trade snapshot and EE2's tables. The
export's code is a RePoE fork; the original RePoE is MIT, and the fork's own licence file could
not be read (the repository has moved). Before vendoring, record the fork's licence in
`PROVENANCE.md` as the EE2 port does; if it cannot be established, the raw-table road is the
fallback and the page's shape does not change.

## The page

Trading → Mods, the last sub-tab beside Regex (the two link to each other). One sub-tab, no new
page anywhere else, per the ecosystem rule; a mod lookup is a distinct workflow, like Regex.

The UI is decided in [`mods-page-design.md`](mods-page-design.md) (2026-09-25). In short: one
picker over pool variants (class × attribute, wands split by element), an item level box and a
minimum modifier level box with an orb picker that writes it (the 16 currencies with a level
rule are indexed in the design: Greater / Perfect Transmutation and Augmentation 44 / 70, Regal,
Exalted and Chaos 35 / 50, Ancient bones 40, Gnawed bones capped at item level 64), tag chips
from the pool, a text filter; Prefix and Suffix tables side by side, one row per family
with `tiers in the pool / tiers` and the chance, a Total row; a row expands in place to its tiers
in three bands (above the item level, in the pool, below the floor) with `Search on trade` in the
footer. The floor is a strict pool exclusion (owner): a tier is in the pool iff
`floor ≤ level ≤ item level`. No modal, no crafting simulator, no sort, no Prefix/Suffix switch.

Sections below the base tables, in phase 2: Desecrated (by bone), Essence, Corrupted.

Copy is instruction only (styleguide §0): no counts in headings, no provenance on screen.

## What we can build that they cannot

1. **Chance at your item level**, the number above, which follows from the 0/1 weights.
2. **Your item against the pool.** Copy an item in game; the vendored EE2 parser already turns
   the clipboard text into base + mods. Show the pool with the rolled mods marked, their tiers,
   the open affix slots, and what can still land. This is the Regex tab's "Search on trade"
   moment for crafting.
3. **From a mod to a search.** Each family row gets "Search on trade" (the stat ids from EE2's
   `stats.ndjson`, matched by text, into a trade query the way Regex does) and, for waystone
   and tablet mods, "Find in stash" through the Regex tab.
4. **Prices next to mods.** The Board already prices essences and bones; a family row can show
   what forcing it costs (the essence or bone that guarantees it), which is the arbitrage
   angle: is it cheaper to buy the essence or the finished item.

## Data pipeline

Same shape as `frontend/src/data/regex/` and the EE2 vendoring:

- `frontend/scripts/sync-mods-data.mjs`: fetch the two export files at a pinned commit into
  `~/.cache/arbiter/repoe/`, trim to what the page needs (equipment classes; item-domain prefix
  and suffix mods with a non-zero weight on some equipment tag; markup stripped; stats folded
  into `text`, `min`, `max`), write `frontend/src/data/mods/{bases,mods}.json` and a
  `MANIFEST.json` with hashes and the pinned commit. Estimated 300 KB bases, 1.5 MB mods
  (16,784 mods, most are unique or monster and are dropped). Lazy `import()` so the main chunk
  does not grow.
- `frontend/test/mods-data.test.mjs`: manifest drift, every base's tags resolve, every mod's
  spawn weight tags resolve, the pool rule reproduces a committed set of expectations (the wand
  above, a body armour, a ring) so a bad export cannot ship.
- `frontend/src/lib/mods/pool.js`: pure. `poolFor(base, mods)` → families with tiers;
  `eligible(family, ilvl)`; `chances(pool, ilvl)`. Exhaustive tests over every base × item level
  1..100: chances sum to 1 per affix type, eligibility is monotone in item level, every tier
  belongs to exactly one family.
- Zero outbound calls in the packaged app; the sync runs by hand in a reviewed change.

## Phases

1. DONE 2026-09-25: sync script and tests; `pool.js`; the tab with the pool picker, the two
   levels and the orb picker, tag chips, filter, the two tables with expansion and chances; plus
   the other pools as sections (Desecrated, Genesis Tree, the six socketable uniques, Corrupted,
   Essence, Socketables). Waystone and Tablet mods are already in the Regex tables and can appear
   here through the same page later.
2. "Search on trade" per family; jewels, flasks, charms and relics as pools.
3. Your item against the pool (EE2 parser); prices next to mods.

## Open decisions for the owner

- Vendor the RePoE PoE2 export (fast, complete) versus parsing raw tables ourselves (no third
  party, much more work). The plan assumes the export with its licence recorded.
- Phase 1 stops at equipment. Jewels, flasks, charms and relics come with phase 2 if wanted.
- The design's open points are settled in `mods-page-design.md`; the tab placement is Trading → Mods (owner, 2026-09-25).
