# Database maintenance guide

> Read [`db-architecture.md`](./db-architecture.md) first. This doc is the day-to-day rulebook
> for changing the schema once the split is implemented. **The core rule:** decide whether the
> thing you're adding is **user data** (persist + migrate) or **market data** (disposable +
> ship in the snapshot). Get that wrong and you either lose user data or force needless
> re-crawls.

## Decision tree: where does my new data go?

```
Is it something the USER created/owns and would be upset to lose on update?
  (settings, capital, saved searches, login, personal overrides)
      → USER data → user.sqlite → REQUIRES A MIGRATION (see below)
  else it's derived from the market / crawlable / a cache
      → MARKET data → market.sqlite → NO migration; ships in the snapshot; bump snapshot_version
```

When unsure, put it in **user.sqlite** — worst case it persists and is never blown away
(safe). The only cost is it won't ship in the snapshot.

## USER data (`user.sqlite`) — the migration system

User data is **migrated forward, never dropped.** Migrations are **numbered, ordered,
forward-only, idempotent, and data-preserving.**

- The current schema version is stored in `user.sqlite` (table `user_meta(key,value)`, key
  `schema_version`, integer).
- On startup, `db.py` runs every migration with `id > schema_version` in order, each in a
  transaction, then sets `schema_version` to the highest applied. A failed migration rolls back
  and aborts startup (loud failure > silent corruption).
- Migrations live in `backend/app/migrations_user.py` as an ordered list:

```python
# backend/app/migrations_user.py
USER_MIGRATIONS = [
    (1, "initial split", _m1_split_from_legacy),   # see handoff: one-time split of poe2arb.sqlite
    (2, "add capital.note column", lambda c: c.execute(
        "ALTER TABLE capital ADD COLUMN note TEXT")),
    # (3, "…", fn),
]
```

### How to add a user migration

1. Append a new `(id, description, fn)` with `id = last + 1`. **Never renumber or edit a shipped
   migration** — users may already be past it.
2. `fn(conn)` receives the write connection. Use `ALTER TABLE`/`CREATE TABLE`/data backfill.
   Make it **idempotent where cheap** (`CREATE TABLE IF NOT EXISTS`, guard `ALTER` with a
   `PRAGMA table_info` check) so a half-applied migration re-runs safely.
3. Before a risky migration (data transform), `db.py` copies `user.sqlite` →
   `user.sqlite.bak-<from_version>` so a botched upgrade is recoverable.
4. Test the upgrade path: take a `user.sqlite` from the previous release, run the new backend,
   confirm data survives and `schema_version` advanced. See the handoff test plan.

### Rules

- User migrations must run **before** anything reads user data.
- Adding a **new user kv key**: add it to `USER_KV` in `backend/app/datapolicy.py` (see below).
  No migration needed for a new kv key (the `kv` table already exists) — just the routing entry.
- Never store market/derived data in `user.sqlite` to "avoid a migration" — it'll go stale and
  won't get snapshot refreshes.

## MARKET data (`market.sqlite`) — no migrations, ship the snapshot

Market data has **no migration system**. The schema rides with the code + snapshot, which ship
together. To change it:

1. Edit the market schema (`CREATE TABLE …`) in `db.py` (the `MARKET_SCHEMA` block).
2. Publish a new snapshot (below): its `snapshot_version` is the epoch second of the export, so
   every publish is "newer" and **replaces** every client's `market.sqlite` on update. The
   exporter copies each shipped table's DDL from the live DB, so the new schema rides along
   with no exporter edit.
3. Ship the backend that matches it in the same release.

> ⚠️ **The backend version and the snapshot are a matched pair.** If you change a market table,
> you MUST ship a new snapshot with a bumped version in the SAME release. Otherwise a client on
> the new code could keep an old-schema `market.sqlite` (seed not newer) and break.
> Backstop: the backend runs `CREATE TABLE IF NOT EXISTS` for market tables at startup, so a
> *missing* table self-heals, but a *changed* column shape does not — rely on the version bump.

### Classifying a new `kv` key

`db.py` routes `kv_get/kv_set` by key through the ONE allow-list, `USER_KV` /
`is_user_kv()` in `backend/app/datapolicy.py` (dependency-free; `migrations_user.py` and the
seed exporter import the same module, so there are no hand-mirrored copies to drift):

```python
USER_KV = {...}            # the user-owned keys — read the file, don't copy the list here
# + prefix "secret:"; everything else → market.sqlite.kv_ops (operational: cursors, caches)
```

