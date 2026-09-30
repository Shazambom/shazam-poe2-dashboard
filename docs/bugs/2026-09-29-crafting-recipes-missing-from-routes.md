# BUG — route search has no crafting recipes: the reforge data we fetch is unused, and we have no disenchant data at all

**Status:** 0.3.8-beta.1/2 shipped this with REGRESSIONS (below); fixed in code 2026-09-30, not yet
released. Stable (desktop-v0.3.7) never had it. Disenchant is INTENDED behaviour, confirmed in-game by the
owner; see docs/dev-notes.md → "Crafting recipes in route search".
cash-out (every install), the value of every tiered currency (essences, and any other item with a
bench conversion)

Owner: "I should be able to buy perfect augments and then disenchant into 3 greater and that might be a
valid arbitrage opportunity." Then: "this data missing is a big miss, we should have the disenchant data."

## What was seen

Checked 2026-09-29 on the owner's Mac (read-only):

- **Route search reads recipes only from the user's `recipes.json`** (`backend/app/recipes.py` `load()` /
  `edges()`; the graph adds them in `Graph.build` → `Graph.add_recipe`). Nothing derives recipes from
  game data.
- **The owner's `recipes.json` holds three templates, all disabled:** "10 Transmutation Shards → Orb of
  Transmutation", "10 Regal Shards → Regal Orb", and a placeholder "3× lower tier → 1× next tier" with
  `REPLACE_…` ids. It is a copy of the shipped seed file (`recipes._ensure` copies `SEED_DIR/recipes.json`
  on first run). So `recipes.edges()` returns nothing and **no route on any install can include a
  crafting step.**
- **The reforge recipes are in data we already fetch.** `modpool.refresh()` (shazam, before the daily seed
  publish) caches poe2db pages for every currency that "adds a guaranteed modifier" (`grant_slugs`):
  the essences (Lesser / normal / Greater / Perfect) and the alloys. 57 of those cached pages carry a
  "Forge recipe … Used in Three to One Reforge — Crafting Bench Craft" table, e.g. on
  `poe2db-Essence_of_Ice.html`: `Lesser Essence of Ice x3 → Essence of Ice x1`,
  `Essence of Ice x3 → Greater Essence of Ice x1`. The page is parsed only for its modifier table
  (`grant_from`); the recipe table is ignored.
- **We have no disenchant data at all.** No cached poe2db page and no RePoE export we fetch
  (`repoe-augments.min.json`, `repoe-base_items.json`, `repoe-mods.json`, `repoe-item_classes.json`)
  mentions a disenchant. The Perfect essence pages list no recipe; the Greater pages list only the
  3→1 upgrade into them. Pages are fetched only for guaranteed-modifier currencies, so the currencies
  where a disenchant would appear (augments / soul cores / runes and others) are never fetched.

### Investigation 2026-09-30

- **One page lists every bench recipe.** poe2db `Reforging_Bench`, "Forge Recipe /93" (a From / To table,
  "Used in Three to One Reforge"). It has 93 recipes, all 3→1:
  - runes: Lesser→normal→Greater;
  - essences: Lesser→normal→Greater, with no Greater→Perfect;
  - the distilled emotions chain (Diluted Liquid Ire → … → Concentrated Liquid Isolation);
  - Waystone tiers 1→15.

  The game's own table is `ThreeToOneRecipes.datc64`. It is listed on ggpk.exposed, but its download
  returns a Cloudflare 1101 error, so poe2db is the source.
- **Names map to trade ids by name:** 91 of 93 map through the trade static list. Tempered Rune is
  not listed.
- **No disenchant exists in any source we can reach:** not on the bench page, not in any cached
  currency page, and not in RePoE. The one hint is `ItemDisenchantValues` (a 120-byte table:
  rarity, base item, value), which is not downloadable and does not describe tier splits. The
  "Perfect → 3 Greater" idea matches only the shipped **template** `example-disenchant` in
  `backend/data/recipes.json`.
