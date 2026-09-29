# BUG — the market sync leaves partial data: a half-crawled last day in the seed, and item histories that silently stop

**Status:** FIXED — shipped in desktop-v0.3.6 (2026-09-29); production publishes hourly through the seed poll · **Found:** 2026-09-28 (data-integrity check before a stable
ship) · **Owner's rule:** sync bugs are T0 blockers for stable (`docs/release-runbook.md` "T0 gate";
feedback memory "sync bugs are T0 blockers") — decide whether this blocks 0.3.6 · **Affects:** the
published market seed (every fresh install and every seed replace) and every client's league-history crawl.

Owner: "we shouldn't have partial data."

## What was seen

Checked read-only on 2026-09-28/29: the published seed (`market-seed-latest`, v1790569300, exported
2026-09-28 04:22 UTC by shazam's 04:17 cron), shazam's live `market.sqlite`, and the owner's local
`market.sqlite`. All three pass `PRAGMA quick_check`/`integrity_check`; no duplicate or zero/negative
closes; every league has a row for every calendar day. The gaps are *coverage*, not corruption.

### Gap A — the seed ships a half-crawled last day

`league_daily` rows for the seed's last day, vs the day before:

| league | 2026-09-27 (seed) | 2026-09-28 (seed) | 2026-09-28 (shazam live, later) | 2026-09-28 (owner's client, later) |
|---|---|---|---|---|
| Forbidden Rites | 582 items, Divine ✓ | **30 items, no Divine** | 516, Divine ✓ | 542, Divine ✓ |
| Runes of Aldur | 518 items, Divine ✓ | **24 items, no Divine** | 386, Divine ✓ | 393, Divine ✓ |

The exporter ran while shazam's crawl was still pulling that day, so the seed carries 5% of the day.

### Gap B — an item that drops below 5 exalted stops being crawled, and its history freezes

In the owner's client DB, per `lh_fetch:<league>:<item>` stamps (the time each item was last pulled):

| league | items stamped | median hours since fetch | **items not fetched for > 24h** | oldest |
|---|---|---|---|---|
| Forbidden Rites | 620 | 9.9 | **89** | 13.3 days |
| Runes of Aldur | 620 | 9.1 | **104** | 13.4 days |

Their `league_daily` series simply end: Diluted Liquid Greed on 2026-09-15, Orb of Alchemy and Lesser
Stone Rune on 2026-09-20, Stone Rune / Stag Idol / Daresso's Passion on 2026-09-15, Transmutation Shard on
2026-09-11. Nothing marks them as ended.

## Impact

- **Hold, Movers, league arc:** mostly protected. `holdscore._build_league` drops any day without a Divine
  close, so the seed's partial day disappears. But a frozen item stops appearing on a day's board, so the
  regime detector and every cross-sectional rank see a board missing the items that fell under 5 ex: a
  survivorship bias toward items that held their price.
- **Economy / market cap:** drops the partial current day (commit f637db3), but its totals exclude frozen
  items from the day they froze, a slow undercount.
- **Research / backtests:** `ops/hold-backtest.py` and `ops/hold-diagnostics.py` read the same tables, so
  items that crashed below 5 ex vanish instead of registering as crashes. The crash numbers in
  `docs/hold-research.md` may be **flattered**; re-measure after the fix.

## Findings (investigated 2026-09-29, read-only)

Measured on the published seed (re-extracted from the `market-seed-latest` asset), shazam's live
`market.sqlite`, shazam's container logs, and poe2scout directly. Crawl "passes" below are clusters of
`lh_fetch` stamps (a stamp is overwritten on every fetch, so only each item's latest fetch survives).

### Root cause 1 — the export runs on a clock, the crawl drifts, nothing couples them

- The export is a fixed cron (04:17 UTC). The server's crawl loop (`main._league_history_loop`) runs a
  pass, then sleeps 12h, so it drifts about 30–40 min a day, and **every container restart starts a new
  pass immediately** (deploys restarted it at 02:46 and 04:05 on 2026-09-28).
- What the 04:22 seed actually holds:

  | pass (UTC) | Forbidden Rites items | Runes of Aldur items |
  |---|---|---|
  | 09-27 21:14–22:10 (last full pass) | 532 | 508 |
  | 09-28 02:46 (restart) | 27 | 23 |
  | 09-28 04:05 (restart) | 8 | 9 |

  The full pass ran **before 09-27 had closed**, so even the seed's "complete" day is provisional:
  Divine 09-27 in the seed = close 562, volume 20.9M; final = close 536, volume 22.7M. The two restart
  passes ran after midnight and fetched ~35 stragglers, which is where the 30- and 24-item 09-28 day came from.
- The exporter's only guard is the hourly digest lag (`--max-digest-lag-h`); nothing checks `league_daily`.

### Root cause 2 — the crawl universe flaps on poe2scout's noisy spot price

`_universe` picks items by `CurrentPrice >= 5 ex` **at the moment of the pass**. That spot price is noisy:
the 02:46 stragglers include items whose daily close is 0.2–1 ex (Greater Essence of the Mind, Mind Rune)
and items worth 55–373 ex (Soul Core of Puhuarte, Uromoti's Soul Core of Attenuation) that were missing
from the 21:14 pass. The same flapping is what freezes histories (Gap B): an item that drops out is never
re-pulled. Items re-entering the universe are also exactly the ones a restart pass fetches (stale stamp).

### Root cause 3 — poe2scout's latest day is never final, and right now it is stalled

- The current day is inherently partial. And today poe2scout's 09-28 candle stopped growing: Divine
  volume was 4.30M when fetched at 16:40 UTC 09-28 and still 4.30M at 01:48 UTC 09-29 (a full day is
  ~22M); Fracturing Orb 8.7k vs ~60k; no 09-29 row exists yet. Either an upstream stall or a long
  aggregation lag — either way, **a day's candle cannot be trusted by the clock alone**.
- Consequence: shazam's live 09-28 (516 items) is complete in coverage but every candle is ~4 hours of
  trading.

### Ruled out — pagination (Cause C)

The largest category is runes, 142 items; every category returns `Pages: 1`. The response carries
`Pages`/`Total`, so a guard is one line.

### What the partial seed does and does not do to clients

- It does **not** trigger a T0 or a seed replace: `crawl_verdict` counts stored history per item, which
  the seed has.
- Clients re-pull every current-league item every 12h **by design** (~550 items × 2 leagues, each a
  500-day `DailyStatsHistory`), seed or no seed. The seed's stamps only decide when the first pass
  runs. So the steady-state crawl, not the seed, is most of the load on poe2scout. Each pass re-downloads
  500 days to learn about ~2.
- beta.11 bundles this seed; a stable 0.3.6 built today would too.

### Found on the way — the category listing already carries 7 days of prices

`/Currencies/ByCategory` returns, per item, `PriceLogs`: the last 7 daily prices + quantities (slot 0 =
today, `null`). The 17 category calls per pass therefore already hold a week of prices for every item
in the league. Not a drop-in replacement (Price/Quantity are not league_daily's Close/Average/Volume), but
worth measuring as a batch source or a completeness check.

## What was built (2026-09-29)

- `backend/app/seedready.py`: the per-item check (`assess`) and the hourly poll (`poll`), which
  fetches only items holding a league back and records `seed_cut:<league>`. Runs only where
  `ARBITER_SEED_POLL=1` (`docker-compose.yml`, the server); `main._seed_poll_loop`.
- `leaguehistory`: `category_items` follows `Pages` (step 5); `fetch_item` is the one item fetch
  (crawl + poll) and removes rows poe2scout withdrew; the crawl keeps every item a current league
  already holds, below the floor too (step 3). Dead `_currency_item_ids` removed.
- Exporter: ships each current league through its `seed_cut` only, refuses a league with none,
  writes `<seed>.cut`, `--only-if-newer` for hourly runs; `seed_fp:*` never ships.
- Publisher: hourly cron (`17 * * * *`), first run of the UTC day always publishes, later runs only a
  newer verified day, mod pools once a day, publish recorded only after the upload succeeds.
- Clients: `[seed] current leagues: …` line and T0 `seed-partial` if a seed breaks the promise (step 6).
- Tests: `test_seedready.py` (pure rules), `test_seedready_sim.py` (19 scenarios over real HTTP against
  `tests/fake_poe2scout.py`), exporter/publisher/T0/loop tests; every safeguard mutation-checked.
- **Real-data dry run** (read-only, owner's DB copy vs live poe2scout, 2026-09-29 02:00 UTC): poe2scout
  finished through 09-27 (09-28 stalled, correctly not final). All 1,086 items fetched after 09-27
  closed match the listing on every final day (no false positives). 61 (FR) / 85 (Runes) items
  held back, each a real partial or frozen row: fetched before 09-27 closed, then dropped from the
  crawl by the price floor. The first poll would fetch those ~146 items once.

## Code review (2026-09-29, /code-review high) and fixes

Ten findings; nine fixed test-first (each mutation-checked), one is a design question for the owner.

| # | Finding | Fix |
|---|---|---|
| 1 | Nothing sets `ARBITER_SEED_POLL` in production; syncing the new exporter first would fail every hourly publish | By design until promotion (the switch lives in the test env only). Promotion order below. |
| 2 | Seed shipped `lh_fetch` stamps newer than the rows it kept: clients lose their own newer rows on a seed replace and skip refetching 12h | Exporter clamps each cut league's stamps to the end of the cut day; a league with no verified day ships none |
| 3 | The poll holding the crawl lock made the 12h crawl return "skipped" and sleep 12h | The crawl loop retries after `CRAWL_RETRY_S` (120 s) when skipped |
| 4 | An empty-but-200 listing wrote `cut=None` and the exporter dropped the whole league | A listing with no finished day keeps the last cut (an error), unless the league never had one |
| 5 | One failed item fetch pulled the whole league's cut back up to a week; a 404 would do it forever | A 404 is "confirmed gone" (vouched, not retried); a failed fetch never lowers the cut that hour |
| 6 | Exporter trusted any `seed_cut` of any age, and the crawl's `lh_current` | The poll writes `seed_poll {at, leagues}`; the exporter refuses a poll older than 3h and cuts only the poll's leagues (clients' T0 check too) |
| 7 | Any non-raising fetch vouched the item, even an empty answer | Only a fetch that returned rows (or a 404) vouches; an unvouched item holds the cut but is not re-fetched until poe2scout changes it (`to_fetch`) |
| 8 | "poe2scout moved past D" is a majority rule | Kept, on evidence (owner: "do what is best for the system as a whole and maintain data integrity"), and now watched — see below |
| 9 | The sticky universe also applied to the quick anchors-only pull | Sticky only on full crawls |
| 10 | The fingerprint hashed the rolling 7-day window, so it broke daily | Fingerprint is per day; a day that slid out of the window is not a change |

### Finding 8: how "poe2scout finished day D" is judged

Two stricter per-item rules were built and measured on the live listing (2026-09-29, 09-28 stalled at
~19% posted), then rejected:
- *Every item that traded every day this week must show D+1*: 15 (Forbidden Rites) / 76 (Runes) such
  items had no 09-28 row. They trade ~10 units a day against ~1,000 for the rest, and their 09-27
  volume was 1.1–1.4× their usual, so their 09-27 rows were complete. It would have held the seed at
  09-26.
- *A missing D+1 row counts only when the item should almost surely have traded (Poisson, P < 1%)*:
  poe2scout's Quantity counts units, not trades, and thin items drop out daily, so it held Runes at
  09-23.

The evidence says poe2scout finishes a day for every item at once: its 09-28 stall stopped every item at
the same hour, and all 1,086 items fetched after 09-27 closed still matched the listing hours later. So
the league-wide judgement stays, and each item's own row must still match poe2scout exactly. The
assumption is watched, not trusted: `changed_after_final` counts items fetched more than a full day after
a day ended whose row for it no longer matches (poe2scout changed a finished day). The poll logs it and
records it in `seed_cut:<league>.revised`. The live count is 0; if it ever is not, the rule is too early.

### Rollout (2026-09-29)

- Test env on shazam (`/home/shazam/seedtest`, a copy of production's DB, archiving instead of uploading) ran
  beside production; `ops/seedtest-scenarios.py` passed 25/25 against real poe2scout on the final code.
- Promoted in the order below; first production seed v1790659367 (both leagues through 09-27, complete).
- 0.3.6-beta.12: Mac + Windows replaced the seed cleanly, carried their own newer crawl (1,086 / 1,089
  items), no T0; Windows' first crawl fetched only the ~110 formerly frozen items per league.
- Stable desktop-v0.3.6 published. Test env removed (cron line + container; files left in
  `/home/shazam/seedtest`). Still to observe live: poe2scout finishing 09-28 and the seed advancing to it.

### Promotion order (production)

1. Deploy the backend with `ARBITER_SEED_POLL: "1"` in `docker-compose.yml` (web deploy) and wait for the
   first poll: `seed_poll` and `seed_cut:<league>` present in production's kv_ops.
2. Only then `./ops/deploy-web.sh ops` (the new exporter/publisher). Syncing it before step 1 makes every
   publish fail loudly (no `seed_poll`).
3. Change root's crontab line from `17 4 * * *` to `17 * * * *`; run the publisher once by hand and confirm
   the `market-seed-latest` version advances.
4. Remove the test env: `sudo /home/shazam/seedtest/bin/cron-remove.sh`, `docker compose -p poe2-seedtest down`.

Not built: step 2 (fixed crawl schedule; the hourly poll makes it unnecessary for the seed) and step 4
(smaller requests; a separate hygiene change).

## Fix plan

Owner, 2026-09-29: **never skip a publish** — yesterday's seed is worse than a partial one. The
publisher retries until the seed is complete; it does not give up and keep the old seed.

1. **Publish every day; upgrade to a complete seed as soon as poe2scout allows.** Completeness is judged
   **per item, for every tracked item** (owner, 2026-09-29: no proxies, no "most items" thresholds, no
   corners cut). For each current league, day D is complete for an item when:
   - we hold its row for D;
   - that row was fetched after poe2scout had **moved past D** in that league, i.e. poe2scout already
     reports D+1 data there (a stalled D, like 09-28, is not final however late we fetch it);
   - the row matches what poe2scout now reports for that item and day.

   The seed's newest day for a league is the latest D that is complete for **every** tracked item. Today's
   unfinished day is never shipped.
   - Every day the publisher publishes: with the newest day if every item passes, otherwise with each
     league cut at its last day that every item passes (a fresh seed, never a half-finished day).
   - If it had to cut, it **polls once an hour** (owner, 2026-09-29: retry slowly, never spam poe2scout),
     at :05 (it first slept an hour after each poll, drifted a minute an hour, and by 15:00 finished
     after the :17 publish, which then shipped an answer nearly an hour old; fixed 2026-09-29),
     working from what we already store: each item's rows and when each was last fetched. The category
     listing we already call (17 requests per league) carries every item's last 7 daily prices and
     quantities, which shows per item whether poe2scout has moved past D and whether it now differs from
     our row. Only the items still missing or out of date are re-fetched. While poe2scout is stuck,
     nothing changes, so a poll costs the listing calls and zero item fetches.
   - When every item passes, it republishes. Polling stops then or when the next daily run starts. Every
     attempt is logged in `poe2-snapshot.log`, naming the items still missing per league.
2. **Couple the export to a finished pass.** `backfill` writes one `lh_pass` kv at the end
   (`{started, ended, leagues, items, errors}`); the server's crawl runs at fixed UTC times (e.g. 00:45
   and 12:45, after the day closes) instead of "12h after the last one", so restarts stop shifting it;
   the cron exports after the morning pass, and the exporter refuses a pass that is older than a few hours or
   had errors.
3. **Sticky universe for current leagues.** Universe = items at ≥ 5 ex now ∪ items this league has
   already crawled. Stops the flapping and the frozen histories; the floor only gates new items.
4. **Smaller requests (hygiene).** For an item with stored history, ask for
   `dayCount = days since its last stored day + 2` instead of 500. Same number of requests, far smaller
   responses. Later: measure whether `PriceLogs` can replace per-item calls for current leagues.
5. **Pagination guard.** Follow `Pages` when it is > 1.
6. **Telemetry + T0.** The `[seed]` line reports each current league's last-day coverage; a T0 kind
   `seed-partial` fires if any tracked item lacks a row for the seed's newest day, so a partial seed blocks stable by the existing gate.
7. **Then:** republish the seed (via `sshshazambom sudo`, confirm the version advances), rebuild the beta
   with it, and re-measure Hold (`hold-backtest`, `hold-diagnostics`) once sub-floor items are in the history.

Any fix touches the market side: re-run `ops/publish-market-snapshot.sh` on shazam (via `sshshazambom sudo`)
and confirm the `market-seed-latest` version advances (CLAUDE.md, "Database: user data vs market data").