- User-owned key → add it to `USER_KV` (or a `secret:`-style prefix rule).
- Operational/derived key → do nothing; it lands in `kv_ops` and ships in the snapshot.
- **A new operational cursor/watermark MUST be operational** (in `kv_ops`) so it ships in the
  snapshot and drives catch-up. If you add a new crawl cursor and forget this, new installs
  re-crawl from zero.

## Building / refreshing the market snapshot

The snapshot is an **export of shazam's already-crawled market tables** — we do not re-crawl at
build time. It ships **gzipped** (`market-seed.sqlite.gz`, ~43 MB vs ~366 MB raw; the backend
decompresses it once during `seed_market()`), with a plaintext `market-seed.sqlite.gz.version`
sidecar so the client can compare `snapshot_version` without decompressing on every launch.

- Script: `ops/export-market-snapshot.py` (runs inside the backend container so it can import
  `app.datapolicy`). It:
  1. Opens the live `market.sqlite` read-only (the legacy single-file DB is not supported).
  2. Copies `datapolicy.SEED_TABLES` — `digest_markets` (windowed to `MARKET_RETENTION_DAYS`,
     **public leagues only** by default; private "(PLxxxxx)" leagues are dropped), `league_daily`
     and `item_meta` in full, and `kv_ops` (the crawl watermarks + `meta_bridge`) — copying each
     table's DDL and indices from the source's `sqlite_master`. `orderbook*` (session-bound,
     re-accrues live in minutes) and the `analytics_*` runtime tables never ship.
  3. Writes `market_meta.snapshot_version` = current epoch seconds (monotonic).
  4. `VACUUM`s, then gzips (`--no-gzip` to skip) and writes the `.version` sidecar.
  Flags: `--all-leagues` (keep private leagues), `--no-gzip`, `--version N`, `--force` (skip the
  digest-freshness guard).
- **Publishing:** `ops/publish-market-snapshot.sh` runs on shazam from **root's cron, daily at
  04:17** (`crontab -l` as root; log in `/home/shazam/poe2-snapshot.log`), and on demand with
  `sshshazambom sudo /home/shazam/bin/publish-market-snapshot.sh` (do this after any market-side
  change — see CLAUDE.md). It exports inside the backend container and uploads the seed +
  sidecar to the rolling `market-seed-latest` GitHub prerelease via `ops/upload-seed-github.sh`;
  the token comes from `shazam:~/.poe2-gh-token` (fine-grained PAT, **Contents: Read and write**;
  placed/rotated by `ops/refresh-gh-token.sh`). **It fails hard without a token** — there is no
  LAN copy any more, so a frozen seed can't be silent. `./ops/deploy-web.sh ops` syncs the three
  scripts to `shazam:~/bin`.
  - **Place / rotate the token:** run `ops/refresh-gh-token.sh` from the Mac (paste a scoped PAT;
    input is hidden and piped straight to the server — never printed). Rotating = create a new PAT,
    re-run the script. Editing an existing fine-grained PAT's permissions keeps the same value, so
    no re-run is needed for a permission fix.

### Consuming the snapshot in builds

- **Mac** (local): `desktop/fetch-seed.sh` pulls `market-seed.sqlite.gz` (+ `.version`) from
  the `market-seed-latest` GitHub release → `desktop/market-seed/` (`publish-github.sh` runs it
  before `electron-builder --mac`). Same asset as Windows CI — one seed channel.
- **Windows CI** (`.github/workflows/release-desktop-win.yml`): a `gh release download
  market-seed-latest` step pulls the seed asset → `desktop/market-seed/`.
- `desktop/package.json` `build.extraResources` bundles `desktop/market-seed/` so the backend
  finds it at `MARKET_SEED` at runtime (`desktop/src/main.js` prefers `market-seed.sqlite.gz`,
  falls back to a plain `.sqlite`).
- `desktop/market-seed/` is **git-ignored** (large, fetched per build) — never commit the seed.

## Quick reference

| Task | Action |
|---|---|
| Add a user column/table | New numbered migration in `migrations_user.py` |
| Add a user kv key | Add to `USER_KV` in `datapolicy.py` (no migration) |
| Add/change a market table | Edit `MARKET_SCHEMA` (+ `datapolicy.SEED_TABLES` if it should ship) + publish a snapshot |
| Add a market kv/cursor | Nothing (lands in `kv_ops`); ensure it's a watermark for catch-up |
| Refresh users' market data | Publish a newer snapshot (bumped version) — clients replace on update |
| Reset a user's market data | Delete `DATA_DIR/market.sqlite`; it re-seeds on next launch |
| Never | Put market data in `user.sqlite`, or user data in `market.sqlite` |
