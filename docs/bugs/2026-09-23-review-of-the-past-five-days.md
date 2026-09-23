# 2026-09-23 — review of the commits since 2026-09-18, and the fixes

Forty commits (0.2.63 → 0.3.3) reviewed for correctness. The full gate was green before and after;
none of what follows was caught by a test, which is the point of the reproduction files:

- `backend/tests/test_review_2026_09_23.py` (21 tests, 8 over the owner's real market DB)
- `ops/feedback-bot/tests/test_review_2026_09_23.py` (2)
- `desktop/test/feedback-review-2026-09-23.test.mjs` (3)
- `frontend/test/hold-empty-category.test.mjs` (2)

Every test was written first, run red for the stated reason, then the code was changed until it
passed, then the neighbouring suites and the whole gate were run. The owner set the expected
behaviour for each before the test was written.

## Fixed

**A wide spread is a question that depth answers** (`digest.directed_rates`, `digest._deep`). The
2026-09-19 rule marked a market dead when its executed prices disagreed by more than
`wide_spread`. On the real league that was 1,391 of 2,520 markets. Owner: a wide market with a
book on both sides is a market; one order against a wall is not. The book is the digest's standing
stock (bulk exchange is retired for good, so there are no live books), and depth is measured in
hours of the pair's own executed volume, so the same rule judges a market that moves ten a day
and one that moves a hundred thousand. Two settings with defaults: `depth_hours` (1.0) and
`depth_balance` (0.1). The spread threshold stays the `wide_spread` setting. On the real league the
rule revives 384 of the 1,391; Tecrod's Gaze stays dead (0–9 gazes ever standing against thousands
of exalted).

**A currency's busiest market prices it, and "busiest" is THE volume rule**
(`graph.counterparts_by_volume`, `Graph.quote_busiest_markets`, `Graph._widest_values`). Ulaman's
Gaze read 44.66 ex under a line ending at 202: every one of its markets was wide, so the number was
a dead market's cheapest hour while the line was the window fold. Owner: the market that actually
trades a currency is its primary market, by default. "Volume" took three rounds to pin down, each
against the real league:

- Not counterparty units: 12.5M exalts for the Abyssal Echoes omen are 146k omens, against 460k in
  divine.
- Not value traded, and not the hub detector's value flow either: for Thaumaturgic Flux (Level 15)
  the chaos and divine markets pay 10-20× more per unit, so by value they out-rank the exalted
  market that moves five times the flux. Owner: the exalted market is that item's primary market.
- Not gold-adjusted: charging gold in item units needs the item's own value, which is exactly what
  is unreliable when it matters (valued at a bad 1.0 close the flux would owe 246 flux an hour).
  Gold stays where it is charged today (routes, convert, cash-out).

