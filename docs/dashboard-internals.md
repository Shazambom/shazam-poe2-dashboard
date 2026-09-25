# Dashboard internals (the original README: loop scoring, rate limiting, data sources)

Self-hosted dashboard that pulls Path of Exile 2 Currency Exchange data, searches for
profitable trade loops (including off-exchange disenchant/combine steps), sizes them to
the currency you hold, and ranks them by margin, value, gold cost and gold efficiency.

## Run

```
cp .env.example .env      # set LEAGUE and USER_AGENT (no credentials go here)
docker compose up -d --build
```

Open `http://<server>:8080`. The API is on `:8000` (`/docs` has the OpenAPI UI).
State lives in `./data` (SQLite, `recipes.json`, `secret.key`), so it survives rebuilds.

## Connecting your account

Credentials are never read from `.env`. They're stored Fernet-encrypted in the database
with a key generated on first run at `data/secret.key` (mode 600). Back up `data/` as a
unit; without the key the stored tokens are unreadable.

### Trade session (needed for the live order book)

The exchange endpoint is not part of GGG's OAuth API — it only accepts the website's
session cookie, and that cookie is HttpOnly, so page script can't read it. Two ways in:

1. On the PC where your browser is logged in to pathofexile.com:
   ```
   pip install browser-cookie3
   python tools/connect.py --server http://<server>:8080 session
   ```
   It reads `POESESSID` from Chrome/Firefox/Edge/Brave/Opera, sends it to the dashboard,
   which verifies it with one exchange query and stores it encrypted.
2. Or paste it in Settings → Trade session (devtools → Application/Storage → Cookies).

Logging out of the website invalidates the cookie; reconnect afterwards. Disconnect from
Settings wipes it.

### OAuth login (account features)

Register a client with GGG following the "Getting Started" section of
<https://www.pathofexile.com/developer/docs/index> (it's an email request). For a
self-hosted dashboard ask for a **public client** with redirect URI
`http://127.0.0.1:8080/callback` and scopes `account:profile account:characters`
(public clients can't use `service:*` scopes and get 10-hour tokens with 7-day
refresh). Put the client id in `.env` as `OAUTH_CLIENT_ID` and restart.

Then either:

- Open the dashboard at exactly `http://127.0.0.1:8080` (same machine, or
  `ssh -L 8080:localhost:8080 server`) and press "Log in with Path of Exile" — GGG
  redirects to `/callback`, which nginx forwards to the backend; or
- From any PC on the LAN: `python tools/connect.py --server http://<server>:8080 oauth`.
  It opens the consent page, catches the redirect on its own 127.0.0.1:8080, and posts
  the code to the dashboard, which finishes the PKCE exchange. Codes expire in 30 s, so
  it does this immediately.

If you own an HTTPS domain, set `OAUTH_CLIENT_SECRET` and an HTTPS `OAUTH_REDIRECT_URI`
to run as a confidential client (28-day tokens). Tokens refresh automatically; the
top bar shows the logged-in account.

## Data sources

| Source | What it gives | Cadence |
|---|---|---|
| GGG hourly digest (`web.poecdn.com/api/currency-exchange/poe2`) | Executed trade volume, stock and ratio range per market pair, per hour. Rate is derived as volume(B)/volume(A) — the cleared VWAP. | Backfills `DIGEST_BACKFILL_HOURS`, then polls each hour boundary. Always at least one hour behind. |
| Live order book (`pathofexile.com/api/trade2/exchange/<league>`) | Current sell ladder for every ordered pair in the watchlist, with stock and whisper. Needs a connected trade session. | Paced by GGG's rate-limit headers, full sweep every `ORDERBOOK_SWEEP_SECONDS`. Backs off on 429. |
| Recipes (`data/recipes.json`, editable in the UI) | Disenchant / combine / reforge conversions. No gold. | Static |

Live quotes win; digest fills gaps when enabled; a recipe is used only where it beats the exchange.

## Rate limiting and caching

