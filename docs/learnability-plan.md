# Learnability pass: plan (2026-10-05)

**Status:** built test-first 2026-10-05 (uncommitted). Next: QA, review, and the owner's check in the packaged app
([feature-flow.md](feature-flow.md)).

**Origin:** the owner asked for a UI audit ("make it easier for users to learn the app"). The audit drew on three
sources: every screen photographed, an 11-task first-time-player walkthrough, and research on UI best practice and on
how PoE2 players work. The owner ruled on each finding. The mockup of the result is at
https://claude.ai/artifact/7d6cfU4JTiXtgnLeLVmFi7 (Today / After switch, "Show empty screens").

**Out of scope (owner rulings):**
- icon-only rows stay, with names on hover;
- the global 24h/3d/7d/14d picker stays as it is;
- algorithms are never explained on screen;
- Live stays its own screen (the hotkey lands on one travel button);
- the tab layout stays (players use Regex and Mods while trading).

## 1. ⌘K starts with the current screen's actions

**Today:** the palette opens on Workspace commands and nine themes on every screen, so Enter creates a search. It
matches screen names only ("bug", "waystone" and "convert" find nothing).

**After:**
- **Order with an empty box:** the current screen's commands first, then the five tabs (each showing ⌘1–⌘5), then
  sub-views, saved searches and currencies.
- **When typing:** other screens' commands, themes and leagues also appear. The current screen's commands still rank
  first.
- **Running a command:** does exactly what the matching control does, usually putting the cursor in an existing box.
- **Commands per screen:**

| Screen | Commands |
|---|---|
| Board | Add a currency |
| Arbitrage | Convert… (cursor in Have) |
| Hold | Category… |
| Strat Calculator | Start / Stop timer, Add loot…, Add map +1, New strat |
| Inflation | Change anchor… |
| Market | Pick a pair…, Filter markets… |
| Workspace | New search ⌘N, New group ⌘⇧N, Add from clipboard ⌘⇧V, Sort searches A–Z, Toggle searches rail |
| Live | Jump to newest ping ⌘G |
| Stash | Add a currency, Find in stash. **Never** "fetch Merchant History", which spends the shared allowance. |
| Regex | Copy regex, Waystones, Tablets |
| Mods | Paste item, Item type…, Filter modifiers… |
| Settings | Report a problem…, Test ping sound |

- **Task words** (hidden keywords on the screens and commands in `lib/dests.js`, matched by the shared search's
  keyword tier):

| Words | Destination |
|---|---|
| flip, loop, convert | Arbitrage |
| invest, swing | Hold |
| farm, profit per hour | Strat Calculator |
| waystone, tablet, highlight | Regex |
| affix, tier, craft, modifiers | Mods |
| sound, notification, theme | Settings |
| bug | Report a problem… |

- **Shape:**
  - App passes the current screen to the palette.
  - Each view registers its commands, with their targets, through one small registry, the same way `nav` events
    work. Commands for a view that isn't mounted navigate there first, then run.
  - The palette list stays `buildPaletteItems` (pure, tested).
- **Tests:**
  - order per screen;
  - the first row on each screen;
  - task words reach their destinations;
  - Stash exposes no history fetch;
  - themes and leagues appear only when typed.

## 2. Plain words

| Where | Today | After |
|---|---|---|
| Top bar, market tooltip | `last hour 1791165600` | `Last market update 23:00` (local time) |
| Arbitrage, Convert subtitle | "…another — an open path, not a loop." | "…another" |
| Hold, Category column and filter | poe2scout ids (`lineagesupportgems`, `uncutgems`) | the game's Currency Exchange category (Gems, Uncut Gems, Expedition…) from `gold_fees_meta`, as Stash groups use (`holdscore.exchange_category`). An item the Exchange doesn't list keeps its source category unchanged. |
| Hold, numeraire switch | `vs Divine · vs Mirror · vs Lock` | `vs` + the currency icon, full name on hover |
| Hold, last column | `Conf.` | `Confidence` |
| Inflation, subtitle | "soft currencies priced in a hard asset, indexed to 100 at league start" | (none) |
| Inflation, anchor label | `Hard-asset anchor` | `Anchor` |
| Inflation, first card | `Basket inflation vs X` · `since data start` | `Inflation vs X` · `since <first data date>` |
| Inflation, velocity card | "last 24h trend — rising = dump soft, hold hard" | "last 24h trend" |
| Inflation, last card | `335h of data` | (none) |
| Market, lower section | `Edges in the current graph` | `All markets` |
| Settings, Market signals | "the analytics sidecar flags something 'about to move'" | "a currency looks about to move" |
| Settings, account panel | "Not configured … See README → OAuth if you want it." | panel hidden while OAuth isn't configured |
| Settings, workspace export | "the EE2 history folder never travels" | "Exiled Exchange 2 history stays on this computer" |