- **Measured on a copy of the owner's data** (Forbidden Rites), with the 91 recipes loaded:
  - 77 recipes have both ends priced;
  - 8 recipe loops have a positive margin, and 4 pass every default filter. The best is
    ex → Concentrated Liquid Suffering → Isolation → ex: +90%, 226 ex, 3 min per step;
  - they rank about 317th of 414 on the default score, because the exchange gold fee on the
    buy and sell steps is large (62,640 gold);
  - search cost is negligible: +20 un-culled market edges, and 5313 → 5381 candidates.

### Every recipe kind, as far as the sources go (2026-09-30, patch 4.5.5.3)

- **Reforging Bench.** poe2db `Reforging_Bench` has four groups: Equip /68, Gem /2, Unique Item /2, and
  X of a Kind /93 (the 3→1 list above). maxroll's bench guide (0.5.4) says:
  - **fixed next tier:** runes (Lesser→normal→Greater) and distilled emotions;
  - **waystones:** 3 of a tier give 1 random waystone of the next tier;
  - **essences:** 3 of the same essence give 1 *random* essence, with a very small chance of a Greater.
    poe2db shows fixed essence outputs instead; the game table `ThreeToOneRecipes` has an unnamed i32
    column that could be a chance. **Essence recipes are not deterministic edges until this is settled.**
  - **random output of the same type:** soul cores, catalysts, relics, precursor tablets, gear and
    uniques. None of these is a fixed conversion.
- **Gear disenchant (vendor).** `ItemDisenchantValues`, read from GGG's patch CDN:
  - magic item → Transmutation Shard (`CurrencyUpgradeToMagicShard`);
  - rare → Regal Shard (`CurrencyUpgradeMagicToRareShard`);
  - unique → Chance Shard (`CurrencyUpgradeRandomlyShard`).

  Each row has BaseValue 1. The input is an item, not an exchange currency, so these are not
  route edges.
- **Currency tier links.** The table `TieredCurrency` holds `BaseItemType, Tier, MinimumModLevel,
  LowerTierBaseItemType`, the Perfect → Greater → base chain of the orbs. It is the one place in the
  game data that links a tier to the one below it. It is unread: its bundle (`Tiny.V6.1`) returns 404
  on patch-poe2.poecdn.com 4.5.5.3, and ggpk.exposed (still on 4.5.5.2) returns error 1101.
- **Not found:** a Perfect → 3 Greater (or any higher → lower) disenchant. It is absent from:
  - poe2db's bench page and its Perfect Orb of Augmentation and Perfect Desert Rune pages;
  - maxroll's bench guide and the 0.5.0 and 0.5.5 patch notes;
  - the fextralife rune page, and the timesaver tiered-currency and perfect-rune guides.

  timesaver says Perfect runes come only from a Masterwork Rune on a socketed Greater rune.
  Owner, 2026-09-30: "disenchant recipes are legitimate". The source is needed (which NPC or window,
  and what goes in and comes out).

## Impact

- **Missed arbitrage.** A loop through a bench conversion (buy 3 lower-tier, reforge, sell the higher
  tier; or buy a Perfect, disenchant into 3 Greater, sell them) is invisible to route search, even
  when the markets make it profitable.
- **Convert and cash-out** can't use a conversion as a step either (same graph).
- **The recipe price safety (`Graph.traded_rate`, audit 2026-09-29 A1) has never been exercised on
  real data** because no recipe edge exists.
- The Recipes editor ships templates that look like working data, so nothing on screen says the
  feature is empty.

## Root cause

Recipes were designed as user-entered data (a JSON file and an editor), before the rule that game
data is derived on shazam and rides the market seed (feedback "game data rides the market pipeline":
never hand-list or ship game tables as repo JSON). The mod-pool pipeline later started fetching the
very pages that list the reforge recipes, but only mined them for modifiers.

## Fix plan (simplified 2026-09-30)