Every outbound request goes through `backend/app/gateway.py`, one place with a
[pyrate-limiter](https://github.com/vutran1710/PyrateLimiter) policy per host:

| Policy | Hosts | Starting budget | Adapts? |
|---|---|---|---|
| `trade` | www.pathofexile.com (exchange, static data) | 1 per 6 s, 8 per min | yes |
| `ggg-api` | api.pathofexile.com (OAuth) | 1 per 2 s, 20 per min | yes |
| `digest` | web.poecdn.com | 1 per 2 s, 20 per min | no headers |
| `static` | ggpk.exposed, GitHub | 1 per s, 30 per min | no |

After every response the policy re-derives its rates from GGG's `X-Rate-Limit-*`
headers at **half** the advertised limit for each window, holds when a window's state
is over 80 % spent, and on a 429 boxes the whole policy for `Retry-After` + 1 s. The
readout in the Routes rail shows the current budget, penalty countdown, and queue.

The order book is never swept on a timer by default. Fetches happen only through a
priority queue, one request at a time, **batched by `want`**: every pending pair that
wants the same currency goes out as one request with `have=[X1, X2, …]` (up to 12),
the way Exiled Exchange 2's bulk price check does it. The ~100-listing response is
split back into per-pair ladders by `offers[].exchange.currency`; if `total` exceeds
the cap and a pair came back with fewer than 3 offers, that pair alone is re-queried
once. Five loops over chaos/exalted/divine therefore cost about three requests, not
nine. The exchange URL is tried with the `poe2/` realm segment first (as the currency
overlay does) and falls back to the bare league id (as EE2 does) on 404.

**Padding.** A request for `want=W` carries the requested haves first, then fills its
spare slots (up to `batch_max_have`, default 12) with other haves for W, skipping any
cached within `min_refetch_s`. Slot order is: pairs that keep appearing in the
best loops (a persisted score built from each route ranking — every profitable loop
credits its pairs by rank on margin and on margin/1k gold, with decay), then the
haves the market actually trades into W most (digest volume, last 7 days), then the
watchlist. Padded pairs are best-effort: stored if they got listings, never re-queried.
The same score orders the queue inside each priority tier, so the pairs behind the
best loops go out first.

**Caching.** Same pair never refetched within 5 minutes unless forced; route results
served from memory for 5 minutes (invalidated the moment a new book lands).

Queue priorities:

0. **Refresh this loop** — forces every exchange pair in one displayed loop (5 s floor per pair).
1. **Refresh top N** — after routes are displayed, only the pairs behind the top N loops,
   and only those older than `live_min_age_s`. Optional every-2-minutes auto mode.
2. Background watchlist sweep — off unless `background_sweep` is enabled in Settings.

Books persist in SQLite (`orderbook`); digest hours and game-data tables are cached
on disk. The dashboard's own polling therefore costs GGG nothing.

## How a loop is scored

For each currency you hold, the engine enumerates simple cycles up to `max_steps`,
sizes the start amount to `capital × max_start_fraction` capped by liquidity along the
path, then simulates the fills step by step with whole-unit rounding.

- **Margin** — units gained in the start currency (and as % of what you committed)
- **Margin in ref** — that gain valued in the reference currency (default Exalted)
- **Value in ref** — total value that passes through the loop
- **Gold** — modelled exchange fees; recipe steps are free
- **Margin / 1k gold** — gold efficiency; gold-free loops rank first
- **Liquidity** — the thinnest step's capacity, in ref (what you can trade right now)
- **Volume / h** — the slowest step's executed value per hour, from the hourly digest
  over `volume_window_h` (default 24 h, quiet hours count as zero). This is the fill-speed signal.
- **Fill est.** — sum over exchange steps of commit ÷ hourly turnover; recipe steps are instant
- **Age** — oldest quote in the loop

- **Velocity** — the lead metric: `margin_ref ÷ (fill_hours × gold) × 1000`, profit per hour
  per 1k gold. Fill hours include `step_overhead_min` (default 2) per exchange step so a
  loop can never claim a zero-time fill; gold-free loops show ∞; loops with no turnover data
  show – and sort last.

The default sort, **Overall**, is a rank-normalised blend led by velocity:
`0.5 × velocity rank + 0.2 × efficiency rank + 0.2 × value rank + 0.1 × volume rank`
(weights in Settings). "Velocity" alone is also available as a sort. Filters include minimum
velocity, minimum volume/h and maximum estimated fill time. The pair-priority learner
weights the velocity leaderboard double, so the queue front-loads the pairs behind the
fastest-earning loops.

Expanding a loop shows each step's best offer and whisper, plus "Refresh this loop".

Filters (min margin %, min margin, max gold, min margin/1k gold, min liquidity, live-only,
exchange-only) and sort live in the left rail; defaults are stored in Settings.

## Gold fees

The fee is a fixed gold amount per unit, stored in the game's own data:
`Data/CurrencyExchange.datc64`, column `GoldPurchaseFee`, keyed by `BaseItemTypes`.
On startup (and daily) the backend downloads that table plus `BaseItemTypes` and
`CurrencyExchangeCategories` from ggpk.exposed, parses them with the poe-tool-dev
schema, and stores `{metadata_id: fee}`. Fees are linked to trade ids through the same
currency map the digest uses, so anything unmapped shows up in Settings.

`fee(step) = base_per_order + fee[currency] × units`, where `currency` is what you
receive (`fee_side: buy`, the default) or what you give (`sell`). One real order in
game confirms which side; manual overrides in `gold_model.per_unit` win over the table,
and `per_ref_unit × value` is the fallback for items the table doesn't cover.
"Refresh from game data" in Settings forces a re-download after a patch.

## Recipes

Only single-input, single-output recipes are routable (`3 X -> 1 Y` is fine; `X + Y -> Z`
is stored but skipped). Templates ship disabled with placeholder ids; fill in trade ids
from the currency list, confirm the ratio in game, enable, save.

## Currency ids

The digest uses GGG metadata paths, the exchange uses short trade ids. `backend/data/currency_map.json`
seeds the link, the icon filename heuristic catches most of the rest, and anything still
unmapped shows up in Settings for a one-click link.

## Notes

- The trade2 exchange endpoint is undocumented and rate limited. The watchlist is
  `n(n-1)` requests per sweep; keep it small and the gap generous. The session cookie
  is a login credential — the container only ever sends it to pathofexile.com.
- `DIGEST_BACKFILL_HOURS=168` is one week; the first sync makes one request per hour
  of history at ~1/s.
- Outbound hosts the backend needs: `web.poecdn.com`, `www.pathofexile.com`,
  `ggpk.exposed`, `github.com` (schema download).
- Development: `cd backend && DATA_DIR=./data uvicorn app.main:app --reload` and
  `cd frontend && npm install && npm run dev` (Vite proxies `/api`).
