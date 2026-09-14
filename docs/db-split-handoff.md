# Handoff: implement the user/market DB split

> **STATUS: DONE (2026-09-14).** Implemented + tested end-to-end on the Mac desktop app (fresh
> seeded install, upgrade-in-place preserving login/settings, catch-up not re-crawl, wholesale
> replace, market reset, no-seed dev/server). This doc is kept as the historical build plan;
> the living docs are [`db-architecture.md`](./db-architecture.md) (design) and
> [`db-maintenance.md`](./db-maintenance.md) (rules).
>
> Deviations from the plan below, all deliberate: (1) the seed ships **gzipped** + `.version`
> sidecar (43 MB vs 366 MB), decompressed once in `seed_market()`; (2) export drops private
> "(PLxxxxx)" leagues by default; (3) snapshot publishing is a **release-time manual step** via
> the ssh wrapper, not a shazam cron (shazam isn't in the docker group / cron has no tty);
> (4) the GitHub-asset upload for Windows CI needs a `GH_TOKEN` that isn't configured yet —
> refresh the Windows seed manually until it is.

## Goal (one paragraph)

Split the single SQLite DB into `user.sqlite` (persist forever, migrate carefully) and
`market.sqlite` (disposable, seeded from a snapshot bundled in the binary, replaced wholesale
when a newer snapshot ships, and **caught up to now** by the existing watermark-driven crawl).
Users never lose settings/capital/login and never wait for a cold backfill.

## Current state you're changing (facts, verified)

- `backend/app/config.py` defines `DATA_DIR` (env, default `/data`) and
  `DB_PATH = DATA_DIR/"poe2arb.sqlite"`, `RECIPES_PATH = DATA_DIR/"recipes.json"`.
- `backend/app/db.py`: one `SCHEMA` string; per-thread connection (`_local.conn`) via
  `_connect()`; app-wide `_write_lock`; `tx()`/`q()` context managers; `kv_get/kv_set`,
  `get_capital/set_capital`. A module-level `_boot` runs `SCHEMA` at import.
- Tables today: `digest_markets`, `orderbook`, `orderbook_history`, `capital`, `kv`,
  `league_daily`, `item_meta`.
- `kv` keys in use (grep `kv_get|kv_set`): **user** = `settings`, `watches`, `oauth_pending`,
  `meta_overrides`, `secret:*`; **operational** = `digest_cursor`, `gold_fees_meta`,
  `lh_current`, `pair_scores`, `trade_leagues`, `lh_complete:*`, `lh_fetch:*`.
- No SQL JOINs cross user↔market (settings/capital are read into Python, not joined). Safe.
- Desktop passes `DATA_DIR` + `PORT` env to the bundled backend (see `desktop/src/main.js`
  `startBackend()`); backend entry is `backend/run_desktop.py`.
- Electron bundles the backend via `desktop/package.json` `build.extraResources`.

## Ordered implementation steps

### 1. Paths (`config.py`)
- `USER_DB_PATH = DATA_DIR/"user.sqlite"`, `MARKET_DB_PATH = DATA_DIR/"market.sqlite"`.
- `MARKET_SEED_PATH = Path(os.environ.get("MARKET_SEED", "")) or None` (Electron sets it; empty
  in dev/server → no seed, just crawl live).
- Keep `DB_PATH` (legacy) for the one-time split detection.

### 2. Split the schema + connection (`db.py`)
- Split `SCHEMA` into `USER_SCHEMA` (`capital`, `kv`, `user_meta(key,value)`) and
  `MARKET_SCHEMA` (`digest_markets`, `orderbook`, `orderbook_history`, `league_daily`,
  `item_meta`, `kv_ops(key,value)`, `market_meta(key,value)`).
- **Startup order (single-threaded, before any per-thread conn):**
  1. `seed_market()` — implement the seeding logic from the architecture doc (copy
     `MARKET_SEED_PATH` → `MARKET_DB_PATH` if local missing or `seed_v > local_v`, atomic
     tmp+rename). Compare `market_meta.snapshot_version`.
  2. Open user connection on `USER_DB_PATH`; `executescript(USER_SCHEMA)`.
  3. Run **user migrations** (step 4).
  4. `run_legacy_split()` if `poe2arb.sqlite` exists and `user_meta.split_done` unset (step 5).
  5. Ensure market file exists: if `MARKET_DB_PATH` missing, create it and
     `executescript(MARKET_SCHEMA)` (covers dev/server with no bundled seed).
- `_connect()` opens `USER_DB_PATH` and immediately `ATTACH DATABASE '<MARKET_DB_PATH>' AS
  market`. Set WAL/busy_timeout on both (`PRAGMA market.journal_mode=WAL`).
- **Table references:** market tables can stay **unqualified** in existing SELECTs (SQLite
  resolves `league_daily` → `market.league_daily` since it only exists there). But **every
  `CREATE TABLE` for market** must target `market.<t>`, and the market schema must be created on
  the market file. Simplest: create market schema when seeding/creating the market file, not via
  the attached connection. Audit `CREATE TABLE IF NOT EXISTS` calls in `leaguehistory.py`/
  `digest.py`/`orderbook.py` — point any market ones at `market.`.
- **kv routing:** `_USER_KV = {"settings","watches","oauth_pending","meta_overrides"}`; keys
  starting `secret:` → user. `kv_get/kv_set` pick table `kv` (user, `main`) vs `kv_ops`
  (`market`) by that rule. `get_capital/set_capital` stay on `capital` (user).

### 3. Snapshot meta helpers (`db.py`)
- `market_meta` get/set for `snapshot_version`. Export stamps it; seeding compares it.

### 4. User migration runner (`db.py` + `backend/app/migrations_user.py`)
- `user_meta.schema_version` (int, default 0). Run `USER_MIGRATIONS` with `id > version` in
  order, each in its own transaction; back up `user.sqlite` before running any; set version to
  the max applied; abort startup loudly on failure.
- `migrations_user.py`: `USER_MIGRATIONS = [(1, "initial split", _m1_split_from_legacy), …]`.

### 5. One-time legacy split (migration #1 / `run_legacy_split`)
Existing installs have a single `poe2arb.sqlite` with everything. On first run of the new
backend, if `user.sqlite` is fresh and `poe2arb.sqlite` exists:
- Copy **user rows** out of `poe2arb.sqlite` into `user.sqlite`: all of `capital`; the `kv`
  rows whose key ∈ user set (`settings`,`watches`,`oauth_pending`,`meta_overrides`,`secret:*`).
- **Do NOT** copy market tables into `market.sqlite` — let `market.sqlite` come from the bundled
  seed (fresh full history) and catch up. (Copying old market data is optional; the seed is
  better. If no seed present — server/dev — the live crawl rebuilds it.)
- Rename `poe2arb.sqlite` → `poe2arb.sqlite.premigration` (keep as a safety backup; don't
  delete). Set `user_meta.split_done=1`.
- ⚠️ `secret.key` already persists in `DATA_DIR` (untouched), so the copied `secret:*` blobs
  stay decryptable — the user's PoE session/oauth survive. Verify this.

### 6. Electron wiring (`desktop/`)
- `src/main.js` `startBackend()`: add `MARKET_SEED` to the child env, pointing at the bundled
  seed (e.g. `path.join(process.resourcesPath, 'market-seed', 'market-seed.sqlite')`), like
  `DATA_DIR`/`PORT`.
- `package.json` `build.extraResources`: add `desktop/market-seed/` → `market-seed/`.
- Add `desktop/market-seed/` to `.gitignore`.

### 7. Snapshot export + publish (`ops/export-market-snapshot.py`)
- Implement per architecture doc: copy market tables (+ **operational kv/cursors** — required
  for catch-up) from shazam's DB into `market-seed.sqlite`, stamp `snapshot_version`, `VACUUM`.
- Publish to shazam `/downloads/market-seed.sqlite` **and** upload as a GitHub Release asset on
  tag `market-seed-latest` (needs a GH token secret on shazam — document it).
- Add a shazam cron (daily) + run before each desktop release.

### 8. Build consumption
- `desktop/build-backend.sh` (or a sibling `fetch-seed` step): fetch seed from shazam (LAN) →
  `desktop/market-seed/market-seed.sqlite`.
- `.github/workflows/release-desktop-win.yml`: add a step to download the seed from the GitHub
  Release asset → `desktop/market-seed/market-seed.sqlite` before `electron-builder`.

## Acceptance criteria

1. **Fresh install (with seed):** board is populated instantly from the snapshot; no long cold
   backfill; `/api/backfill` shows done/idle quickly; background crawl advances the watermarks.
2. **Upgrade with existing data:** an install upgraded from the current single-DB build keeps
   settings, capital, watches, and stays logged in (session/oauth survive). `poe2arb.sqlite.
   premigration` exists as backup.
3. **Snapshot replace:** shipping a newer `snapshot_version` replaces `market.sqlite` on next
   launch; user data untouched; catch-up resumes from the new cutoff.
4. **Catch-up:** after seeding, digest/poe2scout fetch only snapshot→now (watch logs/watermarks;
   confirm it is NOT re-crawling from zero and NOT frozen at snapshot age).
5. **Market reset:** deleting `DATA_DIR/market.sqlite` re-seeds on launch; user data untouched.
6. **Dev/server (no seed):** backend with no `MARKET_SEED` creates an empty market DB and
   crawls live exactly as today (no regression on the shazam web deploy).
7. **Contract:** packaged desktop still only calls the server for updates (seed is build-time).

## Test plan (concrete)

- Unit: kv routing (user keys → `kv`, ops keys → `kv_ops`); `seed_market` version comparison
  (missing / older / newer local); legacy split copies exactly the user rows.
- Integration on the Mac dev app:
  - Take a real current `poe2arb.sqlite` (copy from `~/Library/Application Support/Arbiter/data`)
    → run new backend → assert user data present in `user.sqlite`, market from seed, app logged
    in, board populated.
  - Delete `market.sqlite` → relaunch → re-seeds.
  - Bump a seed's `snapshot_version`, drop it in → relaunch → market replaced, user intact.
- Web (shazam) regression: deploy backend with no seed → confirm normal crawl + all views work.
- Windows: build via CI with the seed step; smoke-test install + upgrade with telemetry
  (`p=init`/logs) — remember you own Windows verification via telemetry, not the user.

## Risks & rollback

- **Data loss during legacy split** — mitigate: never delete `poe2arb.sqlite` (rename to
  `.premigration`); back up `user.sqlite` before each migration; the split is copy-then-mark,
  idempotent via `split_done`.
- **ATTACH + WAL edge cases** — keep seeding/replacement strictly before any connection attaches;
  one writer (existing `_write_lock`).
- **Snapshot/backend schema drift** — enforce the "bump snapshot_version whenever MARKET_SCHEMA
  changes, ship together" rule (maintenance doc); `CREATE TABLE IF NOT EXISTS` backstops missing
  tables only.
- **Seed unreachable in CI** — the GitHub Release asset path is the CI source; if missing, fail
  the build loudly rather than shipping a seedless binary that forces a cold backfill.
- Rollback: the change is additive (new files + `poe2arb.sqlite.premigration` retained); a
  reverted backend can still read the legacy file if you also keep a legacy read path during the
  transition release.

## Suggested PR sequence (small, reviewable)

1. `db.py`/`config.py`: two files + ATTACH + kv routing + user migration runner + legacy split
   (no snapshot yet; market created empty). Ship + verify web + Mac upgrade keeps user data.
2. Snapshot: `export-market-snapshot.py` + shazam cron + GitHub asset. Verify a seed is produced
   and versioned.
3. Build wiring: Electron `MARKET_SEED` + extraResources + CI/Mac fetch. Verify fresh install is
   instant and catch-up works.
4. (Later) fold `recipes.json` into `market.sqlite`.