1. **Shazam: derive, store in kv_ops.** `modpool.refresh()` fetches one more page (`Reforging_Bench`),
   parses the "Three to One Reforge" From / To table into `[{from, from_qty, to, to_qty}]` by name,
   and writes kv_ops `bench_recipes`.
   - No new table: kv_ops already ships in the seed, so there is no `SEED_TABLES`, exporter or
     snapshot-version change. Still, run the publisher and confirm the key is in the seed (CLAUDE.md).
   - A parse that yields nothing keeps the last good value and logs, as `stored_grants` does.
2. **Client: `recipes.edges()` = derived + user.**
   - Map names to trade ids at read time through the registry, with kind "reforge". Unmapped
     recipes are dropped and counted in a log line.
   - A user recipe with the same id wins.
   - `load()` / `save()` (the editor) stay user-only, so game data never gets written into the
     user's file.
   - The graph, cull exemption, lot sizing, `traded_rate` and the ⟳ glyph already handle the rest.
3. **Seed `recipes.json` → `[]`** for new installs. Existing installs' disabled templates are user
   data: leave them.
4. **Disenchant: derived by rule, in the app** (owner, 2026-09-30). For every tiered currency named
   Perfect X / Greater X / X:
   - Perfect X → 3 Greater X;
   - Greater X → 3 X.

   The rule applies only where both names exist in the registry. It is a rule over names, not a
   table of facts, so it needs no sync: `recipes.edges()` derives it from the registry.
   - On the owner's data it gives 39 full families (79 recipes):
     - orbs: Transmutation, Augmentation, Regal, Chaos and Exalted;
     - 15 runes and 19 essences;
     - Jeweller's, where only Perfect → 3 Greater applies, because its tiers are Lesser / Greater /
       Perfect.
   - Perfect Flux has no Greater tier, so it gives nothing. Normal → 3 Lesser is not part of the rule.
   - Measured: 31 profitable disenchant loops, 11 passing every default filter. The best, by default
     score, is chaos → Greater Orb of Augmentation → 3 Aug → chaos: +41.7%, 2152 ex, rank 53 of 421.
   - With reforge as well: 39 profitable loops, 15 passing every filter. Search cost is still small
     (5313 → 5464 candidates).

**Online check (2026-09-30): no published list of currency disenchants exists.**

- The only "disenchant" documented anywhere is **gear at a caster vendor** (Una, Zarka, Servi):
  magic → Transmutation Shards, rare → Regal Shards. Sources: game8, videogamer, gamerguides,
  sportskeeda. This matches `ItemDisenchantValues`.
- Checked for tier splits and found none: GGG's official 0.5.0 notes, poe2.dev's 0.3 / 0.4 / 0.5
  summaries, maxroll's 0.5.0 and 0.5.5 notes, the maxroll bench guide, timesaver's tiered-currency
  guide, and the forum thread "New tiered orb system is horrible", which says disenchanting was
  "basically deleted from the game".
- The tiers themselves check out against the trade list:
  - Transmutation, Augmentation, Regal, Chaos and Exalted are normal / Greater / Perfect, with no
    Lesser;
  - Jeweller's is Lesser / Greater / Perfect;
  - Flux is normal / Perfect.
- The owner says currency disenchant is real and may be orbs only. Until the owner confirms in-game
  which families disenchant, the table must not include families nobody has confirmed (accuracy
  first).

**In-game check by the owner (2026-09-30):**
- a Greater orb disenchants;
- a Jeweller's Orb does not;
- runes do not;
- essences and Perfect orbs were not tested.

Disenchant table, **orbs only**, for Transmutation, Augmentation, Regal, Chaos and Exalted:
- Greater X → 3 X: confirmed in-game;
- Perfect X → 3 Greater X: the owner's rule, not yet tried in-game.

Out of the table: Jeweller's and runes (confirmed not to disenchant), and essences (untested).
The derivation keys on the "Orb" families that have normal / Greater / Perfect tiers, which excludes
Jeweller's by construction (it has no normal tier).

Order: shazam first (old clients ignore the key; installs get it on the next seed poll), then the
client change in a beta.

## Tests to write first

