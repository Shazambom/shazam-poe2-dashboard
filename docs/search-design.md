# Search — one search for every search box (BUILT, 2026-10-04)

**Origin:** a Discord #feature-ideas post asked for trade-site-style `~` search, where a few key words find an
item without spelling the whole name. Owner, 2026-10-04: make it "just work for everyone" rather than hide it
behind a special character; KISS. So there is no `~` mode. Every box behaves that way, and a typed `~` is ignored.

**Code:** `frontend/src/lib/search.js`, tested by `frontend/test/search.test.mjs`. Nothing new appears on screen.

## The rule

1. **Fold** both sides: case, accents, apostrophes and hyphens are dropped, other punctuation becomes a space, and
   letters of every script are kept. So `xophs` finds Xoph's, `uulnetol` finds Uul-Netol's, a Cyrillic saved-search
   name is found like any other, and `~gre exa` searches the same as `gre exa` (a lone `~` is a blank box). Text that is only punctuation (`~`,
   `-`, `%`) matches as typed, as the old filters did.
2. **Match** when every typed word is in the name, in any order (`gre exa`, `ess ruin perf`, `res fire`). A typed
   number fills a modifier's `#` (`30 fire res`, or a pasted `+30% to Fire Resistance`).
3. **Rank** with today's tiers:
   - the whole name, or the exact trade id (`gcp`), compared as typed;
   - names whose first words start with the typed words, shorter first;
   - everything else, then options whose id merely contains the text as typed;
   - hidden keyword hits (the base names behind a Mods pool).

   Shorter names come first within a tier ("alchemy" puts Orb of Alchemy first); then the caller's list order.
4. **Typos only when nothing else matches:** 1 slip per word of 4+ letters, 2 from 8 (Algolia's defaults; a swap of
   two letters counts as one). The fewest slips come first, names before keywords, then shorter names (`anullment` → Orb of Annulment). A correctly spelled search
   never gains lookalikes (`chaos` doesn't pull in the Chaotic omens). In a picker that can add a new entry (the
   Strat Calculator), a known item always comes first and "Add “…”" last (owner, 2026-10-04: "always prioritize
   a currency we know of"), so Enter takes the real item and the user's own wording is a deliberate pick.

**Never worse than today:** every result the old matcher returned is still returned. Two- and three-letter text
still matches inside words (owner's choice, 2026-10-04): `bow` still finds Crossbows, at the cost of noise such as
`es` matching many modifiers. A test copies the old matcher and checks this on every substring of the fixture.

## Where it's used

| box | how |
|---|---|
| ⌘K palette (`palette.js`): labels, with aliases as keywords | `search`, ranked |
| `CurrencyPicker` (every item picker: Board/Stash/Strat Calculator add bars, Convert, Mods item type and orb, Inflation, …) | `search(options, q, o => [[o.name], o.keywords, o.id])`, ranked |
| Find in stash (`stash.js stashMatches`), Market filter, saved-search rail (`tree.js filterHits`), the Mods tab's modifier filter (`mods/pool.js modMatches`), the Regex tab's modifier picker (`ModPicker`) | `matching(rows, q, names)`: the kept rows in the box's own order |

The typo pass needs the whole list (it runs only when nothing matched), so filters work on a list, never one
row at a time; the Mods tab decides once across all its sections (`modMatches`), so `cold` never shows Cooldown
beside real Cold mods. The Market filter searches one joined text so that `div chaos` spans both names.

Not search boxes: the Recipes and Settings "trade id" fields take an exact id and keep the browser's own suggestions.

## Considered and rejected (the arena, 2026-10-04)

Three independent designs and a judge, measured on the 660 real item names, 94 Mods pools and 747 modifier
texts from the local market DB. On 142 common queries, the right item came first 88 of 95 times (today: 35), and
7 searches found nothing (today: 80).
- **Libraries:** uFuzzy was the best (4 KB) but still put a Vaal Infuser above Vaal Orb and has no keyword search.
  Fuse.js flooded results (6,201 irrelevant hits). match-sorter and fuzzysort have no typo tolerance. About 70
  lines of our own code beat them all.
- **Ranking by trade volume:** Exalted Orb has no volume of its own (it is the pricing unit), so `ex` ranked
  Expedition first.
- **Initials or an alias list:** they add noise, and an alias list is a hand-kept list of game names, which we
  don't keep. Trade ids already cover the short forms players type.
- **Typos always on:** adds lookalikes to searches that already work.
- **Matching inside words only from 4 letters:** cuts noise sharply but loses results players find today (the
  owner chose to keep them).
- **Highlighting or "did you mean":** new UI (restraint rule).

**Known gaps:** two slips in a short word (`anull`), and abbreviations (`atk speed`). The trade site's own `~`
semantics weren't checked (pathofexile.com is off-limits); the design doesn't depend on them.
