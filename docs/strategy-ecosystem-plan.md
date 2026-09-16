# Strategy ecosystem — build plan & handoff

The Strategy tab is growing from two tools (Hold = keep wealth vs inflation, Arbitrage =
make wealth via loops) into a small **ecosystem** of wealth tools. This doc is the durable
roadmap: an agent picking up after a context compaction should be able to continue from here.

Design + validation was done via research → a 4-candidate `/arena` (+ cross-judge). The
synthesis lives at `scratchpad/arena-strategy/SYNTHESIS.md`; research at
`scratchpad/research-synthesis.md`. **Read `CLAUDE.md` first** — the ecosystem-not-dashboards
rule, the SQLite-transport sidecar rule, the desktop contract, and the port-tests-first rule
all govern this work.

## The four validated player problems (owner-chosen)
Each tool must solve a named problem; anything that doesn't is cut. Existing: Arbitrage=MAKE,
Hold=KEEP. The big gap was **TIME** (when to act).

| # | Tool | Problem | Status |
|---|------|---------|--------|
| 1 | **Convert** (cheapest A→B) | TIME/execution | ✅ DONE (see below) |
| — | **Gold-value slider** | shared gold price for ranking | ✅ DONE (phase 1.5) |
| 2 | **Ghost Wealth** (can I cash out?) | KEEP/DECIDE | ⬜ TODO |
| 3 | **Timing / league-arc** (when to buy/sell) | TIME | ✅ DONE (DTW arc in CardDetail + Hold) |
| 4 | **What's about to move** | TIME | ✅ DONE (Divine-orb signal inbox → CardDetail) |
| 2 | **Ghost Wealth** (can I cash out?) | KEEP/DECIDE | ✅ DONE (0.2.45) |
| — | **Centrality** (connective tissue) | feeds 1/2/4, never a page | ✅ DONE (Phase 5 below) |
| — | **Sidecar runtime** | hosts heavy libs for 3 & 4 | ✅ DONE (Phase 6 below) |

## Cross-cutting decisions (locked)
- **Ecosystem, not dashboards.** Reuse `CardDetail`, the `Loop`/`Detail` route renderer
  (`RouteSteps.jsx`), `CapitalCard`, `CurrencyPicker`, the `pingStore`/`VaalPingOrb` inbox, and
  the `nav` bus. New sub-tabs only for a genuinely distinct primary workflow. Convert lives as a
  **panel on the Arbitrage page**, not its own tab.
- **Gold is a real, precious, fully-known cost** (`gamedata.fees()` — per-unit `GoldPurchaseFee`,
  687 rows; divine=800, chaos=160, exalted=120, omens present). Rank by **net value** = value of
  `want` received − gold charged at a **user-set price** `gold_value_per_1k` (Divine per 1k gold),
  because gold's worth shifts across a league. The slider sets this; it feeds Convert (done) AND
  Arbitrage velocity (owner: "scale the gold divisor" → implement as an additive-cost divisor,
  see phase 1.5).
- **Heavy analytics run in a bundled LOCAL sidecar**, transport = **SQLite** (dedicated
  events/cache table, RO bulk reads), NOT a network layer. Lifecycle bound to the backend
  (supervision tree) with a PARENT_PID watchdog. Endpoints only READ the cache → the sidecar can
  never break a request; degrade gracefully when it's down. See `CLAUDE.md` "Heavy analytics".
- **Thin-data discipline:** reuse `holdscore._smooth` (3-day median) + volume floors
  (`movers.MIN_VALUE_EX`); winsorize returns before any correlation.

## Shared cores (build once, before dependents)
- `backend/app/analytics_common.py` (TODO): thin wrapper over `movers._current_series()` +
  `log_returns`, `medval`, `mad_z`, `winsorize`; re-export `holdscore._smooth`. Used by 3 & 4.
- `backend/app/liquidity.py` (TODO): `realizable(currency, qty, ref_value, max_slip)` — walk the
  sell-side ladder (`orderbook.latest_books`, `Edge.fill` semantics), digest-volume fallback,
  return `{realizable_ref, slippage_pct, fill_hours, source}`. Used by Ghost Wealth (2). NOTE:
  the convert loss/gold math already lives in `arbitrage._convert_path`; factor shared bits if
  they converge.
- `market.sqlite` `analytics_cache(kind, key, computed_at, value_json)` (TODO): sidecar writes,
  backend reads. Add to `MARKET_SCHEMA` in `db.py` + bump the market snapshot version (market
  schema change → new snapshot, NOT a user migration; see `docs/db-maintenance.md`).

