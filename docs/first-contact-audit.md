# First-contact audit (2026-10-07, v0.3.14)

**Status:** built test-first, QA'd, code-reviewed and fixed (2026-10-08, uncommitted); every gate green. Next: the owner's
check in the packaged app ([feature-flow.md](feature-flow.md)), then "deploy dev".

**Method.** A QA agent in the role of a PoE2 player who had never seen the app drove the packaged UI (dev launch over
CDP, a throwaway profile with a copy of the market data, no saved settings, the owner logged in mid-run) through 12
player tasks and every screen, with 29 screenshots. I verified every finding below against the screenshots, the code, or
a live check. A second agent reviewed the usability literature (primary sources only; file: [`ui-research-2026-10-07.md`](ui-research-2026-10-07.md),
summarised at the end). Trade-site cost of the whole run: 0 searches, 0 fetches, 1 Merchant History call, 3 Trading
opens, plus the backend's own startup reads and session probes.

**Owner's frame.** "The solution is almost never more text or explanation, people DO NOT READ." No clutter. The grouping
(Board / Strategy / Economy / Trading / Settings, Regex and Mods under Trading) is deliberate.

## What the player thought the app was (first 5 seconds)

"A poe2scout-style price tracker": five currency cards and two rows of icon + percentage chips. First click: the
Divine card. The HOLD and MOVERS chips (icon + % only) meant nothing until hovered; HOLD #1 was red (−1.20%), which read
as "it tells me to hold something that's losing value".

## Friction, worst first

