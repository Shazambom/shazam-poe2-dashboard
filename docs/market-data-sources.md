# Market data sources — what is real, what is not

> Researched 2026-09-17 (GGG developer docs, PoE forums, community tools, our own data). This is
> the contract for where prices come from. **The hourly Currency Exchange digest is the SOLE source
> for prices, valuations and loops.**

## Two different markets — do not mix them

| | In-game **Currency Exchange** | Trade website **Bulk Item Exchange** |
|---|---|---|
| Where | In game (Faustus / the exchange NPC) | `pathofexile.com/trade2/exchange` |
| Mechanism | Automated **order book**: place an order, it matches by itself | **Whisper listings**: a player posts a ratio, you message them |
| Cost | **Gold fee** per trade (our `gold_model`) | Free, costs time |
| Do quotes fill? | Yes — what you see cleared for a real player | No guarantee: asks sit unanswered; bait and lowball listings are common |
| API | `GET https://web.poecdn.com/api/currency-exchange/poe2/<hour>` — public, no login | `POST /api/trade2/exchange/poe2/<league>` — needs the POESESSID session |
| What the API gives | **Hourly digests of EXECUTED trades** | Current standing listings, each with a `whisper` template |
| Arbiter | **`digest.py` → every price, valuation and loop** | **DEPRECATED** as a price source (`orderbook.BULK_EXCHANGE_ENABLED = False`) |

Everything Arbiter models — gold fees, fill time, "place an order and wait" maker loops — is the
in-game exchange. Pricing it with whisper listings from the other venue was the bug.

## Why the Bulk Item Exchange was deprecated (evidence, 2026-09-17)

- **Bait asks at the top of the book.** Omen of Light listed "for 1 exalted" (stock 4) while it traded
  at ~2,261. Cheapest-first sorting makes price-fixer listings the top of every ladder → +25,000% loops.
- **Lowball bids as the "sell" price.** Divine → exalted listings at 300/240/201/200 while divines
  traded at ~435–440; the other side asked 500. The Board showed Divine at 360 (true ~435), chaos at 60
  (true ~53), a 31% "spread" that was two venues glued together, and capital totals were valued off it.
- **One-offer books deleted real markets.** A single bait offer became the live edge for a pair,
  replaced its digest edge, then failed `min_edge_depth` → the pair vanished and real loops with it.
- **GGG's own cap drifted.** The endpoint began rejecting > 10 `have` per request
  (`"Too many items have items selected."`); every fetch 400'd until the cap was learned.
- The community asks GGG for exchange data for exactly this reason — trade-site listings are polluted
  by price-fixers ([forum thread 3805750](https://www.pathofexile.com/forum/view-thread/3805750); no GGG reply).

## What GGG exposes for the in-game exchange

`GET https://web.poecdn.com/api/currency-exchange[/<realm>][/<id>]` (realm `poe2`; `id` = unix hour).
Per GGG's [developer docs](https://www.pathofexile.com/developer/docs/reference):
- Public, no OAuth scope. Responses are **"purely historical"** — the **current hour is never
  available** — and there is a **5-minute delay**. Old history may be removed later.
- Per market (a currency pair) that traded in the hour: `volume_traded`, `lowest_stock` /
  `highest_stock`, `lowest_ratio` / `highest_ratio`, keyed by currency.
- **No documented endpoint exposes the live order book, current orders, or bid/ask.** The live
  ratios and available stock exist only in the game client. Reading them would mean screen-reading
  the game — a different, ToS-riskier kind of tool; not something Arbiter does.

### How we read the digest fields (`digest_markets`)

- **Rate = `vol_b / vol_a`** — the hour's volume-weighted EXECUTED price. This is the price.
- **`lo_ratio_*` / `hi_ratio_*` are the hour's extremes, NOT bid/ask.** One odd trade sets an extreme:
  divine/exalted showed a range of 193–495 around a VWAP of 487; across 400 traded markets the median
  range is 57% wide. Do not present them as a spread.
- **`lo_stock_*` / `hi_stock_*` = standing order stock during the hour.** This is how we know sellers
  exist: a digest edge a→b is only created when the RECEIVING side had standing stock
  (`digest.directed_rates`). Traded volume is never a stand-in for stock.
- **A true bid/ask spread for the in-game exchange is not obtainable from any API today.**

## How other tools cope (none has a live in-game spread)

- **poe.ninja** — PoE2 exchange overview, refreshed ~hourly from the same kind of data.
- **[vaal-street](https://github.com/Banomx/vaal-street)** — volume-weighted price from the latest
  COMPLETED hour; thin markets fall back to the prior 24 h; notes the feed never covers the current hour.
- **Exiled Tools "flip finder"** — poe.ninja data, hourly.

## Known limits of hourly data, and the rules that contain them

Thin markets are noisy: one fat-finger trade used to be "the rate" for up to `digest_max_age_h`.

**The rate itself is now the window, not the newest hour** (`digest.window_rates`, 2026-09-20). Each
market's hours over the last 48 are weighted by what they traded and halved every 12 hours. A quiet
market gets 13% of its hours with a single trade behind them, and `traded_bounds` is blind there —
one hour means `lo == hi`, which reads as a perfectly steady market. Measured against what each
market actually traded over the following 24 hours, this cut rates that miss by 2x from 5.2% of
active market-hours to 3.8%, and by 5x from 0.7% to 0.3%. A busy market is unmoved: its own recent
hours already carry nearly all the weight. Because the result is a weighted mediant of hours the
market really traded at, it can never leave the range they span — `tests/test_window_rates.py` holds
that over every market in the owner's DB.

The remaining guards, all in the route search:
- **Sellers must exist** (`digest.directed_rates`) — no standing stock on the receiving side, no edge.
- **Turnover relative to the trade** (`max_step_minutes`, default 45) — no step may need more than
  45 minutes of its own market's turnover.
- **Liquidity floor** (`min_liquidity_ref`, default 200 ex) and **value floor** (`min_volume_ref_per_h`).
- High margins are NOT capped: a +500% loop through a thin market is a real maker opportunity
  (place the order, wait) — the guards above qualify it, not the margin.
- Still open: pricing a thin pair THROUGH a liquid one (A↔hub × hub↔B) rather than directly. It is
  what poe.ninja does (`maxVolumeCurrency`: every currency quoted against its deepest counterpart)
  and what poe2scout does (base → bridge → everything else), and `Graph.ref_values()` already has
  the topology. Measurement was attempted 2026-09-20 and the results were not credible — treat it
  as unproven, not rejected.

## What is deprecated, and what still uses the trade-site session

Deprecated behind `orderbook.BULK_EXCHANGE_ENABLED = False` (code kept, tests pin its mechanics):
fetching/queueing exchange pairs, live edges in `Graph.build`, the "live" source on cards, the
ask/bid/spread/depth tiles, "Live quotes only", per-loop refresh, the exchange-batching settings, the
top-bar live-book status. The refresh buttons now simply reload hourly data.

Still in use (NOT deprecated): the pathofexile.com **session** itself — `orderbook.exchange_post` is its
validity probe — for the Trading tab's live item searches and the Sales ledger (Merchant History).
