# PoE2 exchange-loop dashboard

Self-hosted dashboard for Path of Exile 2 currency trading. It pulls Currency Exchange
data, finds profitable trade loops (including gold-free disenchant/combine steps), sizes
them to the currency you actually hold, and ranks them by how fast they earn per gold
spent. Python backend, React frontend, runs on a home server with Docker Compose.

This README is the project map: what exists, where it lives, how it fits together, and
how to keep building on it.

---

## 1. Quick start

```
cp .env.example .env          # set LEAGUE and USER_AGENT; no credentials go in here
docker compose up -d --build
```

- Dashboard: `http://<server>:8080`
- API: `http://<server>:8000` (`/docs` is the OpenAPI UI)
- State: `./data/` (SQLite, `recipes.json`, `secret.key`, cached game data). Back it up as a unit.

Then, in the dashboard: Settings → connect a trade session (see §5), enter what you hold
in Capital, and the Routes tab starts ranking loops.

Development without Docker:

```
cd backend  && pip install -r requirements.txt && DATA_DIR=./data uvicorn app.main:app --reload
cd frontend && npm install && npm run dev      # Vite on :5173, proxies /api and /callback to :8000
```

---

## 2. Project map

```
poe2-arb/
├── docker-compose.yml        backend (:8000) + frontend/nginx (:8080), ./data mounted at /data
├── .env.example              LEAGUE, USER_AGENT, poll intervals, OAuth client id (no secrets)
├── data/                     runtime state (git-ignored): poe2arb.sqlite, recipes.json,
│                             secret.key, gamedata/ cache
├── tools/
│   └── connect.py            desktop helper: lifts POESESSID from your browser, relays OAuth
├── backend/
│   ├── Dockerfile, requirements.txt
│   ├── data/
│   │   ├── currency_map.json seed links: GGG metadata ids ↔ trade-site ids
│   │   └── recipes.json      seed off-exchange recipes (templates ship disabled)
│   └── app/
│       ├── main.py           FastAPI app, all routes, background tasks (lifespan)
│       ├── config.py         env → constants (paths, URLs, intervals)
│       ├── settings.py       user settings with defaults, stored in kv; deep-merge on save
│       ├── db.py             SQLite schema + tx() helper + kv/capital helpers
│       ├── gateway.py        THE ONLY HTTP EXIT: pyrate-limiter policies per host, adapted
│       │                     from GGG X-Rate-Limit headers; 429 penalty box
│       ├── digest.py         GGG hourly Currency Exchange digest ingest + queries
│       │                     (latest rates, pair history, executed volume, partners)
│       ├── orderbook.py      live exchange books: priority fetch queue, batching by want,
│       │                     padding, starvation follow-up, SQLite cache, league list
│       ├── pairscore.py      which pairs matter: learned from route rankings, persisted
│       ├── arbitrage.py      graph build, cycle search, fill simulation, gold, velocity,
│       │                     composite score, filters, route cache
│       ├── recipes.py        recipes.json load/save → routable edges
│       ├── currencies.py     registry of trade ids/names/icons; metadata-id resolution
│       ├── gamedata.py       parses CurrencyExchange.datc64 from ggpk.exposed → gold fees
│       ├── session.py        trade-site cookie: connect/validate/disconnect (encrypted)
│       ├── oauth.py          OAuth 2.1 PKCE against pathofexile.com; token refresh; API get
│       └── secrets.py        Fernet store keyed by data/secret.key
└── frontend/
    ├── Dockerfile, nginx.conf (proxies /api and /callback to backend), vite.config.js
    └── src/
        ├── App.jsx           top bar (feed health, capital, account) + tab switch
        ├── styles.css        design tokens; dark slate, gold = the fee currency
        ├── lib/api.js        fetch wrappers for every endpoint + number/age formatters
        └── components/
            ├── RoutesView.jsx    filters rail, live-refresh controls, ranked loop table,
            │                     expandable step detail, per-loop refresh
            ├── MarketView.jsx    pair history chart, busiest markets, edge table
            ├── CapitalView.jsx   manual stash entry (chaos/exalted/divine pinned)
            ├── RecipesView.jsx   recipe editor
            ├── SettingsView.jsx  league, watchlist, ranking weights, fetch policy,
            │                     gold fees, unmapped ids
            └── AccountsPanel.jsx trade session + OAuth login (inside Settings)
```

---

## 3. Architecture and data flow

