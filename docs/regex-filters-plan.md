# Search-string builder (Trading → Regex)

Status: phase 1 built 2026-09-24, reviewed and reworked 2026-09-25 (Waystones and Tablets).
Owner decisions: build it ourselves, in the app's styleguide; the tab is called Regex and sits
last under Trading; exact number boxes, not sliders; every trade search is Instant Buyout and a
tablet trade search always asks for 10 uses remaining.

## What it does

The in-game stash search box takes a regex (250 characters; space-separated terms are ANDed; a
quoted string is one term; "!" negates a term; matching is case-insensitive against the item's
tooltip text, ^ and $ per line). The tab turns a selection (tier, revives, rarity, state, yields,
wanted and unwanted modifiers with minimums, tablet kind, uses, price) into that string, copies
it, and can hand the same selection to the trade site as a search in the Workspace.

## Desktop contract: outbound calls

The packaged app gains **zero new hosts**. The tables are build-time JSON in the bundle; the
settings live in the user's settings blob under `regex_tools`; "Search on trade" creates a
Workspace search node with the query and switches to the Workspace, where the existing embedded
trade webview opens it (same host, same session, same nav guard). A bundle test asserts the
generator sources contain no network, storage or window calls.

## What the items really print

Read off 273 live trade listings on 2026-09-24 (91 rare waystones, 91 rare and 91 magic tablets)
and modelled in `frontend/test/regex-fuzz.test.mjs`:

- Rolls are plain numbers ("Monsters deal 17% of Damage as Extra Fire"), never a range.
- Waystones: "Waystone (Tier 14)", "Revives Available: 2", "Item Rarity: +24%", "Pack Size: +23%",
  "Monster Rarity: +19%", "Monster Effectiveness: +26%", "Waystone Drop Chance: +85%",
  "Item Level: 82", the mods, "Corrupted", a price note ("~b/o 2.5 exalted", often fractional).
- Tablets: a rare prints its name then the base ("Delirium Tablet"); a magic prints one name that
  embeds the base ("Teeming Irradiated Tablet of the Antiquarian"); then "Tablet", "Item Level",
  the kind's description line ("Adds a Mirror of Delirium to a Map"), "10 uses remaining" ("1 use
  remaining"), the mods. Eight kinds: Irradiated, Ritual, Delirium, Breach, Abyss, Temple,
  Overseer, Expedition.
- Rare names come from a fixed vocabulary ("Grim Charge", "Mythical Instigation"); magic tablet
  names are prefix + base + suffix. The harvested vocabulary is `map-names.json`.

## Data

`frontend/src/data/regex/`, built by `frontend/scripts/sync-regex-data.mjs` (no network), hashed
in `MANIFEST.json`, never hand-edited. Inputs, all hand-maintained and reviewable in a diff:

- `pools/{waystone,tablet}.txt`: the mods that roll on that kind, one per line in GGG's text with
  "#" for the roll. 80 waystone mods (from Exiled Exchange's area-mod flags) and 103 tablet mods
  (from GGG's stat texts naming the Map). A mod printed in several forms ("an additional Shrine",
  "3 additional Shrines", the boss-map wording) is one line with the forms joined by " ~ "; a
  two-line mod joins its lines with " | ". A patch adds a mod: add the line, run the sync, commit.
- `tooltip-lines.json`: the fixed lines every tooltip shows.
- `map-names.json`: the name vocabulary and the patterns that expand it.
- `tablet-kinds.json`: each kind's trade base and description line.

A row carries everything the runtime needs, derived once:

```
{ "mods": [ { "id": "<fnv1a of text>", "text": "Monsters deal #% of Damage as Extra Chaos",
              "regex": "a chaos$",
              "trade": ["explicit.stat_2200661314"],         // every id GGG lists for the text
              "num": { "side": "after", "gap": true, "after": "%" } | null } ],   // where a minimum can go
  "kinds": [ { "key": "delirium", "label": "Delirium", "base": "Delirium Tablet",           // tablet.json only
               "description": "Adds a Mirror of Delirium to a Map", "regex": "^adds a mi" } ] }
```

- `regex` is from `shortestUnique` (`shortest.js`): the shortest regex that matches every printed
  form of the mod and nothing else: no other mod in the pool, no fixed line, no name. Candidates
  never contain a digit (a literal "3 out of every 10 seconds" would hand out the token "3").
  When the only distinguishing text sits on both sides of the roll, the token bridges it with
  ".*". Uniqueness is asserted and fatal at sync time and re-checked on the shipped rows.
- `num` is `placement(text, regex)` (`terms.js`): the token's side of the roll, whether it
  touches it, and the character printed after the roll (the number's anchor); null when no
  minimum makes sense (several forms, two lines, two rolls, token on the other line). A bridged
  token takes the number inside its bridge.
- `trade`: every printed form is looked up in GGG's trade-stat snapshot; some texts carry two
  ids and the query asks for any of them. Rows without an id are counted exactly in the data
  test so a broken join cannot hide behind a percentage.
- The tablet kinds get their token from the same uniqueness rule, against the mods, the fixed
  lines and every name.
- The kind anchor: every waystone string carries `"e \(T"` (the "Waystone (Tier 14)" line) and
  every tablet string `" rem"` ("10 uses remaining", "1 use remaining") unless a tier or uses
  term already anchors it, so a search in a stash tab holding both kinds never keeps the other.
- Sizes: about 12 KB waystone, 31 KB tablet, about 10 KB gzipped together.

The sync runs by hand in a reviewed change. `frontend/test/regex-data.test.mjs` is the drift
guard: every file under the folder is in the manifest and hashes as recorded, and the uniqueness
rule is re-run on the shipped rows.

## The generators

`frontend/src/lib/regex/`, pure ESM, no I/O. `number.js` is one idea: a span of same-width
integers is a shared prefix, a partial head, a run of whole tens and a partial tail; minimums,
ranges and prices are unions of spans over the widths they need. `terms.js` builds a modifier's
term with its minimum anchored on the character after the roll; `waystone.js` and `tablet.js`
assemble the string; `trade.js` builds the trade query; `defaults.js` holds the settings shape.

A minimum is "at least N" (items print no range). A threshold that Round to tens takes to 0 is
"any" and emits nothing. Price terms start with a space (anchoring on the note, otherwise "8 to
123" also matches "124 chaos") and read a fractional note by its whole part.

## Trade

Every query is Instant Buyout (`status.option: securable`; "online" is in-person trading). The
Workspace forces the site's delivery dropdown only for searches typed there and deliberately
skips query-mounted rows, so a query the app builds carries the status itself. A tablet search
always asks for 10 uses remaining, whatever the string asks for. The waystone query takes the
rarity from the toggles (exactly one picked). A repeated search re-runs the row rather than
remounting the slug the site stored on it (a slug carries its league). All of it proven against
the live site through the app: the site's stored query, the delivery dropdown, "Fee:" rows.

## Tests

- `regex-number.test.mjs`: exhaustive sweeps (every minimum 0..999 in both modes, every range
  0..99×0..99) plus the price edge cases.
- `regex-number-golden.test.mjs`: `number.js` held to an external reference implementation's
  outputs. `frontend/scripts/regex-number-goldens.mjs` (dev only) fetches that implementation at
  a pinned commit into `~/.cache`, runs it over the same input space plus a few thousand seeded
  fuzz inputs, and writes only the output strings to `frontend/test/goldens/regex-number.json`.
  Ranges and price bodies byte for byte; minimums by the set of integers they accept and never
  longer (ours are shorter in 597 of 3,512 cases). Inputs above 999 are out of scope.
- `regex-generators.test.mjs`: every term and both trade queries, with explicit rows.
- `regex-data.test.mjs`: the shipped tables re-checked against the rule.
- `regex-fuzz.test.mjs`: a tooltip renderer (the model above) and a search-box simulator in the
  test, an oracle of what each setting means, then every tier pair against every tier, every
  revive pair, every rarity subset, every state combination, every tablet-kind subset against
  every kind, every uses value, every mod alone wanted and avoided, every mod with a minimum at
  the digit boundaries in both rounding modes, every price edge, 4,000 seeded random settings
  per kind against random items, and cross-kind: a waystone string never keeps a tablet.
- `regex-settings.test.mjs`, `regex-bundle.test.mjs`: the settings merge and the contract.

Before every commit the tab is driven in the running app over CDP (`docs/desktop-debugging.md`).

## Review, 2026-09-25

Six read-only reviewers (reuse, simplification, efficiency, altitude, two correctness passes);
everything was fixed test-first and re-proven in the app. Correctness: the price From/To edit
lost its currency and toggles; a failed settings load armed the autosave; auto-copy fired on
arrival; a repeated search remounted a stale slug; the waystone query ignored rarity; multi-form
mods lost their ids and twice-listed texts got one; bridged tokens offered no minimum; a two-line
mod's minimum matched either line; tokens were unique only within their kind; fractional notes
never matched; rows floated under the cursor; an unknown stored kind white-screened; the last
edit before a tab switch was dropped by the autosave timer (the hook flushes on unmount now).
Shape: the sync ships placements, id lists and kind tokens; one range compressor, one clipboard
helper, one segmented control; cached settings; a walked manifest; a five-times faster token
search; the fuzz harness on the shipped tables. Skipped on purpose: a backend default for the
settings key, folding the price engine into the range engine, a shared "add query" helper.

## Later

Relics; saved strings as Workspace rows; a mod that rolls on tablets without naming the Map
would be missing from the pool (add its line).
