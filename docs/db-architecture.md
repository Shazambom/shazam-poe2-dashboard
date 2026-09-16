# Database architecture — user data vs market data

> Status: **IMPLEMENTED** (2026-09-14). Backend split lives in `backend/app/db.py` +
> `backend/app/migrations_user.py`; seed export in `ops/export-market-snapshot.py`; build
> wiring in `desktop/`. Day-to-day rules: [`db-maintenance.md`](./db-maintenance.md). Historical
> build plan: [`db-split-handoff.md`](./db-split-handoff.md).
>
> One implementation note vs the design below: the seed ships **gzipped** with a `.version`
> sidecar (see maintenance doc), decompressed once by `seed_market()`. Everything else — two
> files, ATTACH, kv routing, catch-up watermarks, wholesale replace — matches this design.

## Why

Today everything lives in one SQLite file (`DATA_DIR/poe2arb.sqlite`): the user's
settings/capital/session **and** the huge, rebuildable market backfill. Two problems:

1. **Cold backfill is slow and per-user.** Every fresh desktop install crawls poe2scout
   for the full cross-league history — minutes of network work the user shouldn't wait for.
2. **We can't safely reset market data.** Blowing away the backfill to fix a data bug would
   also blow away the user's settings, session, and capital.

**Goal:** split the DB so that
- **User data always persists** and is migrated carefully across app versions (seamless — the
  user never re-enters settings, never loses capital, never re-logs-in on update).
- **Market/operational data is disposable** — it can be replaced wholesale at any time, with
  **no migration**, by dropping in a prebuilt snapshot. The expensive backfill happens **once
  at build time** and ships **inside the binary**, so users start with a full history instantly.

## The two databases

The single DB becomes **two SQLite files** in `DATA_DIR`:

| File | Contents | Lifecycle |
|---|---|---|
| `user.sqlite` | user data (below) | **Never overwritten.** Schema-migrated in place. Backed up before risky migrations. |
| `market.sqlite` | market/operational data (below) | **Disposable.** Seeded from a bundled snapshot; replaced wholesale when a newer snapshot ships. No migrations. |

Plus `DATA_DIR` files: `secret.key` (**user** — the key that decrypts session/oauth; losing it
logs the user out — keep as-is, never blow away), and two **market/reference** artifacts that
are rebuildable/derivable and therefore disposable: `gamedata/` (cached game data) and
`recipes.json`.

> **`recipes.json` is NOT user data** despite living next to it today — it's reference data
> (crafting recipe definitions, derivable from game data); it only sits as a loose file because
> there was no clean home. Treat it as market/reference: it should ship in the snapshot (or be
> regenerated), and it's safe to blow away. Preferred end state: fold recipes into
> `market.sqlite` (a `recipes` table) so it rides the snapshot like everything else; until then,
> bundle `recipes.json` as a build resource rather than persisting a user copy.

### Data classification (authoritative)

**USER → `user.sqlite`** (persist + migrate):
- Table `capital` — held currency quantities.
- `kv` keys: the `USER_KV` set in `backend/app/datapolicy.py` — settings, the trading
  workspace tree (and the legacy `watches` blob it was migrated from), signal dismissals, OAuth
  PKCE state, user currency-id overrides — plus every `secret:*` key (encrypted session cookie +
  oauth tokens). The module is the authoritative list; this doc states the rule.

**MARKET/OPERATIONAL → `market.sqlite`** (disposable, shippable):
- Tables `digest_markets`, `orderbook`, `orderbook_history`, `league_daily`, `item_meta`,
  plus the runtime-only `analytics_jobs` / `analytics_cache` (sidecar transport; never ship).
- `kv_ops` keys: crawl watermarks (`digest_cursor`, `lh_current`, `lh_complete:*`,
  `lh_fetch:*`), `meta_bridge` (poe2scout metadata→trade mapping), `gold_fees_meta`,
  `pair_scores`, `trade_leagues`.
- Retention: `digest_markets` is pruned past `MARKET_RETENTION_DAYS` and `orderbook_history`
  past `ORDERBOOK_HISTORY_RETENTION_H` (both in `datapolicy.py`) by the background loops.

> The `kv` table is the one that splits: user keys stay in `user.sqlite.kv`, operational keys
> live in `market.sqlite.kv_ops`. Routing is `datapolicy.is_user_kv()`, imported by `db.py`,
> `migrations_user.py` and the seed exporter alike. **Any new kv key must be classified there**
> or it defaults to operational (lands in `kv_ops`, ships in the snapshot).

## How the two files are accessed

One connection per thread (as today), opened on `user.sqlite` and with `market.sqlite`
**ATTACHed** as schema `market`:

```
ATTACH DATABASE '<DATA_DIR>/market.sqlite' AS market;
```

- User tables are referenced unqualified (`capital`, `kv`) — resolve to `main` (user.sqlite).
- Market tables are referenced `market.league_daily`, `market.digest_markets`, etc.
- **There are no SQL joins that cross user↔market** (verified: the graph/board/hold logic
  reads settings & capital into Python dicts, never JOINs them against market tables), so the
  split is safe. Cross-file writes still serialize on the existing app-wide `_write_lock`.