---

## Phase 1 — Convert (DONE — reference implementation)
Cheapest way to turn `have` into `want` across the exchange graph (open path, not a loop).

- **Backend** `backend/app/arbitrage.py`: `Graph.iter_paths(start, target, max_steps)` (open-path
  sibling of `iter_cycles`); `_convert_path()` (sizes by amount capped by `route_cap`, runs the
  existing `simulate()`, shapes a route dict with `out`, `loss_pct`, `gold`, `net_ref`,
  `full_fill`); `_best_conversions(g, ref_value, have, want, amount, max_steps, max_gain_pct,
  gold_value_per_1k)` (ranks by `(full_fill, net_ref, -hops)`, drops phantom-gain mirages via
  `max_gain_pct`); `convert()` (public wrapper reading capital + the `gold_value_per_1k` setting).
  `GOLD_VALUE_DIVINE_PER_1K = 0.05` default constant.
- **Endpoint** `GET /api/convert?have=&want=&amount=&max_steps=` in `main.py`.
- **Frontend**: `RouteSteps.jsx` (extracted `Loop`/`Detail` from `RoutesView`, now shared);
  `CurrencyPicker.jsx` (searchable, icon-rich combobox — reuses `cmdk-item` styling); `ConvertView.jsx`
  (React.memo'd panel, pickers + amount, reused `Loop`, direct-vs-best delta, alternatives);
  rendered atop `.main` in `RoutesView`. `api.convert` in `api.js`.
- **Tests**: `backend/tests/test_convert.py` — 9 cases (open paths, two-hop-beats-direct,
  liquidity cap, gain-mirage rejection, gold-value-flips-ranking, endpoint wiring). All green.
- **Learnings that WILL recur (read before phases 2-4):**
  1. **Driving finds what tests don't.** Two mirages only surfaced in the running app: a phantom
     +50%-value path (fixed via `max_gain_pct` gain-tolerance) and a 585k-gold path (fixed by the
     net-value/gold-price ranking). Always drive over CDP against real data.
  2. **Net-value ranking with a user gold price** is the right model for gold (not raw output, not
     a fixed velocity ratio).
  3. **CurrencyPicker** is the reusable searchable currency input — use it everywhere a currency
     is chosen. Matches aesthetic via `cmdk-*` classes + gold focus rings.
  4. **React.memo panels on the Arbitrage page** so the SSE route stream doesn't re-render/flicker
     them.

## Phase 1.5 — Gold-value slider (IN PROGRESS, task #59)
- **Setting**: `gold_value_per_1k` (Divine per 1k gold), **user data** — add to `settings.py`
  defaults + classify user-kv in `db.py`; PUT via existing `/api/settings`.
- **UI (DONE)**: slider in the Arbitrage rail (`GoldValueSlider.jsx`). Divine-icon thumb; label
  leads with the whole-number metric **"1 ◈ = N gold"** (humans don't parse decimals); **range
  gold-per-Divine 20k → 10M** (log) → `gold_value_per_1k ∈ [0.0001, 0.05]` (gv = 1000/gold_per_div);
  default **0.01 (1 ◈ ≈ 100k gold)**; "gold precious / gold cheap" end labels; description text
  omitted (self-explanatory). Debounced persist + route re-rank.
- **Feeds (DONE)**: Convert net-value ranking AND **Arbitrage velocity**. Final velocity model
  (`arbitrage._velocity`): **net of gold, then per-1k-gold** —
  `net = margin_ref − gold × price; velocity = net / fill_hours / gold × 1000`, where
  `price = gold_value_per_1k × ref[divine] / 1000`. Subtracting gold's value is what makes the
  slider actually reorder (a pure divisor was a rank-invariant scalar); the ÷gold keeps
  gold-efficiency weighting. Nuance: reorders routes with differing `fill_hours` (continuous, so
  ~always) and sinks negative-net loops; identical-fh routes see price as a uniform offset. Match the app aesthetic; a style guide is future work.

## Phase 2 — Ghost Wealth / "can I cash out?" (TODO) — KEEP/DECIDE, NO sidecar
Realizable-vs-paper value: price sites show a number, not whether the market absorbs your stack.
- **Algorithm**: `liquidity.realizable()` (shared core) per held currency; `ghost = paper −
  realizable`; slippage + fill-hours. Reuse `db.get_capital`, `ref_values`, `orderbook`, `digest`.
- **Endpoints**: extend `GET /api/capital` (rows gain `realizable_ref, slippage_pct, fill_hours,
  source`; totals gain `realizable_total_ref, ghost_ref`). Optional `GET /api/cashout?...` for the
  CardDetail zoom.
- **UI (enrichment, no page)**: a "Realizable" column + `Total · realizable (👻 ghost)` footer on
  `CapitalCard`; a "Cash out" section in `CardDetail` (reuse `.cd-grid`/`.cd-stat`).
- **Tests**: deep book ≈ paper; thin book → ghost>0; digest-only low-confidence; poe2scout-only →
  null; `/api/capital` back-compat.

## Phase 3 — Timing / league-arc (✅ DONE) — TIME, uses SIDECAR (DTW)
Where you are on the league's price arc + good buy/sell windows, DTW-weighted toward the past
league the current run resembles.
- **Algorithm**: `holdscore._predict` gained a `weights=None` arg — a `{league: weight}` map that
  REPLACES `GAMMA**rank` recency; fully backward-compatible, and if the weights cover no league
  with data (`sum ≤ 0`) it falls back to recency, so a dead sidecar degrades to today's numbers.
  The sidecar's `arc` job (`sidecar/analytics/arc.py`, `dtaidistance` DTW) z-normalizes each
  league's Divine-in-Exalted inflation arc (`marketseries.league_signatures`), DTW-compares the
  current partial arc to each past league over the same elapsed phase, and writes a softmax weight
  vector. `leaguearc.project` turns the item's series + past leagues into a history + forward band +
  buy/sell windows (peak = sell, trough = buy); `holdscore.build_context` is the shared
  league-builder for Hold + arc so they can't drift on which league is "current".
- **Endpoints**: `GET /api/arc?item=&numeraire=` → `{league, item, item_id, numeraire,
  numeraire_name, resembles, weighted, cur_age, history:[{age,price}], arc:[{age,pred_pct,lo_pct,
  hi_pct,price}], windows:[{kind:'buy'|'sell', age, ret_pct}]}` (reads `analytics_cache` kind
  `arc`, projects inline; recency fallback when the sidecar is idle). `GET /api/leaguearc` →
  `{league, day, phase, resembles, weighted}` (league-level anchor, no item). Hold's `pred_pct`
  silently becomes DTW-weighted and the board carries `pred_weighted: bool`.
- **UI (enrichment, NO new tab)**: `components/LeagueArc.jsx` — a "League arc" section in
  `CardDetail` overlaying the projected gold band + dashed projection + "you are here at day N" on
  its own `ArcSpark`; a "resembles <league>" line; buy/sell window chips. A topbar `day N · phase`
  chip (`arc-chip`) polls `/api/leaguearc`. Hold's column is DTW-weighted with zero new UI.
- **Cache contract**: kind `arc`, fixed key `"current"`, value `{league, weights:{lg:w}, resembles}`.
- **Tests**: `test_arc.py` (DTW shape-not-level, short-signal degrade, signature reader),
  `test_leaguearc.py` (weights override recency + backward-compat + miss→fallback, project
  history/band/windows, phase thresholds), `test_sidecar_runner.py::…arc…`, `test_signals_api.py`.

## Phase 4 — What's about to move (✅ DONE) — TIME, uses SIDECAR + notification inbox
Spot an item starting to pump/crash early — a market-signal inbox distinct from the live trade-ping
orb. (The `mlxtend` "X moves → Y follows" association-rule variant stays deferred — not needed to
ship the inbox, and it would bloat the sidecar binary; the volume-confirmed discord is enough.)
- **Algorithm** (sidecar, from Phase 6): matrix-profile **discords** (`STUMPY`, `normalize=False`,
  short motif `m=3`) over each liquid item, **volume-confirmed** (MAD-z on volume — the piece Movers
  lacks) and RECENT. The 2h analytics loop enqueues a `discords` refresh for the on-screen league.
- **Endpoints**: `GET /api/signals` → `{league, signals:[{item_id, name, t, mp_dist, vol_z, close,
  acked}], unseen}` (annotates + self-prunes acks not in the live set; never fails a request).
  `POST /api/signals/ack` body `{keys?:[…], all?:bool}` → `{ok, unseen}` (dismissals are USER data →
  `signals_ack` in `_USER_KV`). Signal identity = `"item_id:t"` (`app/signalsack.py`, pure helpers).
- **UI (inbox, reuse the pattern — SEPARATE store)**: a **Divine orb** (`DivinePingOrb.jsx`) in the
  topbar — the wealth/economy counterpart to the red Vaal trade-ping orb — badges the unseen count
  and opens a small inbox popover. A row fires the shared `useAssetModal().open(name)` → the SAME
  `CardDetail`, which gains a "⚡ Signal" section (why it fired: vol_z, mp_dist, close). Backed by
  `lib/signalStore.js` (zustand, server-sourced/persistent), NOT `pingStore` — market signals have a
  different lifecycle (persistent + ack'd) than ephemeral live-search pings. NAME is the join key
  across the UI (signal carries a numeric `item_id`; CardDetail rows carry a currency id).
- **Tests**: `test_signalsack.py` (key/annotate/merge-idempotent/prune), `test_signals_api.py`
  (endpoint degrade + ack round-trip); discord math in `test_discords.py` (Phase 6).

## Phase 5 — Centrality (✅ DONE) — connective tissue, stdlib, NO page/sidecar
`backend/app/centrality.py`: **PageRank** (power iteration) + **betweenness-lite** (reuses
`Graph.iter_paths` — the route-search DFS — bounded to the top-K currencies), over the exchange
graph weighted by executed value/hour (`e.vol_in_per_h * ref_value[src]` — the measure `board()`
uses). `scores()` is version/TTL-cached like `board()`. Not networkx (must stay always-available).

**Consumers wired:** Convert **bridge tie-break** (`_best_conversions(..., bridge=…)` — a final tie
term = mean betweenness of intermediate nodes, only decides genuine ties); Board **hub chip**
(`board()` rows gain `hub: bool` = top-N PageRank → a rare gold ⬢ glyph beside the name + a
`hub` stat in `CardDetail`); Phase-4 priors read `centrality.scores()`. No new endpoint, DB,
snapshot, or sidecar (computed live from the in-memory graph). Tests: `backend/tests/test_centrality.py`.
Drive-validated on web + desktop: hubs resolve to divine/chaos/mirror (economically correct).

## Phase 6 — Sidecar runtime (✅ DONE) — enables 3 & 4
A second bundled-per-platform PyInstaller binary (`numpy/stumpy/dtaidistance`) that hosts heavy
analytics off the lean backend. Spawned + supervised by the BACKEND as a child (supervision tree
Electron→backend→sidecar). Transport = **SQLite, no network**.

**Built:**
- **Transport** `backend/app/analytics.py` — stdlib-only, **connection-injected** so BOTH the
  backend (`db._conn()`, tables via ATTACHed `market`) and the lean sidecar (own `market.sqlite`
  conn) share it with no boot side effects. `enqueue` (coalescing) / `claim` (lock-free pre-check
  then BEGIN IMMEDIATE + state guard = single-pass, exactly-once, oldest-of-any-kind — the sidecar
  dispatches by kind itself) / `complete` (upsert cache + mark done) / `fail` / `read_cache` /
  `prune_jobs`. Every read returns a benign default (endpoints never fail).
  **Hand-rolled** the ~4 tiny queue ops rather than add a SQLite-queue lib to two PyInstaller
  binaries (evaluated litequeue/huey — not worth the bundling risk for a single consumer).
- **Tables** (market side, in `MARKET_SCHEMA`): `analytics_jobs` (control) + `analytics_cache`
  (results). Additive, empty, RUNTIME-only → **NOT in the exported snapshot** (exporter builds
  from its own list) and **self-healed** by the boot `executescript(MARKET_SCHEMA)` after seeding,
  so **NO snapshot rebuild is needed** (the snapshot's data is unchanged).
- **Shared series** `backend/app/marketseries.py` — stdlib-only reader (`league_daily`→per-item
  series); `movers._current_series` delegates; the sidecar reuses it (the backend picks the league,
  since only it has the user setting, and passes it in the job params).
- **First job** `backend/sidecar/analytics/discords.py` — STUMPY matrix-profile discords,
  **volume-confirmed** (MAD-z on units = value/close, NOT value, so a price spike alone can't
  self-confirm) + liquidity floor + recency gate. `vol_z` MAD-floored & clamped (±50) so a
  near-constant series can't explode the score. **SHORT-HORIZON tuned** (owner steer: PoE leagues
  are short-lived, the metric must work early): `normalize=False` (the DEFAULT z-normalized profile
  finds unusual *shapes* and normalizes magnitude away — it missed a planted 3× spike; non-normalized
  lands the discord on the magnitude dislocation, the actual pump/crash) · short motif `m=3`
  (signals from ~7 days, vs 9+ with m=4) · modest `vol_z≥2.5` floor because MAD-z is statistically
  compressed with few points (calibrated to real ~11-day data where clear standouts sat at 2.5–2.8,
  not 3+). It's a ranked shortlist (by vol_z, top_n=20), not a binary alarm. Higher-res (hourly
  digest) input is the bigger short-horizon lever — a Phase-4 consideration.
- **Runtime** `backend/sidecar/{run_sidecar,runner}.py` — own plain `market.sqlite` conn (never
  imports app.db), poll→claim→dispatch→write, idle backoff, unknown-kind → error (never wedges).
- **Watchdog** `backend/app/watchdog.py` — stdlib, shared. Sidecar dies with backend via
  **stdin-EOF** (backend holds the pipe) + PARENT_PID poll. Backend **retrofit**: PARENT_PID poll
  only (no stdin-EOF), gated on `ARBITER_PARENT_PID` (Electron sets it; the web/server never does,
  so servers are unaffected) → fixes the dangling-backend-on-hard-Electron-crash bug.
- **Supervisor** `backend/app/sidecar_supervisor.py` — spawns (stdin PIPE + `ARBITER_PARENT_PID`),
  restarts w/ capped backoff, no-ops when no sidecar. Launch source: `SIDECAR_BIN` (bundled binary,
  Electron sets it) or `SIDECAR_FROM_SOURCE=1` (opt-in local dev). Started in `main.py` lifespan;
  `_analytics_loop` enqueues a discord refresh every 30 min for the resolved current league.
- **Endpoint** `GET /api/signals` — READ-only cache; empty when the sidecar is down/idle (graceful
  degrade). The Phase-4 inbox UI will consume it; for now it's the sidecar's read surface.
- **Build**: `desktop/build-sidecar.sh` (mirror of `build-backend.sh`) + Windows CI step +
  `sidecar-bin` extraResources + `main.js` resolves `SIDECAR_BIN`. **`--collect-all stumpy` is
  REQUIRED** (onefile has no source on disk for stumpy's njit-cache enumeration — the frozen binary
  FileNotFoundErrors on import without it). `backend/requirements-sidecar.txt` keeps the heavy deps
  out of the lean backend. Binary ≈ 73MB; **~34s numba JIT cold-start on first job** (fine — endpoints
  only read cache). **mlxtend deferred to Phase 4** (drags sklearn/pandas/matplotlib).

**Validated:** 21 new backend tests (transport, marketseries, discords incl. a short-league case,
watchdog, runner). Frozen production binaries drive-tested end-to-end: supervisor spawns the real
sidecar, it computes over a snapshot-seeded market.sqlite, writes cache, job→done; killing the
backend kills the sidecar (watchdog OK); `/api/signals` 200. On real ~11-day Forbidden Rites data
the metric surfaces a sensible shortlist (Deadly Fate, Her Declaration, …). Web: boots,
graceful-degrades (sidecar off), board/capital unregressed. **NOT shipped** — awaiting authorization.

> **Port-tests-first** still applies if Phase 3/4 VENDOR (rather than pip-install) any library code.

### Phase 6 plumbing reference — entry points, endpoints, contracts (Phase 3/4 build ON this)

**Processes / entry points**
- **Sidecar binary** `backend/sidecar/run_sidecar.py` → `runner.main()`. PyInstaller onefile
  `poe2arb-sidecar[.exe]` (numpy/stumpy, ~73 MB). Opens `market.sqlite` (RO reads + writes to the
  two analytics tables) via its OWN plain sqlite3 conn — it must NEVER `import app.db` (that boots
  the backend). Loop: `run_once(conn)` → `analytics.claim` → dispatch via `HANDLERS` → write cache;
  idle backoff ≤5 s; prunes every 50th job.
- **Backend** `app/main.py` lifespan starts it: `sidecar_supervisor.start()` (spawn + restart
  w/ backoff), `watchdog.guard(...)` (backend dies with Electron), and `_analytics_loop` (enqueues
  a `discords` refresh for the resolved current league every 2 h; `enqueue` coalesces).
- **Supervisor** `app/sidecar_supervisor.py`: `start()` / `stop()`. Spawns the sidecar with a
  held-open stdin pipe (EOF on backend death) + `ARBITER_PARENT_PID`.

**Env-var contracts** (set by Electron `desktop/src/main.js`, read by the backend/sidecar)
- `DATA_DIR` — dir holding `user.sqlite` + `market.sqlite` (existing).
- `MARKET_SEED` — bundled snapshot to seed `market.sqlite` (existing).
- `ARBITER_PARENT_PID` — backend's parent (Electron) pid → backend watchdog. Backend passes its own
  pid to the sidecar the same way. Absent on the web/server env ⇒ no watchdog (never self-kill a server).
- `SIDECAR_BIN` — path to the bundled sidecar binary (Electron passes the EXPECTED path even if
  missing, so the supervisor can WARN on a packaging regression). If set-and-missing ⇒ warn + no-op.
- `SIDECAR_FROM_SOURCE=1` — opt-in to run the sidecar from source with the current interpreter
  (local dev only; the web/Docker env sets neither var ⇒ supervisor no-ops, endpoints serve empty).

**HTTP endpoint** `GET /api/signals` → `{ "league": str|null, "signals": [ {item_id, name, t,
mp_dist, vol_z, close} ] }`. READ-ONLY over `analytics_cache`; never fails a request — if the
sidecar is down/idle it returns `signals: []` (and the resolved current league). This is the read
surface the Phase-4 inbox will consume.

**SQLite transport** (`app/analytics.py`, stdlib-only, connection-injected — pass `db._conn()` in
the backend or the sidecar's own conn):
- Tables (market side, `MARKET_SCHEMA`): `analytics_jobs(id,kind,params_json,state,enqueued_at,
  started_at,finished_at,error)` — control channel; `analytics_cache(kind,key,computed_at,
  value_json)` PK`(kind,key)` — results, sidecar is SOLE writer.
- API: `enqueue(conn, kind, params=None, coalesce=True) -> id` · `claim(conn) -> {id,kind,params}|None`
  (single-pass, oldest-of-any-kind, exactly-once) · `complete(conn, job_id, kind, key, value)`
  (upsert cache + mark done; `job_id=None` allowed) · `fail(conn, job_id, error)` ·
  `read_cache(conn, kind, key=None)` (value | list | None/[]) · `prune_jobs(conn, keep=200)`.
- **Cache-key contract**: one blob per kind under a **fixed key**, the varying dimension carried
  INSIDE the value — discords writes `key="current"`, value `{"league": L, "signals": [...]}`, and
  the reader reads `("discords","current")` (no league re-resolution → no write/read drift).

**Extension recipe (add a job kind, e.g. Phase 3 `arc`)**: (1) write a pure compute fn (sidecar,
its own module); (2) add a `handle_<kind>(conn, job)` that reads `job["params"]`, computes, and
`analytics.complete(conn, job["id"], "<kind>", "current", {..., "result": ...})`; (3) register it in
`runner.HANDLERS`; (4) enqueue from a backend loop/endpoint via `analytics.enqueue`; (5) add a
read-only endpoint that `read_cache(c, "<kind>", "current")`. No new tables, no snapshot bump. Heavy
libs go in `requirements-sidecar.txt` + get bundled by `build-sidecar.sh` / the Windows CI step.

## Suggested order (lightest-first)
1.5 slider → 5 centrality → 2 Ghost Wealth → 6 sidecar scaffold (+watchdog retrofit) → 3 arc →
4 signals. Each phase: `/tdd` (tests first), then drive-validate over CDP, web env first.

## Build & validate workflow (how to actually run/test this repo)
- **Backend tests**: `python3.12 -m venv .venv-test && source .venv-test/bin/activate && pip install
  -r backend/requirements.txt pytest`; run `DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest
  backend/tests/ -q`. Tests build a synthetic `arbitrage.Graph` (no DB needed) — see test_convert.py.
- **Drive the desktop app** (the ONLY way to prove UI/data — `docs/desktop-debugging.md`):
  `cd desktop && ./build-backend.sh` (needed when backend .py changed — dev runs the compiled
  binary), `npm run build:frontend` (when frontend changed), relaunch
  `npx electron . --remote-debugging-port=9222`, then `node scripts/cdp.mjs "<js>"` /
  `scripts/shot.mjs`. For a VISIBLE view (animations play), open the dev UI port (from the electron
  log) in a Chrome tab via the browser tools. The CDP automation tab freezes animations.
- **Deploy**: web to shazam (cheap iteration) first; desktop release per `docs/release-runbook.md`.