What survives all four of the owner's statements is ITEM UNITS: a currency's busiest market is the
one that moves the most units of that currency an hour, both ways (what it sold there plus what the
other side's sales bought). It needs no value table and cannot be moved by one. League-wide it
defaults 355 of 582 multi-market items to their exalted market, the cheap things that genuinely
trade there; the echo, the gazes, the cranium, annul and whittling keep divine or chaos.

Three things hang off it now. (1) `counterparts_by_volume` moved from `board.py` into `graph.py`,
counts both directions, ignores `rv`; the Board's default numeraire and the league arc's fallback
read it as before. (2) A dead busiest market is quoted: its edges take `quoted_rate` (the window
rate, carried on every edge by `digest.directed_rates`) and stop being dead; the 2026-09-19 extreme
pricing applies to secondary markets only. Pinned consequence: a currency with one market is priced
at that market's window rate however far its hours disagree. (3) The value table's last word: a
currency is worth what its busiest market says, priced off that counterpart's value, provided the
counterpart sits closer to the reference than the currency itself (a hub is never re-priced through
one of the small things that trade against it). Before this the walk took the widest chain by value
and `believable` let a poe2scout close more than 10× away veto any market; a currency none of whose
markets survived was then priced FROM that close. 23 cards showed a close under a market's line
(flux at 1.00 under 25.7; Artificer's Shard at 59 over 0.8), and the shipped 0.3.3 shows the same
numbers, so this was inherited. poe2scout still guards secondary markets and prices what has no
market at all.

Sources checked for the rule (verbatim in the session, not repeated here): CoinGecko and
CoinMarketCap rank pairs by value volume and drop stale/outlier pairs before averaging;
GeckoTerminal picks one primary pool by liquidity plus value volume; CME CF reference rates use
volume-weighted medians; Binance reports base and quote volume separately; Hasbrouck (1995) shows
the price-leading venue need not be the volume leader and may have the widest spread. None of them
had to price an item whose own markets disagree 20× on what it is worth; the owner's call for that
case is the market that moves the most of it.

Owner's note for later, not built: markets like the level-15 flux are not economically relevant to
a player with a 100-divine bank. A relevance floor (hide or de-rank markets whose flow is negligible
against the player's capital) is where gold cost belongs too.

**A card's line ends on its number** (`board._fold_series`, `board._priced_history`). The number
folds the last 48h; the line folded the window plus 48h of warm-up and only trimmed the output, so
a burst two days ago bent today's end. Now every point is the 48h fold at that hour, and the line
always carries a final point at the current hour (the same fold the number is), so it ends on the
number whether the market traded this hour or two days ago. Measured before the last step: of
1,005 markets whose last trade was older than the newest hour, 15% were off by more than 1% and
the worst by 242%. Over the real league, all lines end on their number now, stale ones included.
The existing production coherence test could not see any of it because it trimmed the rows to 48h
before folding both sides.

**A currency whose only market is dead is worth the same with or without a neighbour**
(`Graph.values`). The walk refused a dead market while a live one existed, and when that live one
led nowhere the currency fell through `ref_values`, which read the dead market at its ask: a gaze
worth 87.5 ex alone became 3,114 ex once an unrelated market hung off it. The walk now runs a
second pass that prices only what the first could not, through its dead market at the bid.

**An empty Hold category is not a missing backfill** (`main.hold`, `HoldView`). Picking a category
none of whose assets pass today's gate returned no rows; the endpoint read that as "no data" and
started a full poe2scout crawl, and the page said so. Now the crawl fires only when nothing at all
is scored, and the page says "Nothing to hold in idol right now — pick another category."

**The forecast never reads before the league began** (`holdscore._predict`). The ±5 start-day
window went negative for league-days 1–4 and resolved to day 0 several times over. Clamped at 0.
The shipped IC measurements (`test_the_shipped_window_beats_one_day_on_the_real_leagues`) still
pass.

**`wide_spread` cannot mark every market dead** (`settings.wide_spread`). A value in (0, 1) made
`hi/lo >= wide` true of every market that traded twice; a non-numeric value raised inside every
graph build. Only 0 (off) and ≥ 1 mean anything; anything else reads as the default.

**No single-hour pricing through the setting** (`digest.latest_rates`). A `digest_max_age_h`
above 48 left the older markets to their newest hour alone. The pricing window is now at least as
wide as the rows it prices.

**A market whose sides agree has a spread of exactly 0** (`board`), not −7e-15.

**Bug reports carry neither the PoE account name nor the OS user name** (`redact.js`). `username`
is dropped; any `*_dir`/`*_path` value keeps only its last folder. The comment that claimed the
dialog disclosed the account name was wrong and is gone.

**One report package at a time** (`feedback/index.js`). The snap window shares one
`session.webRequest` listener, so a dialog closed and reopened mid-package started a second sweep
that replaced the first's write filter. A second request now joins the in-flight one.

**The bot never overwrites a stored report** (`bot._move`): a second report under an earlier
shortId goes beside it. **A half-written `result.json` is waited out**, not refused, and the opener
writes it atomically.

**The vendored EE2 trade snapshot is written in a stable order** (`sync-ee2.mjs`): GGG returns it
shuffled, so every release committed an unchanged 850 KB file. Sorted by id; the committed file and
its manifest hash were re-sorted once by hand.

**Two tests that could not fail** now can: the ANALYZE test exercises the boot path, and the
`hold_caution` fallback test reads the setting.

## Cleanup, done after the beta

- **The graph no longer reads bulk-exchange books.** The Bulk Item Exchange is retired for good
  (owner, 2026-09-23); its live-edge path in `Graph.build` was dead code carrying two latent bugs
  (a live edge had no `inactive` flag, so `dead()` answered by orientation; the bait filter was
  judged against a dead market's extreme). `credible_offers`, `BAIT_FACTOR` and the build loop are
  gone, with their tests. `orderbook.py` keeps its deprecated switch and its own tests.
- **Bid, ask and spread are cut from every card** (`buy`, `sell`, `spread`, `spread_pct`, `depth`
  on `/api/board` and `/api/asset` rows). With the books gone the digest gives one window rate both
  ways, so they were the number twice and 0; nothing rendered them (the zoomed card read them into
  variables and never drew them; the board tile's comment claiming otherwise was stale).
- **The Arbitrage page's spread input starts at 1.** The server reads a value in (0, 1) as the
  default; the input no longer offers one. The setting's 0 (off) is still honoured if saved
  through the API.
- **`graph.py` leftovers**: the duplicate `_scout_values` and the unreachable `_floor_values`.

## Found and left alone, on purpose

- `arrows()` strength for a side with fewer than three forecasts, and ties in board order.
  Cosmetic at today's 55 up / 12 down.
- A vendor recipe pricing a currency that has no other market. Owner: recipes are valid markets.

## Goldens

`board.json` / `board_72h.json`: only `spread`/`spread_pct` for Divine, −7e-15 → 0.0.