```
GGG hourly digest ──(digest.py, policy "digest")──▶ digest_markets ─┐
trade2 exchange  ──(orderbook.py queue, policy "trade")──▶ orderbook ┼─▶ arbitrage.Graph
recipes.json     ──(recipes.py)────────────────────────────────────┘        │
game data files  ──(gamedata.py, policy "static")──▶ gold fee table ────────┤
capital (manual) ──────────────────────────────────────────────────────────┤
                                                                            ▼
                                     find_routes(): cycles → size → simulate → score → filter
                                                    │                       │
                                                    ▼                       ▼
                                        pairscore.observe()          /api/routes (cached)
                                                    │
                                                    ▼
                                 queue ordering + batch padding priority
```

Everything outbound goes through `gateway.request()`. Nothing else imports httpx for
network calls. If you add a new external source, add a policy in `gateway.POLICIES` and
route through it.

Background tasks (started in `main.lifespan`):
`digest.run_forever`, `orderbook.worker` (drains the queue), `orderbook.sweeper`
(no-op unless `background_sweep`), `_gold_fee_loop` (daily).

### Storage (SQLite, `db.py`)

| Table | Contents |
|---|---|
| `digest_markets` | one row per (hour, league, market): volumes, stock and ratio ranges |
| `orderbook` | latest ladder per (league, have, want), JSON offers, fetched_at |
| `orderbook_history` | best rate/stock/depth per fetch, for charts |
| `capital` | currency → quantity you hold |
| `kv` | settings, digest cursor, currency overrides, gold fee table, pair scores, encrypted secrets, league list |

Recipes live in `data/recipes.json` (editable in the UI), not in SQLite.

---

## 4. Data sources

| Source | Gives | Auth | Notes |
|---|---|---|---|
| `web.poecdn.com/api/currency-exchange/poe2/<hour>` | executed volume, stock and ratio range per pair per hour, all leagues | none | public, ≥1 h behind; rate derived as vol(B)/vol(A) = cleared VWAP |
| `www.pathofexile.com/api/trade2/exchange/poe2/<league>` | live sell ladders with stock and whisper | POESESSID | undocumented; URL tried with `poe2/` first, bare league id on 404 |
| `www.pathofexile.com/api/trade2/data/{static,leagues}` | currency ids/names/icons, league ids | none | cached |
| `ggpk.exposed/poe2/data/*.datc64` + poe-tool-dev schema | `GoldPurchaseFee` per item | none | parsed by `gamedata.py`; refreshed when patch version changes |
| `api.pathofexile.com` (OAuth) | profile, `character/poe2` | OAuth token | first consumers only; stashes are PoE1-only |
| `data/recipes.json` | disenchant/combine/reforge edges, gold-free | — | user-maintained |

Precedence in the graph: live book > digest VWAP (if enabled) > recipe (only where it beats the exchange).

---

## 5. Credentials

Nothing secret is read from `.env`. Secrets are Fernet-encrypted (`secrets.py`) with a
key generated on first run at `data/secret.key` (mode 600).

**Trade session** (required for live books). The exchange endpoint only accepts the
website's HttpOnly cookie, so it comes from your browser:

- `pip install browser-cookie3 && python tools/connect.py --server http://<server>:8080 session`
  on the PC where you're logged in, or
- paste it in Settings → Trade session (devtools → Cookies → `POESESSID`).

The server verifies it with one exchange query, stores it, and starts using it. Logging
out of the website invalidates it. `POESESSID` in `.env` still works as a legacy fallback.