**Tests:** source pins for each string. The Hold category mapping is tested on real item ids, including the fallback.

## 3. Empty screens

| Screen | Today | After |
|---|---|---|
| Live, no saved searches | "No saved searches yet — add some in Workspace." | "No saved searches yet." + **Open Workspace** |
| Live, nothing pinged | "Armed watches ping here." | "Press Go live on a search." |
| Market, empty pair | "No history for this pair yet. The hourly digest fills in…" | "No trades for this pair yet." |
| Hold, first run | the poe2scout "Building the asset history…" notice | removed; loading rows, as the orb already shows work |
| Inflation, thin anchor | "Not enough X trades captured yet… Try the Divine anchor (denser), or let more hours accrue." | "Not enough trades yet." + **Use Divine Orb** |

## 4. Arbitrage presets (owner-defined)

**What it is:** one row of buttons at the top of the Arbitrage sidebar: **Balanced · Quick flips · Big margins · Gold
efficient · Safe**.

**Behaviour:**
- Picking a preset writes its values into the existing settings through the normal settings save.
- The numbers stay where they are, under Filters, More filters and Arbitrage algorithm.
- The highlighted button is **derived**: a preset is shown as selected while the saved values equal it. Editing any
  number therefore deselects it. There is no new setting or key.

**What a preset carries:**
- every value under Filters, More filters and Arbitrage algorithm;
- the gold value slider;
- not Start from, Show at most, or Fraction of held capital to commit.

**The default:**
- Balanced is the default for new installs: backend `DEFAULTS` and frontend `DEFAULT_FILTERS` both derive from it.
- A one-time user migration (`_m8`, idempotent marker) **replaces every user's saved arbitrage values with Balanced**.
  Owner: "default will override people's current configs … by creating this new default we're improving the app, not
  changing a user's preferences."

**One definition:**
- The presets live once, as backend code constants (`settings.py`).
- The frontend reads them from the settings response; no second copy in JS.
- A test pins the five sets to the values below.

**Units:**
- liquidity, volume and margin-in-currency thresholds were tuned in exalted, the owner's reference;
- gold value is divine per 1k gold.

A user with another reference currency must get the same thresholds, so the values convert at apply time, or the
backend reads preset thresholds as exalted. Decide in TDD with a test using a divine reference.

**Release:** this changes what Arbitrage shows for everyone. The regression gate will stop the release until the
difference is accepted for that version in `ops/regression-accept.txt`.

**Values** (tuned by the owner in the packaged app on 2026-10-05; liquidity and volume in exalted; 0 = no limit; recipes
allowed in all five):

| | Balanced | Quick flips | Big margins | Gold efficient | Safe |
|---|---|---|---|---|---|
| Minimum margin % | 20 | 5 | 66 | 0 | 8 |
| Minimum margin, in currency | 0 | 0 | 0 | 0 | 0 |
| Maximum gold per loop | 0 | 1,000,000 | 2,000,000 | 1,000,000 | 1,200,000 |
| Minimum margin per 1k gold | 0 | 0.41 | 0 | 0 | 0 |
| Minimum liquidity | 1,000 | 200 | 2,000 | 2,000 | 10,000 |
| Minimum traded volume / h | 100 | 10,000 | 2,000 | 2,000 | 5,000 |
| Maximum minutes per step | 60 | 15 | 45 | 45 | 120 |
| Maximum fill hours | 0 | 0 | 0 | 0 | 0 |
| Minimum velocity | 0 | 0 | 0 | 0 | 0 |
| Maximum steps per loop | 3 | 3 | 3 | 3 | 3 |
| Minutes per exchange step | 2 | 2 | 2 | 2 | 2 |
| Volume window, hours | 72 | 24 | 24 | 24 | 72 |
| Inactive market spread | 2 | 2 | 3.5 | 3.5 | 2 |
| Weight: velocity | 0.6 | 0.8 | 0.2 | 0.9 | 0.3 |
| Weight: gold efficiency | 0.2 | 0.2 | 0.2 | 1.0 | 0.2 |
| Weight: margin value | 0.35 | 0.4 | 1.0 | 0.2 | 0.5 |
| Weight: traded volume | 0.3 | 0.4 | 0.35 | 0.4 | 1.0 |
| Gold value (`gold_value_per_1k`) | 0.009527348253160697 | 0.009098518761145686 | 0.019452225334578275 | 0.05 | 0.019905251005215174 |
| ≈ gold per divine | 105k | 110k | 51k | 20k | 50k |

