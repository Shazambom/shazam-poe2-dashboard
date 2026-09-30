# BUG — route search has no crafting recipes: the reforge data we fetch is unused, and we have no disenchant data at all

**Status:** OPEN · **Found:** 2026-09-29 (audit follow-up) · **Affects:** Arbitrage route search, Convert and
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

## Fix plan

1. **Derive the reforge recipes on shazam** in `modpool.refresh()` (or a sibling module), from the
   poe2db pages it already caches: parse the "Three to One Reforge" table into
   `{inputs: {trade_id: 3}, outputs: {trade_id: 1}, kind: "reforge"}`, map names to trade ids through the
   registry (as `prices()` does for grants), and store them in a market-side table that ships in the seed
   (add it to `datapolicy.SEED_TABLES`; per CLAUDE.md, verify the exporter and publish after a market-side
   change).
2. **Find and fetch the disenchant data.** Identify where the game defines disenchants (the owner's
   example: Perfect augment → 3 Greater) — a poe2db page or table beyond the guaranteed-modifier set,
   or a RePoE / ggpk table (`gamedata` already reads `currencyexchange.datc64`) — and derive
   `{inputs: {perfect: 1}, outputs: {greater: 3}, kind: "disenchant"}` the same way. Validate the list
   against the owner's example before building on it (feedback "validate rules on the owner's examples").
3. **Route search reads derived recipes** alongside the user's own `recipes.json` (user entries still
   win for the same id), with `allow_recipe_edges` as today. Include each recipe's gold cost if the bench
   charges one.
4. **Drop the shipped templates** from the seed `recipes.json` once real recipes exist (restraint: no
   placeholder data on screen).

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