**OAuth** (optional; for account features). Register a public client with GGG
(developer docs → Getting Started; it's an email), redirect `http://127.0.0.1:8080/callback`,
scopes `account:profile account:characters`. Put `OAUTH_CLIENT_ID` in `.env`. Log in
either by opening the dashboard at exactly `127.0.0.1:8080` (same machine or SSH tunnel)
and pressing the button, or from any LAN PC with `tools/connect.py … oauth`, which catches
the redirect locally and posts the code back. Tokens refresh automatically.

---

## 6. How loops are found and scored (`arbitrage.py`)

1. **Graph**: nodes = currencies; directed edges = live ladder, digest VWAP, or recipe.
   Each edge carries rate, ladder/stock, age, kind, and executed volume per hour (digest).
2. **Cycles**: DFS from every currency you hold, simple cycles up to `max_steps` (default 3).
3. **Sizing**: `min(capital × max_start_fraction, liquidity along the path)`, floored.
4. **Simulation**: walk the ladder step by step, whole-unit rounding, recipe lot sizes,
   gold fee per exchange step, fill-time per step = commit ÷ hourly turnover + `step_overhead_min`.
5. **Metrics per route**: `margin`, `margin_pct`, `margin_ref`, `value_ref`, `gold`,
   `margin_per_1k_gold`, `liquidity_ref`, `volume_ref_per_h`, `fill_hours`,
   `velocity` (= `margin_ref ÷ (fill_hours × gold) × 1000`, the lead metric), `max_age_s`,
   `all_live`, `uses_recipe`, `pairs` (exchange pairs only), `id`.
6. **Score**: rank-normalised blend, default `0.5 velocity + 0.2 efficiency + 0.2 value + 0.1 volume`
   (`rank_weights` in settings). Filters and sort come from the request or `settings.filters`.
7. **Cache**: identical queries served from memory for `routes_cache_s`; invalidated by
   `orderbook.state["version"]` whenever a new book lands.
8. **Side effect**: `pairscore.observe(all candidates)` — the learner.

Route ids look like `chaos>exalted|exalted>divine:r|divine>chaos` (`:r` marks a recipe hop).

---

## 7. Fetch policy (`gateway.py`, `orderbook.py`)

**Rate limits.** pyrate-limiter policies per host: `trade`, `ggg-api`, `digest`, `static`.
Each re-derives its windows from GGG's `X-Rate-Limit-*` headers at half the advertised
limit, holds when a window is >80 % spent, and boxes itself for `Retry-After`+1 s on 429.
`/api/ratelimits` and the Routes rail show budget, penalty countdown, queue, in-flight.

**Queue.** Nothing is fetched on a timer by default. Priorities:
0 = "Refresh this loop" (forced, 5 s floor per pair);
1 = "Refresh top N" (only pairs behind the top N displayed loops, only if older than `live_min_age_s`);
2 = background watchlist sweep (off unless `background_sweep`).
Within a tier, pairs are ordered by `pairscore`.

**Batching.** A request is `want=[W], have=[…]`: every pending pair for W rides along
(up to `batch_max_have`, default 12). The ~100-listing response is split back per pair.
Requested pairs starved by the cap are re-queried alone, once (`_solo`). Spare slots are
**padded** (if `batch_pad`) in this order: highest pair score → most-traded partners
(digest, 7 days) → watchlist; anything cached within `min_refetch_s` is skipped. Padded
pairs are best-effort and never followed up.

**Caching.** Same pair not refetched within `min_refetch_s` (300 s) unless forced; books
persist in SQLite; route results cached 300 s; digest and game data on disk.

---

## 8. API reference

| Method + path | Purpose |
|---|---|
| `GET /api/status` | feeds, session, oauth, rate limits, registry state |
| `GET /api/currencies` · `POST /api/currencies/map` | registry; link a metadata id to a trade id |
| `GET/PUT /api/capital` | what you hold, valued in ref |
| `GET/PUT /api/settings` | settings (PUT takes `{patch}`; deep-merged) |
| `GET/PUT /api/recipes` | recipe list |
| `GET/POST/DELETE /api/session` | trade session status / connect / disconnect |
| `GET /api/oauth/status` · `POST /api/oauth/start` · `POST /api/oauth/complete` · `GET /callback` · `POST /api/oauth/logout` | OAuth flow |
| `GET /api/account/profile` · `GET /api/account/characters` | first OAuth consumers |
| `GET /api/goldfees` · `POST /api/goldfees/refresh` | fee table from game data |
| `GET /api/market/edges` · `/top` · `/history?a&b` · `POST /api/market/refresh` | graph edges, busiest markets, pair series, low-priority watchlist queue |
| `GET /api/leagues` | league ids from the trade site |
| `GET /api/ratelimits` | policies, queue, top pair scores |
| `POST /api/digest/sync` | force a digest pass |
| `GET /api/routes?…` | ranked loops (query params = filters + sort + start) |
| `POST /api/routes/refresh-top` | live-refresh pairs behind the top N, recompute |
| `POST /api/routes/refresh` | force-refresh one loop's pairs (`{id, pairs, filters}`) |

---

## 9. Settings reference (`settings.py` DEFAULTS)

`league`, `reference` (valuation currency), `watchlist`, `extra_pairs`,
`gold_model` {`base_per_order`, `per_unit` overrides, `per_ref_unit` fallback, `fee_side`},
`max_steps`, `max_start_fraction`, `live_max_age_s`, `digest_max_age_h`,
`allow_digest_edges`, `allow_recipe_edges`,
`live_top_n`, `live_min_age_s`, `min_refetch_s`, `routes_cache_s`, `background_sweep`,
`batch_pad`, `batch_max_have`,
`rank_weights`, `volume_window_h`, `step_overhead_min`,
`filters` (defaults for the Routes rail).

---

## 10. Things to verify on the first real run

The sandbox this was built in cannot reach GGG, ggpk.exposed, or github.io, so these
were tested against synthetic data or the schema only:

- **Exchange request/response shape** follows EE2 and the overlay; if the first fetch
  errors, the top bar and `/api/status → orderbook.last_error` show why. Parser: `orderbook._parse_offers`.
- **Exchange URL form**: `poe2/<league>` first, bare `<league>` on 404 (`state.url_form`).
- **Gold fee side**: `GoldPurchaseFee` is assumed per unit *received*. Compare one real
  order's fee with the Settings table; flip `fee_side` if it matches the given side instead.
- **datc64 row width**: `gamedata.py` logs a warning if the file's row width differs from
  the schema's 56 bytes. If so, offsets need adjusting.
- **Digest ratio semantics**: rates use volume ratios; `lowest_ratio`/`highest_ratio` are stored raw and unused.
- **Cloudflare**: server-side session calls to pathofexile.com can be challenged. The
  overlay project reports this on some paths. If you see HTML instead of JSON, that's it.

---

## 11. Conventions for continuing work

- **Network**: only via `gateway.request(..., policy=...)`. Add a `Policy` for any new host.
- **Fetch queue**: to get live data for a set of pairs, call `orderbook.request_pairs(pairs, priority, force?, max_age_s?)`
  and `await orderbook.wait_for(futs, timeout)`; never call the exchange directly.
- **Settings**: add a default to `settings.DEFAULTS`, expose it in `SettingsView.jsx`,
  and include it in that view's `save()` patch. Unknown keys are preserved.
- **Secrets**: `secrets.store/load/clear(name)`. Never log them; never put them in `.env`.
- **Route metrics**: add to the dict in `arbitrage._find_routes`, to `keep()` if filterable,
  to `key()` if sortable, to `main.routes()` params, and to `RoutesView.jsx` (SORTS, columns).
- **Frontend**: plain CSS with tokens in `styles.css`; `fmt` helpers in `lib/api.js`;
  no localStorage; one component per tab.
- **Tests**: there is no test suite yet. Behaviour was verified with ad-hoc scripts
  against synthetic order books. A good first contribution is `backend/tests/` with
  fixtures for `_parse_offers`, `Dat` parsing, `find_routes` on a tiny graph, and the
  batching worker with a fake `_post`.

---

## 12. Decisions log

- Stash value is manual (Capital tab): OAuth stashes are PoE1-only, and workarounds were ruled out.
- Live book needs the session cookie: the exchange is outside OAuth. Cookie is stored encrypted, never in env.
- OAuth exists for future account features (profile/characters wired); public PKCE client, 127.0.0.1 redirect, helper relays for LAN.
- Gold fees come from game data, not a formula; the API doesn't expose them.
- Recipes are user-verified: unverified templates ship disabled.
- Order book is demand-driven and batched by `want` (EE2 pattern); no timer sweeps.
- Ranking lead metric is velocity = margin ÷ (fill time × gold); volume has a small weight.
- Trade-site search (tab library, watches, live hub) is **parked**: needs page hooks, and
  iframes can't be hooked cross-origin; extension/userscript/proxy routes were declined for now.
- Declined: build planner integration, loot-filter manager, stash workarounds.

## 13. Explored, not built

- **Crafting**: fork POE2-PathOfCrafting (MIT, FastAPI + React; has `/parse-item`,
  `/available-mods`, `/simulate`, `/probability`, `/estimate-cost`) as a Craft tab;
  paste an item → simulator pre-filled + poe2db deep links for base/affixes/essences.
- **poe2db portal**: search box → `poe2db.tw/us/<Item_Name>`; deep links from every currency/recipe.
- **Client.txt stream** via `tools/connect.py`: whispers, zones, XP/hour, deaths.
- **Ladder meta**: nightly crawl of the PoE2 ladder (1000 entries) + `character/poe2`.
- **Session ledger**: log executed loops, realized vs predicted margin, net worth.
- **Notifications**: Discord / ntfy webhooks for route and (later) trade alerts.
- **Backtester**: replay stored books and digest hours.
