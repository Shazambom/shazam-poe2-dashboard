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
- Adding a **new user kv key**: also add it to the `_USER_KV` allow-list in `db.py` (see below).
  No migration needed for a new kv key (the `kv` table already exists) — just the routing entry.
- Never store market/derived data in `user.sqlite` to "avoid a migration" — it'll go stale and
  won't get snapshot refreshes.

## MARKET data (`market.sqlite`) — no migrations, ship the snapshot

Market data has **no migration system**. The schema rides with the code + snapshot, which ship
together. To change it:

1. Edit the market schema (`CREATE TABLE …`) in `db.py` (the `MARKET_SCHEMA` block).
2. **Bump `snapshot_version`** in the export script so the next snapshot is considered "newer"
   and **replaces** every client's `market.sqlite` on update (schema comes along for free).
3. Rebuild + publish the snapshot (below). Ship the backend that matches it in the same release.

> ⚠️ **The backend version and the snapshot are a matched pair.** If you change a market table,
> you MUST ship a new snapshot with a bumped version in the SAME release. Otherwise a client on
> the new code could keep an old-schema `market.sqlite` (seed not newer) and break.
> Backstop: the backend runs `CREATE TABLE IF NOT EXISTS` for market tables at startup, so a
> *missing* table self-heals, but a *changed* column shape does not — rely on the version bump.

### Classifying a new `kv` key

`db.py` routes `kv_get/kv_set` by key:

```python
_USER_KV = {"settings", "watches", "oauth_pending", "meta_overrides"}   # + prefix "secret:"
# everything else → market.sqlite.kv_ops  (operational: cursors, caches, backfill markers)
```

- User-owned key → add it to `_USER_KV` (or a `secret:`-style prefix rule).
- Operational/derived key → do nothing; it lands in `kv_ops` and ships in the snapshot.
- **A new operational cursor/watermark MUST be operational** (in `kv_ops`) so it ships in the
  snapshot and drives catch-up. If you add a new crawl cursor and forget this, new installs
  re-crawl from zero.

## Building / refreshing the market snapshot

The snapshot is an **export of shazam's already-crawled market tables** — we do not re-crawl at
build time. It ships **gzipped** (`market-seed.sqlite.gz`, ~43 MB vs ~366 MB raw; the backend
decompresses it once during `seed_market()`), with a plaintext `market-seed.sqlite.gz.version`
sidecar so the client can compare `snapshot_version` without decompressing on every launch.

- Script: `ops/export-market-snapshot.py`. It:
  1. Opens the live DB read-only.
  2. Copies market tables (`digest_markets` within a 14-day rolling window and **public leagues
     only** by default — private "(PLxxxxx)" leagues are dropped; `league_daily` full,
     `item_meta` full, `orderbook*` if present) **and** the operational kv (`digest_cursor`,
     `lh_*`, `gold_fees_meta`, `pair_scores`, `trade_leagues`) into `kv_ops`.
  3. Writes `market_meta.snapshot_version` = current epoch seconds (monotonic; a MARKET_SCHEMA
     change ships a newer version for free since epoch grows).
  4. `VACUUM`s, then gzips (`--no-gzip` to skip) and writes the `.version` sidecar.
  Flags: `--all-leagues` (keep private leagues), `--no-gzip`, `--version N`.
- **Publishing (release-time):** run `ops/publish-market-snapshot.sh` on shazam via the ssh
  wrapper (it needs sudo for `docker exec` + writing `/downloads`; shazam is not in the docker
  group and cron has no tty, so this is a **manual release-time step, not a cron**):
  `sshshazambom sudo bash /home/shazam/bin/publish-market-snapshot.sh`.
  It exports inside the backend container and copies the seed + sidecar to
  `/downloads/market-seed.sqlite.gz`.
- **GitHub Release asset (for Windows CI, which can't reach the LAN):** `publish-market-snapshot.sh`
  auto-sources a token from `shazam:~/.poe2-gh-token` (fine-grained PAT, **Contents: Read and
  write**; `GH_REPO` defaults to `Shazambom/shazam-poe2-dashboard`) and calls
  `ops/upload-seed-github.sh`, which creates/updates the rolling `market-seed-latest` prerelease
  with `market-seed.sqlite.gz` + `.version`. The CI step (`gh release download market-seed-latest`)
  fails loudly if the asset is missing rather than shipping a seedless (cold-backfill) binary.
  - **Place / rotate the token:** run `ops/refresh-gh-token.sh` from the Mac (paste a scoped PAT;
    input is hidden and piped straight to the server — never printed). Rotating = create a new PAT,
    re-run the script. Editing an existing fine-grained PAT's permissions keeps the same value, so
    no re-run is needed for a permission fix.

### Consuming the snapshot in builds

- **Mac** (local, reaches the LAN): `desktop/fetch-seed.sh` pulls
  `market-seed.sqlite.gz` (+ `.version`) from shazam `/downloads` → `desktop/market-seed/`.
  Run it before `electron-builder --mac`.
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
| Add a user kv key | Add to `_USER_KV` in `db.py` (no migration) |
| Add/change a market table | Edit `MARKET_SCHEMA` + bump `snapshot_version` + ship new snapshot |
| Add a market kv/cursor | Nothing (lands in `kv_ops`); ensure it's a watermark for catch-up |
| Refresh users' market data | Publish a newer snapshot (bumped version) — clients replace on update |
| Reset a user's market data | Delete `DATA_DIR/market.sqlite`; it re-seeds on next launch |
| Never | Put market data in `user.sqlite`, or user data in `market.sqlite` |