- Both files use WAL. Seeding/replacement of `market.sqlite` happens **before** any
  connection ATTACHes it (at startup, single-threaded).

## The bundled snapshot (seed)

`market.sqlite` is seeded from a prebuilt snapshot shipped with the app:

- The snapshot file `market-seed.sqlite` is bundled via electron-builder `extraResources`.
  Electron passes its path to the backend as env `MARKET_SEED` (like `DATA_DIR`/`PORT` today).
- The snapshot carries a **`snapshot_version`** (a monotonic integer or ISO timestamp) in a
  `market_meta` table.

### Seeding logic (backend startup, before ATTACH)

```
seed_v   = read snapshot_version from MARKET_SEED           (bundled)
local_v  = read snapshot_version from DATA_DIR/market.sqlite (or -1 if missing/corrupt)
if local missing OR seed_v > local_v:
    copy MARKET_SEED -> DATA_DIR/market.sqlite   (atomic: copy to .tmp, fsync, rename)
# else keep the user's working market.sqlite (it has newer live data)
```

This is the **"throw in a snapshot without regard of structure"** rule: when a newer app
ships a newer snapshot, the local market DB is **replaced entirely** — no migration, no merge.
The market schema therefore always matches the running backend (they ship together). Any live
digest/orderbook the user accrued since install is disposable and re-accrues.

After seeding, the backend still runs `CREATE TABLE IF NOT EXISTS` for every market table so
the live-append paths (digest/orderbook ingestion) are safe even against an empty/absent seed.

### Catch-up: resume from the snapshot to *now* (do NOT re-crawl, do NOT freeze)

The snapshot is a **starting point**, not the final state. Once seeded, the deployment must
**catch up from the snapshot's cutoff to the present** — fetching only the *gap*, incrementally.

This works because the snapshot carries the **crawl watermarks** (they live in the operational
kv, which is part of the market DB and therefore ships inside the snapshot):
- `digest_cursor` — the last hourly GGG digest fetched. On resume, the digest ingester fetches
  `cursor+1 … now` only.
- `lh_current`, `lh_complete:*`, `lh_fetch:*` — poe2scout backfill completion/freshness markers.
  On resume, `leaguehistory` fetches only missing/stale item-days (respecting `REFRESH_S`), not
  the whole history.

So the invariant the implementer MUST preserve: **all market ingestion is watermark-driven and
gap-filling** (it already is today). Seeding sets the watermarks to the snapshot's cutoff; the
normal ongoing ingestion loop then advances them to now. Net effect for the user:

```
install/update ──► seed (full history up to snapshot cutoff, instantly)
             └───► background: digest cursor + poe2scout markers resume → fill snapshot→now
```

Consequences / requirements:
- The export MUST include the operational cursors/markers (kv_ops) in the snapshot, not just the
  data tables — otherwise the client would re-crawl from zero or sit frozen.
- Wholesale replace on a newer snapshot also replaces the watermarks with the newer snapshot's,
  so the client catches up from the newer cutoff (never backwards in practice — a newer app's
  snapshot is built later than the one it replaces).
- If the gap exceeds GGG's served digest window (e.g. the app sat unopened for weeks), the
  ingester fills what GGG still serves and moves on — digest is a rolling window; missing old
  hours are acceptable. poe2scout dailies backfill the gap by day.

### Where the snapshot comes from (build time, not runtime)

The crawl is **not** run per-build from scratch. **shazam already crawls continuously** and
holds the full financial history, so the snapshot is an **export of shazam's market tables**:

```
shazam root cron (daily)  ──►  ops/export-market-snapshot.py  ──►  market-seed.sqlite.gz (+ .version)
                                                                └─►  GitHub release `market-seed-latest`
                                                                       ├─► Windows CI pulls it
                                                                       └─► Mac build pulls it (fetch-seed.sh)
```

- Both platforms fetch the seed from the **same GitHub release asset**; there is no LAN copy.
- The desktop build drops `market-seed.sqlite` into `desktop/market-seed/` and bundles it via
  `extraResources`.

This keeps the **desktop contract intact**: the seed is embedded at *build* time; at *runtime*
the app still only ever calls the server for **updates**. Users never fetch market data.

## Interaction with the cold-backfill UI

The existing `/api/backfill` "building your dashboard" flow becomes a **rare fallback** — it
only runs when the bundled seed is missing/older than the current league's data (e.g. a brand
new league before the next snapshot ships). With a fresh snapshot, users see a populated board
immediately and the spinner rarely appears.

## Non-goals / explicitly out of scope

- No merge between old and new market data on update (wholesale replace only).
- No migrations for the market DB (schema rides with the snapshot + backend version).
- Per-card numeraire overrides stay in the frontend `localStorage` (already persists across
  updates); not part of this split.