- Parsing: a cached poe2db essence page yields exactly its 3→1 reforge pairs; a page without the table
  yields none; a layout change yields none and logs (never a wrong recipe).
- Name → trade-id mapping: every derived recipe maps both ends, or is dropped and counted.
- Seed: the derived table ships in the seed and a fresh install's route search has recipe edges.
- Route search on a fixture where buying 3 Greater, reforging and selling the Perfect beats the
  Perfect market finds that loop; and the disenchant fixture from the owner's example finds its loop.
- `Graph.traded_rate` never reports a recipe ratio as a market price (already pinned in
  `tests/test_native_price_dead_market.py`).

## Open questions

- Where exactly the disenchant data lives (item 2), and whether disenchant outputs are fixed counts or
  ranges (a range cannot be a single edge rate).
- Whether reforge / disenchant cost gold at the bench (poe2db shows the Currency Exchange gold fee, not
  a bench fee).

## Regressions in 0.3.8-beta.1/2, and the fix (2026-09-30)

The owner asked for an audit ("I think you may have broken some of arbitrage"). Measured with
`ops/regression-diff.py`, stable 0.3.7 against beta.2, on the owner's data:
- **17 prices moved, by up to 4300%.** Essence of Alacrity went 0.5 → 22 ex, and Tawhoa's Tending and
  Rune of Vital Flame fell about 99%. The busiest market and the price card changed for the same 17
  currencies.
- **Convert chaos → divine detoured** through a Greater Orb of Transmutation disenchant.

Causes:
1. **The cull exemption.** The thin-market cull spared every market touching a recipe's ends. The orb
   disenchants make chaos and exalted recipe ends, so 19 filtered markets came back and priced things.
2. **A recipe hid the market it replaced.** A recipe that took a market's pair hid that market (for
   example Greater Chaos → Chaos, about 5k/h) from the value table, the volume ranking, centrality, the
   Board's cards and the Market table.
3. **The naive price walk read recipe ratios.** `ref_values`, behind the value table, used recipe
   ratios as exchange rates, so the Perfect Chaos Orb got a price with no market at all.
4. **The Convert exemption was too broad.** It applied to any recipe in a path.
5. **Recipes took deep-scan runs.** Found by the gate on newer data: recipe loops used some of the deep
   scan's 12 runs, so a market loop it used to return disappeared. The scan now reads markets only.

Fix:
- `Graph.market_edge` / `market_edges` for every market reader.
- No recipe exemption in the cull.
- Convert exempts only leading recipe steps.

Proof:
- **Tests:** `test_recipes_never_change_the_market_data`,
  `test_convert_does_not_detour_a_plain_swap_through_a_recipe` and
  `test_the_market_table_still_lists_a_market_a_recipe_took_over`, each seen failing first.
- **Stable 0.3.7 vs the fix, on real data:** 0 differences in values (635), busiest markets, price
  cards, the Market table (2774 rows) and Hold. The only differences are the intended ones: Greater
  Chaos → Chaos and Greater Aug → Aug in Convert, and 2 recipe loops joining the Arbitrage pool.
  All 5171 exchange-only loops are identical, and every extra kept loop uses a recipe. On newer data
  (5212 loops) it's the same after the deep-scan fix.
- **In the packaged app** on the owner's data (2026-09-30), each confirmed on screen:
  - eight broken currencies' Board cards show stable's prices (Rune of Vital Flame and Cirel's
    Cultivation at 1.00 chaos);
  - Arbitrage loads and draws recipe loops with the disenchant step;
  - Convert Greater Aug → Aug gives 10 → 30 with "Direct market: 20";
  - chaos → divine has no recipe step;
  - the Market table lists Greater Chaos → Chaos beside its disenchant;
  - Hold's list matches stable.

Why tests missed it: they checked the new feature and never the outputs that must not change. The
regression diff is now a gate inside `desktop/publish-github.sh` (docs/release-runbook.md →
"Regression gate"). With 0.3.8-beta.3's acceptance it blocks beta.2's code with 106 unaccepted
differences.