**Measured offline** on a copy of the owner's market data (real search, each preset's full settings, 2026-10-05):

| | Loops passing | Typical margin | Typical fill | Profit / 1k gold | Shared with Balanced |
|---|---|---|---|---|---|
| Balanced | 214 | 53% | 1.2h | 6.4 | — |
| Quick flips | 36 | 13% | 0.13h | 2.0 | 20% |
| Big margins | 49 | 120% | 0.27h | 4.0 | 17% |
| Gold efficient | 197 | 17% | 0.5h | 8.4 | 16% |
| Safe | 81 | 25% | 1.0h | 10.7 | 33% |

The presets are distinct: Safe shares 37% of its loops with Quick flips, and every other pair shares less.

## 5. Arbitrage search: cancellable, never stuck

**Seen 2026-10-05:** while the owner tuned presets the list stayed blank and the backend sat at 100% CPU for a while.

**Measured** (offline copy of the owner's data, the real search):

| | Search only | Search + simulation + deep scan | Full stream endpoint |
|---|---|---|---|
| 3 steps | 0.06s | 0.42s | 0.8s (Gold efficient), 1.0s (every filter off) |
| 4 steps | 0.02s (20,000 cap) | 0.70s | 1.1s |
| 5 steps | 0.16s (cap) | 0.89s | 1.8s (every filter off, 16 MB) |

Graph rebuild: 0.2–0.4s. Dragging Maximum steps per loop in the real app: one debounced search, 0.74s, backend idle.
**The search is not slow at any step count**, so there is no speed work. The cause of the 100% CPU was not
reproduced (background work in the app is the likeliest). What was built:

1. **Abandoned searches stop.** `stream_routes(…, cancelled)` checks every `CANCEL_CHECK_EVERY` (50) candidates and
   returns uncached. The SSE endpoint computes each chunk in a worker thread, checks `request.is_disconnected()`
   between chunks, and signals stop on any exit.
2. **The page never waits on a dead search.** `lib/routesStream.js streamSearch` owns the stream: every event
   re-arms a 30s idle watchdog (`SEARCH_IDLE_MS`), done and failure close it, a superseded search reports nothing
   more, and the page always leaves the searching state on failure.

## QA pass 1 (2026-10-05): what it found and what was fixed

- **Arbitrage stuck after a step change plus a tab switch.** Reproduced in 2 of 6 runs, with backend stacks captured
  during the stalls. At 4–5 steps, two walks that follow the Arbitrage step count kept the backend busy, and the list
  queued behind them:

  | Steps | Stash cash-out valuation (39 holdings, every 30s capital poll) | Convert's bridge tie-break |
  |---|---|---|
  | 3 | 1.0s | 0.05s |
  | 4 | 13.6s | 3.5s |
  | 5 | 97s | 36s |

  Both now walk a fixed 3 steps (`liquidity.CASHOUT_MAX_STEPS`, `centrality.BRIDGE_MAX_STEPS`), which is unchanged at
  the default. At 5 steps they now take 0.98s and 0.05s. A timed-out search is searched again, and "No loops yet" needs a
  finished search. After the fix, 19 of 19 runs settled in 3s or less.
- **⌘K → Enter on the Strat Calculator started the timer.** The first action is now "Add loot…" (focus only), and a
  test keeps every screen's first action non-changing.
- **"league" found nothing.** League rows match the word now.
- **A process importing `settings` first crashed while booting the database** (m8 imported settings mid-import). The
  presets now live in `app/arbpresets.py`, which has no app imports.
- **Not changed:**
  - duplicate theme names (the owner's own custom themes);
  - Convert's picker opening on focus (Escape restores it);
  - remaining jargon the tester listed beyond the approved list. These are candidates for the owner.
- **Not covered:** Inflation's empty state (all three anchors have data).

## QA pass 2 (2026-10-05)

The stall is gone: every scenario loaded rows in 3s or less, with no false empty message. Found and fixed:

- **Raising Maximum steps per loop shrank the list.** This predates the pass. The search went depth-first from the
  first held currency, so at 4–5 steps that currency's long loops filled the whole 20,000-candidate cap. Quick flips
  kept 34 loops at 3 steps and 2 at 5, and Divine and Exalted got no candidates at all. `routes.search_cycles` now
  keeps the original order exactly whenever it fits under the cap (every preset), and switches to shortest-first,
  held currencies taking turns (`cycles_shortest_first`), only when the cap would cut loops.

  Proven against the committed code on a copy of the owner's data, all five presets:

  | | 3 steps | 5 steps, loops kept (old → new) |
  |---|---|---|
  | Balanced | identical routes, scores and order (only the time-based age fields differ) | 164 → 480 |
  | Quick flips | identical | 2 → 36 |
  | Big margins | identical | 13 → 90 |
  | Gold efficient | identical | 52 → 429 |
  | Safe | identical | 21 → 135 |

  The golden snapshot is unchanged.
- **A hand edit followed within about 300ms by a preset click was lost, and no preset was highlighted.** Settings
  saves are now serialised (`statusStore.saveSettings`). A pick redraws the sliders first (each sends its pending
  edit), then flushes the filter boxes, then saves the preset. The gold slider sends a pending value when it unmounts.
- **⌘K → Enter on a just-opened palette acted.** Settings packaged a report, Mods pasted the clipboard, and Regex
  overwrote it. Each screen's first action now only focuses or reads: Regex and Mods start with "Filter modifiers…",
  Settings with "Test ping sound". Workspace keeps New search, the owner's own example.
- **Not reproduced:** once, the app showed Arbitrage after ⌘K → Enter on Settings. "bug" + Enter opens the report
  dialog where you are, which is intended: the dialog belongs to the whole app.

## Code review (high, 2026-10-05)

Eight independent reviewers found 21 distinct candidates, and each went to its own fresh verifier.

**Fixed, test-first:**
- **The volume window moved every price (confirmed).** `volume_window_h` fed the one shared market graph, so Balanced's
  72h (and every later preset pick) would have moved Board, Hold, Convert and Capital for everyone. The market graph now
  uses a fixed `MARKET_VOLUME_WINDOW_H = 24`, and only the route search builds its own graph over the preset's window
  (`cached_graph(volume_window_h=…)`, separately cached). Against the committed app at its 24h default, with Balanced
  saved, the market's 658 prices, 2,685 markets and busiest markets are identical. Arbitrage at 3 steps is still
  identical for all five presets.
- **Cash-out read the Arbitrage filters (confirmed, two findings).** It read an exalted floor as reference units, and
  m8's `max_fill_hours` 0 turned off its fill guard. Cash-out now has its own constants, `CASHOUT_MIN_VOLUME_EX_PER_H
  = 100` (converted to the reference) and `CASHOUT_MAX_FILL_HOURS = 24`, which are the old defaults.
- **The watchdog's retry was unbounded (plausible).** A quiet search now emits `progress` every 5s; the page retries
  a timeout at most twice, then says so. A cancelled search no longer starts the deep scan.
- **⌘K listed actions whose control was hidden or disabled (plausible).** The palette now lists only usable actions
  for the current screen (`usableHere`).
- **The first-action test was a denylist (confirmed).** It is now an allowlist: focus only, plus a named harmless set.
- **Cleanups:**
  - `Graph.iter_cycles` is back to its committed form;
  - the preset copy is inlined;
  - the gold slider uses `useAutosave`;
  - presets load through `useApi`;
  - there is one `goSub` dispatch.

**Refuted:** DEFAULTS drift (tests catch it), the OAuth panel text (older than this change; unreachable on desktop),
the Convert caption (owner-approved), the warning floors' unit, and the two fixed-step constants.

**Left as is:**
- the eager cycle list (under 0.2s);
- the Hold name scan (about 30ms per cache miss, as before);
- `DEFAULT_FILTERS` (older drift, failed-load path only);
- the migration boilerplate (the module's "append only" rule).

## Verification

- **Tests and gate:** `ops/run-tests.sh` green.
- **CDP drive:** every screen in Today and After, ⌘K on each screen, the empty screens, and preset clicks writing the
  values and deselecting on edit. During the drive, read `/api/settings` (GET only) to confirm the writes.
- **Migration:** run against a copy of `user.sqlite` with old values, and check it is idempotent.
- **Search under load:** drag Maximum steps per loop back and forth and confirm the list recovers within a few seconds.
- **Then:** QA (qa-eng), code review at high, and the owner's check in the packaged app.