Verified = I reproduced it (screenshot, code, or live). Tags: FIND (couldn't find it), MEANING (didn't understand a
label/number/screen), ACTION (didn't know what to do next), FEEDBACK (did something, nothing visible happened),
DISTRACTION (pulled attention for no reason), WORDS (not a player's word).

| # | Screen | Finding | Tag | Verified |
|---|---|---|---|---|
| 1 | Strategy › Arbitrage | A loop row is a chain of tiny icons and rates across 12 columns; "Velocity" shows −48.136 beside +90%; the expanded row shows the engine's internals ("digest 32m", "score 0.7816 (velocity 0.667, efficiency 1, value 0.667, volume 1)"); the steps read "[icon] to [icon]". The sidebar has an "Arbitrage algorithm" expander. The player could not read a loop and did not trust +210% margins. | MEANING | yes (06, 07) |
| 2 | Strategy › Hold | #1 is Seraph's Heart at 305 div, last traded 74.6 h ago, with a green pill "buy · day 36 −10.7%". A player with 50 ex can't act on it; the pill reads as a contradiction (buy + a negative number). The table has no price column, so cost is only visible after a click. | MEANING | yes (09, 10) |
| 3 | Settings / Trading / Stash | Settings says "Connected", but Trading › Workspace shows the trade site's Sign in page and Stash › Sales says "no session". The top bar shows no account; the Connect button simply disappears. Reproduced on a fresh Trading load 4 min after connecting. | FEEDBACK | yes (18, 22, live) |
| 4 | ⌘K | Only the 5 board currencies, tabs, sub-views, saved searches and leagues are searchable. "exalt", "seraph", "hinekora", "rising", "movers", "bulk", "7d", "window", "connect", "net worth" → No matches. | FIND | yes (14; `palette.js` builds `cur` items from board rows only) |
| 5 | Settings (right column) | Gold fees text names ggpk.exposed and a patch URL; "Manual overrides (id=gold …)", "Fallback: gold per 1 exalted", recipe "placeholder ids", "Unmapped currencies (1): OmenOnAlchemyMaximumSuffixes / Link". The player thought something needed configuring. | DISTRACTION | yes (28) |
| 6 | Board (Standard) | HOLD/MOVERS become a "HUBS" strip of bare numbers; Divine priced in Perfect Exalted, Chaos in Annulment, Annulment in "Uncut Support Gem"; gold dots and purple card borders with no visible meaning; titles cut off ("Mirror of Kalar", "Hinekora's Loc"). | MEANING | yes (17) |
| 7 | Board vs Hold | Two "movers" lists disagree: Board MOVERS #2 +288% at 7d, Hold › Positive movers #2 +146%. The list's Category column shows raw ids ("vaultkeys", "lineagesupportgems", "uncutgems"). | MEANING / WORDS | yes (03, 29; two endpoints with different filters) |
| 8 | Signals inbox | The inbox icon looks like a currency orb with a badge, not a bell. The entry "Victorious Fate ×3.3" uses a number that appears nowhere in the detail. The detail says "about to move" next to "last traded 74.5h ago", and a red pill "sell · day 38 +17.2%". | MEANING | yes (04, 05) |
| 9 | Economy › Inflation | Anchor defaults to Hinekora's Lock (nobody prices in it); "+98.56%" in red — good or bad?; the chart spans 14 days while the window says 7d; a "Hours 335" column; Regal shows "no price" on Board but +189% here. | MEANING | yes (12) |
| 10 | Economy › Market | Busiest markets are icon-only pairs with "24,891,610 / 2,347,190" and no unit; "All markets" opens with dozens of "recipe Reforge 3x … Depth 0 ∞" rows. | MEANING | yes (13) |
| 11 | Strategy › Convert | 1 Chaos → Divine says "No conversion route found" when the amount is simply too small (50 works); the grey "50" in the amount box is a placeholder that looks like a value, and Find route then says "too small". | FEEDBACK | tester (08, 25), not re-run |
| 12 | Board cards | "SC" badge; "daily close" vs "exchange price" captions; Regal: "no price" beside +51%; the 24h detail chart is a two-point line with no axes; the league day chip jumped 31 → 34 after a league switch. | MEANING | yes (01, 02) |
| 13 | Stash / Arbitrage | The app never asks what the player has. Stash was found only through the "Add … on Stash" link in Arbitrage; entry is manual even when connected; Liquid net worth stayed "…". | ACTION | yes (22, 23) |
| 14 | Trading › Mods | A crafter went to Strategy first. Once found, the picker was praised. (Grouping is the owner's call; recorded as data.) | FIND | tester |
| 15 | Top bar | First run shows "syncing · 52h behind" for a minute; "net worth 0 · liquid –". | MEANING | yes (01; a real install's seed is fresher) |

## Reassessed on the logged-in, synced app (2026-10-07 23:10)

The first drive ran on data 52 h behind with the item-history crawl unfinished and the trade view logged out. Re-driven
after the login fix and the current-league crawl:

- **#3** fixed (connect confirms the login from the site's own page; see Bugs). Sales now lists the week's sales.
- **#2 Hold**: #1 is still Seraph's Heart at 293 div, now "last traded 10m ago" (the 74 h was sync). Pills now read
  "sell · day 41 +22.5%" and "buy · day 36 −3.3%". Stays: unaffordable top pick, no price column, a buy pill with a
  negative number. The "stale item" part is dropped.
- **#6 movers**: the Board strip and Positive movers now agree (+153.9 / +51.5 / +43.7). Only the raw category ids stay
  ("ultimatum", "vaultkeys", "verisium"), while the Hold list next to it shows proper names (Gems, Expedition).
- **#7** dropped by the owner (Standard).
- **#8 signals**: "last traded 74.5h ago" beside "about to move" was sync; the icon, the "×3.3" and the red "+" pill stay.
- **#9 Inflation**: the chart is league-to-date, not the window, so that point is withdrawn. Stays: Hinekora's Lock
  anchor, red for "up", the Hours column.
- **#12 Board**: Regal's "no price" beside a % was sync. Stays: "SC"/"HR" badge, the two captions, truncated titles.
- **#13 Stash**: Sales works once logged in; entry of what you own is still manual, found through a link in Arbitrage.
- **#15** withdrawn (the sync chip did its job).
- Unchanged by login or sync: #1 arbitrage rows, #4 ⌘K, #5 Settings plumbing, #10 Market table, #11 Convert.

## Owner rulings on the mockup (2026-10-08)

Mockup: https://claude.ai/artifact/RqXMRWUewcoBDbMUZ46ykf

- **Loop rows (1):** keep the rates between the icons; keep "Needs" (the stake to run it once); drop the per-row quote
  time and show it once above the list; keep velocity, renamed and drawn as a relative visual rather than a number
  ("the number is kind of bad for users to parse"; the old bar "told the story effectively but was somewhat crude").
  Research on in-row relative visuals is in progress; the owner picks by eye.
- **Yield visual:** the owner picked the tier badge (S / A / B / C among the loops shown; "players know what a tier
  list is"). Band edges to decide at build time (proposed: by share of the best loop's yield, S ≥ 80%, A ≥ 50%,
  B ≥ 20%, else C).
- **New preset "High Yield"** (owner, 2026-10-08), read from the running app: identical to Balanced except the rank
  weights, which are velocity 1, gold efficiency 0, margin 0, volume 0. In `arbpresets.py` terms:
  `_preset("high_yield", "High Yield", min_margin_pct=20, max_gold=0, min_margin_per_1k_gold=0, min_liquidity_ref=1000,
  min_volume_ref_per_h=100, max_step_minutes=60, weights=(1, 0, 0, 0), volume_window_h=72, wide_spread=2,
  gold_value_per_1k=0.009527348253160697)`. Balanced stays the default unless the owner says otherwise.
- **The numeric arbitrage controls stay, on beta and dev builds only** ("I still want the ability to tweak the
  arbitrage values"): the More filters panel (and the gold slider's number) shows when the client is on the beta
  channel or is an unpackaged dev run, the same gate telemetry uses; stable builds show presets only.
- **Icons stay (6):** "I like that we use the divine orb that's rotating, it's unique. Same with the Vaal orb
  notification for a live search and the rotating currencies in the top left." No bell; change 6 keeps only the entry
  wording (price instead of "×3.3") and the sell pill in gold.
- **Bug fixed 2026-10-08 (uncommitted): a preset pick that changed only weights / window / spread / gold never
  re-ran the search** ("I altered the arbitrage config values and clicked a preset and nothing changed until I reloaded
  the page"). `pick` now searches itself when the filter key will not change (`routeFilters.sameSearch`; test in
  `settings-save-order.test.mjs`). Reproduced and re-proven on the dev app.
- **Inflation anchor stays (7):** Hinekora's Lock, with Mirror as the other stable choice. "Exalted orbs are a horrible
  inflation choice … Exalted orbs instantly inflate to being almost worthless a week into a league. Hinekora's lock is a
  stable asset akin to a car in the real world and a mirror is like a house." Change 7 is now colour, the Hours column
  and the "Anchor" label only.
- **Hold (2): UI only.** "I don't want to change how hold works at all, it took a lot of tuning to get it right, you can
  only change the UI." Approved: a Price column priced by the volume rule (`board.default_numeraire`, the codebase's
  standard). The ranking, the horizon logic and the buy/sell day numbers are untouched; the pill change is presentation
  of the same numbers (buy pill shows the day, sell pill the day and the gain).
- **⌘K (3):** "it needs to have no regressions, a lot of work has gone into improving search recently." Only the index
  widens; matching stays `lib/search.js` as shipped, guarded by its tests plus a pinned set of today's queries and
  first results.

## All rulings in (2026-10-08) — the build list

1. Loop rows: Loop (icons + rates) · Needs · Profit · Yield (tier badge) · Gold · Takes; quote time once above the list;
   expanded row = the trade list; "Arbitrage algorithm" expander gone; High Yield preset; More filters on beta/dev only.
2. Hold: a Price column by the volume rule; "Max drawdown" → "Max dip"; pills = same numbers, buy shows the day, sell the day and gain. Nothing else (Confidence stays: the detail doesn't show it).
3. ⌘K: every priced currency + task words in the index; `lib/search.js` untouched, pinned-query tests.
4. Settings: the right column on beta/dev only; "Trade session" → "Account"; Sync now stays.
5. Positive movers: game Exchange categories, game item class as the fallback. ("yes sure")
6. Inbox: icon unchanged; entry shows the price, not ×3.3; sell pill gold.
7. Inflation: anchor unchanged; ink + arrow instead of red; Hours column gone; "Anchor" → "Against".
8. Market: wealth-rule volumes with icons, the market's rate, recipes sorted last. ("sure sounds good")
9. Convert: real default amount; "Minimum N" from the backend. ("sure")
10. Board cards: no source badges; one caption; names shrink before clipping. ("sure")
11. What you hold: "Add what you hold ›" chip while empty, opens Stash; Arbitrage's notional banner → the same link. ("sure")

Already fixed, uncommitted: Connect confirms the login; a preset pick always re-searches.

## QA pass (2026-10-08, dev build on a throwaway profile; 30 screenshots; one Stash-open sales fetch, nothing else)

Verdict "ship with fixes"; every item 1–11 confirmed working. Defects, all fixed and re-driven:
1. Convert kept the last result on screen under new icons when the pair changed → the result clears on a pair change.
2. ⌘K Enter on a currency not on the board did nothing (it only opened board cards) → off-board rows open the app-wide
   card by name; rows carry `onBoard`.
3. "Per day" captioned "last 24h" beside a "Last 24h" tile that disagreed → caption "24h trend" (it is the trend slope;
   the measure itself is unchanged).
4. A second click on "Loop" reversed the order with no indicator → the Loop header always means best-first and shows ▾.
Polish from the same rules: the zoomed card loses its source badge and left border too; buy/sell pills run in day order;
the low-confidence badge is amber (caution), not red. Noted, not changed: "prices from" shows the oldest quote among the
loops shown (honest, can read stale beside "market 1m ago"); C-tier rows can sit above S in best-first order (the
order is the score, the badge is yield — by design); All markets' "Source" column is pre-existing.

## Code review (2026-10-08, high: eight independent finders, one fresh verifier per mechanism)

39 raw candidates → 21 mechanisms; 17 held (3 refuted, 1 settled by an owner ruling). All fixed test-first:
- Convert's minimum ignored the phantom-gain cap and only doubled (could name an amount with no route, or
  overshoot) → one `_accepted` predicate for the ranking and the minimum; bisect to the smallest passing lot;
  liquidity-starved paths skipped at once; computed only for Convert (`with_min_amount`), never for the Capital
  view's 30-second cash-out sizing, which also calls the ranking.
- The inbox showed an Exalted close with the reference icon → labelled Exalted.
- "Add what you hold" keyed on `total_ref > 0` (unpriced holdings hid the net worth) → on holdings with qty.
- `fmt.compact` printed "1000k" at a boundary → round first, then the suffix (and B).
- The busiest-market rate was rounded to 4 dp before the view's 3-sig-fig formatter → sent raw.
- Hold's prices were memoized with the ranking (a cold boot showed "–" for 10 min) → attached per request, outside
  the memo (`attach_prices`).
- Stable hid `allow_*`, gold overrides and "Show at most" with saved values nobody could change → migration m9
  resets them to defaults once (owner: a better default may override a saved value); defaults live once in
  `arbpresets.HIDDEN_KNOB_DEFAULTS`; the stable empty state says "Try a looser preset".
- The knob gate was recomposed in the renderer and cached for the session (the Beta toggle needed a restart) →
  `update:getChannel`/`setChannel` return `tweaks: diagTelemetryOn()`, the toggle refreshes it at once.
- Connect: "not /login" counted any page as signed in, and a hidden window could never be closed → the page's own
  log-out link is the signal (`SIGNED_IN_PROBE`), the window is shown whenever it is not confirmed, `confirmed` is
  claimed before the cookie read.
- Cleanups: dead `srcBadge`/`.pt-src`, dead `banded.metric`, one Sync now row for everyone, the Per-day tile uses
  the shared arrow formatter, no header tooltips narrating columns, no source colour on the Where cell, the
  top-bar action uses the same link style as Arbitrage, Convert's amount is derived (no seeding effect) and names
  come from the shared index, `exchange_category` lives with `_trade_id` in movers.
- Refuted: a "three pricing loops" duplication (the volume rule lives in `native_price`; callers repeat four setup
  lines), palette list identity churn, and the Rate-column unit (borderline, with precedent); the card caption is
  the owner's ruling.

## Rule check (2026-10-08, owner: "make sure none of your proposals violate the codebase rules")

Checked against CLAUDE.md (desktop contract, restraint, configuration, the volume rule), the styleguide and the memory
rulings. Adjustments made:

- **Settings (4):** the right column is gated to beta and dev builds, not deleted: gold-fee overrides, the recipe editor
  and the unmapped-currency linker are owner tools, and removing them would remove abilities. Same gate as the
  arbitrage knobs. The account name is shown only if it comes free from the login window's own page after sign-in;
  never a new trade-site request (the backend gateway owns that budget).
- **Categories (5):** the game's Exchange categories via `holdscore.exchange_category`; an item outside the Exchange
  falls back to its game item class from the seed's game data. No hand-written name map (rule:
  currency-categories-from-game-data).
- **Market (8):** no "Recipes" toggle (a knob); recipe rows sort after real markets. Volumes shortened by the wealth rule
  with each side's icon; the rate is the market's own (`Graph.direct_rate`).
- **Convert (9):** the minimum amount is computed by the backend, which already decides "too small"; the view shows it.
- **Board cards (10):** "SC"/"HR" and "daily close"/"exchange price" are source badges ("don't propagate logic
  decisions to the view"); the one caption is "traded …" for exchange-priced cards and "updated …" otherwise.
- **Channel gate precedent:** hiding product knobs on stable is the first non-diagnostic use of the beta/dev gate.
  Flagged to the owner; no new setting, no env var.

Pass as proposed: loop rows (tier bands and column set are code constants; presets owner-defined; Balanced default),
Hold price by the volume rule, ⌘K (index only; `lib/search.js` unchanged; local data), inbox entry wording, Inflation
colours and columns, the "Add what you hold" empty state (one action, no fetch).

## Owner's packaged check (2026-10-08)

- **"I see no loops, looks like the snapshot didn't take?"** Not the snapshot: the Mac's own market data was 41 h
  stale (no app had run since Oct 5). The catch-up landed in ~2 minutes, but `digest.pair_volume` (the depth
  yardstick every market edge must pass) is memoized for 10 minutes and was computed while the data was stale, so
  every edge failed until ~11:04 and the Board priced from poe2scout. Pre-existing in 0.3.14. Fixed test-first:
  `pair_volume` and `partners` rebuild on `state["last_hour"]`, as `window_rates` already did
  (`tests/test_digest_memos.py`).

- **"I searched exalted orb with cmd+k and got 'no price history for that currency'."** The reference currency had
  no card by construction (`cards()` dropped it; poe2scout prices everything in it). Owner: "is the exalted orb
  following the volume rule? its priced in divines" → the rule's readability walk is undefined for the base unit
  (nothing liquid is worth less than an Exalted), so the owner chose to quote it the way players do: the search opens
  the yardstick's biggest market's card, priced in the reference — Divine at 747 Exalted, that market's trend
  (`board._reference_row`, test in `test_direct_pairs.py`).
- **`dist:mac` bundles whatever `backend-bin/` holds** — two backend fixes "didn't take" until `build:backend` ran
  first. Noted in `docs/dev-notes.md`.

## Bugs to fix (logged 2026-10-07, not yet built)

- **Connected without being logged in.** The app reports "Connected" (the backend holds a POESESSID it accepted) while the
  embedded trade view shows the trade site's Sign in page and Stash › Sales says "no session". Seen on a fresh profile
  after the app's own login flow, three connects in a row. Owner's ruling: "I shouldn't be connected until I am confirmed
  logged in" — connect only once the trade view is confirmed signed in; a sign-in page means not connected and opens the
  real login. Until then the workaround is to sign in inside the Trading view itself (its Continue button).

## Task table (tester)

| Task | First click | Clicks | Result |
|---|---|---|---|
| Divine price, going up? | Divine card | 1 | done |
| What to hold a few days | HOLD chip | 3 | gave up (#1 = 305 div) |
| A loop I can do now | Strategy | 2 | done, not trusted |
| Best use of 50 ex | Strategy | 5 | done (Stash via a link; loops resized) |
| Bulk-buy on the trade site | Trading | 1 | gave up (sign-in page; nothing says bulk) |
| Bow mod pool | Strategy | 4 | done (Trading › Mods) |
| Rising hardest today | MOVERS chip | 1 | done (icon-only; full list is a toggle inside Hold) |
| Standard / 7d | dropdown / 7d | 1 each | done (7d updates everything instantly) |
| Connect | observe | 0 | Connect disappears; no account shown |
| ⌘K | ⌘K | – | tabs and leagues only |
| Every screen | – | – | see map |
| Empty states | – | – | each gives one action |

Screen map ("what is this for", ≤12 words): Board = prices of a few currencies · Arbitrage = currency loops for profit
(can't read them) · Hold = where to park currency · Strat Calculator = farming profit per hour · Inflation = currency
inflation vs an anchor · Market = pair chart + tables I couldn't read · Workspace = trade searches · Live = live-search
alerts · Stash = type in what I own · Regex = in-game search strings · Mods = mod pool and roll odds · Settings = sounds
and theme, plus internals I couldn't place.

## Delight (tester)

7d re-renders every card, chip and list instantly. Regex and Mods feel like a built-in poe.re / Craft of Exile. Every
item opens the same detail card; the league-arc forecast looks great. Loops resize to the player's 50 ex at once.
"I'd come back tomorrow for Regex, Mods and the Divine pair chart. I'd use Arbitrage only if I could read it."

## What the literature says (for judging the above)

Primary sources in [`ui-research-2026-10-07.md`](ui-research-2026-10-07.md). The points that bear on these findings:

- **Users act before they read** (Carroll & Rosson 1987; Nielsen 2008: 20–28% of words read). A correct first click
  predicts success (87% vs 46%, Bailey via Sauro 2011). Fixes are structure, naming and defaults, not copy.
- **Recognition over recall**: an icon alone is recall; hover labels don't count (Harley 2014, NN/g). A one-word label
  beside an icon is the brief label the owner allows. Applies to the HOLD/MOVERS chips, the inbox icon, busiest-market
  pairs and loop chains.
- **Overview first, details on demand, two levels at most** (Shneiderman 1996; Nielsen 2006). Applies to loop rows,
  Hold rows and the Settings right column: give the answer on the row, the reasoning nowhere.
- **Guidance for novices slows experts** (expertise reversal, Kalyuga 2003) and **onboarding tours did not improve task
  performance** (NN/g). No tours, no help text.
- **Defaults decide outcomes** (Mackay 1991; Johnson & Goldstein 2003). The Inflation anchor and the Hold ranking's
  default view are the product for most players.
- **Status within time limits** (Nielsen; 1 s / 10 s). "Connected" that isn't, and a Convert error that names the
  wrong cause, are status failures.
- **⌘K is for experts**: no study shows palettes aid discovery; shortcut use rose when the shortcut was shown at the
  moment the user took the slow path (Grossman 2007).
- **Peak-end** (Kahneman 1993): the worst moment (an unreadable loop, a sign-in wall after "Connected") shapes the
  memory of the session more than any polish.

## Ruling 2026-10-08 (evening): the volume rule, then the readable side

The reference card fix shipped to the owner's packaged check as a special case for the reference currency
(`_reference_row`), and the regression gate showed it touched one card. Owner: "Why would you hard code it that
way? You should have a deterministic rule that chooses when and how to flip things." Measured on a copy of the
owner's data (658 priced currencies): the walk-down in `default_numeraire` had put Exalted in verisium (market #37,
0.9% of its Divine volume) and Chaos in Vaal (#47, 0.5%), and printed a reference cross for 9 currencies whose
only market reads below 1. Two candidate rules were put to the owner with every card each changes; the owner ruled:
**"follow the volume rule and then apply readable side to the volume rule"** — the busiest market names the
numeraire, no walk; the view draws whichever side of that market reads ≥ 1. 134 of 623 cards change; the reference
needs no special case. Backend: `default_numeraire` is the busiest market (`board.py`); the view: `readable()` /
`flipChange()` in `lib/price.js`, the one `<Rate>` element at every price site (Board tiles and hubs, CardDetail,
Hold, the inbox). Documented in CLAUDE.md (the volume rule) and the styleguide ("Which side").

## Ruling 2026-10-08 (late): the Stash is its own tab

Owner: "I want stash to be its own tab at the top ... right after board, then strategy then trading then economy and
then settings." Tabs are now Board · Stash · Strategy · Trading · Economy · Settings (⌘1–⌘6). The screen id is `stash`
(section Stash, no sub-view) in the one screen list (`frontend/src/lib/dests.js`, its desktop twin and the bot opener's
allow-list); Trading keeps Workspace, Live, Regex and Mods. Every road to the Stash (the Arbitrage rail, the top bar's
empty state) goes through `nav.goStash()`.
