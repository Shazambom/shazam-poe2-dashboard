# Trading Workspace roadmap — EE2 history, clipboard-add, QOL, Sales tab

> Feature spec for the next Trading-tab work. Successor to [`trading-rework-plan.md`](./trading-rework-plan.md)
> (PR1–PR7 shipped: Trading tab, workspace tree, live engine, pings, hotkey, teleport). Synthesized via `/arena`
> on 2026-09-16 (record at the end) and then settled with the owner over four rounds; **every decision below is
> final** — nothing is left open. Repo `/Users/ianmoreno/shazam-poe2-dashboard`; EE2 reference checkout
> `/Users/ianmoreno/Exiled-Exchange-2` (MIT, read-only). **Implemented and shipped — see the status block below.**
>
> Conventions: file:line references are to the repos as of 2026-09-16 and will drift — treat them as pointers,
> not addresses. Test-first (`/tdd`) per batch; every batch is gated by `ops/run-tests.sh` (which the deploy
> scripts run first) and driven over CDP per `docs/desktop-debugging.md`. Release mechanics are in
> `docs/release-runbook.md`, not here.

> **Status (2026-09-17, branch `dev`):** implemented end to end — Batch 0 (`11c7ce8`, `3375204`, `fce515a`),
> Batch 1 (`1273580`), zoom fix (`5b134a7`), Batch 2 (`14e5023`), Batch 3 (`b57f295`), Batch 4 (`97748b1`),
> Batch 5 (`d9cd789`), Batch 6 (`819a02f`). Every batch was driven on the local desktop app over CDP before
> its commit; shipped in 0.2.56 → 0.2.61 (betas first, then stable). Deviations from the text below, all
> deliberate: the vendored EE2 port is one esbuild bundle (not a per-module tree), two extra inert shims
> (`vue`, `@vueuse/core`) exist because EE2's `common.ts`/`RateLimiter.ts` import Vue, the pure deps are
> bundled from EE2's lockfile rather than added to `desktop/package.json`, and `sync-ee2.mjs --src` builds
> from a local checkout for development (releases use a GitHub tag; see `desktop/src/vendor/ee2-query/PROVENANCE.md`).
> Batch 5 skipped "market price beside a history row". Rarity colours became semantic tokens (`--rarity-*`).
> A dev-only IPC (`dev:ee2-item`, refused when packaged) feeds fixture items through the real consumer + worker.

## 1. The model in one paragraph

**The workspace tree is the only truth and the zustand store is its only writer.** Every new search arrives as
one `IngestIntent`, from one of three producers, and is applied by one store action, `ingest()`, which owns
naming, folder placement, dedupe, cap and expiry. The store's existing debounced autosave is the only thing
that ever PUTs `trading_workspace`; the backend validates and never mutates.

| producer | runs in | what it is |
|---|---|---|
| **capture** (exists today) | renderer, `trade:webview-nav` | you built a search in the embedded trade page; the URL is written into the *active* node (`WorkspaceView.jsx:140-160`). Unchanged: it mutates, it never creates. |
| **clipboard-add** (new) | renderer button → main classifies | a trade URL or an item's copied text is on the clipboard and you press ⎘ |
| **item stream** (new) | main, the EE2 integration package's `item-checked` event | you copied an item in game — by an EE2 price-check hotkey **or** a plain Ctrl+C; both look the same to us |

Second axis: **URL-first, zero network.** Arbiter never runs a trade query itself. From copied item text it
builds the exact search EE2 would build (a vendored copy of EE2's own code) and stores the query on the node.
Opening the node loads `…/trade2/search/poe2/<league>?q=<query>` in the embedded page — EE2's own link form —
and the trade site does the POST. No page refresh, no API call, ever, to build history.

## 2. Decisions (final)

**History folder**
- The folder is named **"ExiledExchange2 History"** — that name, nothing appended, no explanatory note. It is
  identified by `sys:'ee2-history'`, not by name; created at the top of the root on the first captured item,
  never on launch; if the user deletes it, the next item recreates it.
- **Every copied item** becomes a row: EE2 price checks and plain Ctrl+C alike. A locked/advanced EE2 check
  is just another check. **Items only** — currency and stackables (anything EE2 would route to bulk exchange)
  are skipped; the rest of the app is the currency tool.
- New rows just appear at the top of the list. Nothing auto-opens or auto-selects.
- A row **never keeps a search id**: it always opens by recalculating from its stored query. Rows are never
  armable for live search and never appear in the Live tab.
- **Same query again** → the old row is silently removed and the new one goes on top. No badge, no count.
- **Cap 200** rows; **expiry 14 days**. Nothing inside the folder is protected — renaming or marking a row
  does not keep it. **The only way to keep a row is to drag it out** into a curated folder; it is then an
  ordinary search (the capture path gives it a search id on its next open, it can go live, and it is outside
  the cap and the expiry).
- **League:** switching league is a clean slate for history. Each row records the app's league at capture;
  the folder shows only the current league's rows; other leagues' rows stay hidden until they expire. Curated
  folders carry across leagues untouched. **Every trade pane opens in the top-bar league, always.**
- A query that cannot be built (a base the vendored data does not know) becomes a **⚠ row** that opens the
  trade home, so the history stays complete.
- **On/off** is one styleguide `<Toggle>` slider, reachable in the workspace rail head and mirrored in
  Settings; both write the same setting. Off pauses recording and deletes nothing.
- **Clear history** is one action reachable from the folder row, its context menu, ⌘K and Settings; undoable.
- Export excludes history.

**The EE2 port**
- EE2's parser + filter builders + search-request builder (MIT) are vendored as a Node library and run in a
  separate process — never in the renderer, never synchronously in main. Only the *search* path is vendored;
  the bulk/exchange builder is not.
- **Data is packaged** (~2.6 MB). Reading EE2's installed copy was rejected: it couples our pinned parser to
  whatever data version the user's EE2 has, fails silently on mismatch, and the index tables would have to be
  rebuilt on the user's machine.
- **Sync is fully automated and runs on every release** inside `desktop/publish-github.sh`: resolve EE2's
  latest release, rebuild the vendored code and data, snapshot GGG's live item/stat data for the parser's
  fallbacks, regenerate the parity goldens from EE2's own code, and abort the release on any parity failure.
  Nobody thinks about it per release.
- **Warm-up:** at startup, if EE2 is detected *running*, the builder process is warmed 15 s after launch and
  kept warm; otherwise it starts on the first copied item.

**Everything else**
- Clipboard-add accepts trade **search** links (id form and `?q=` form) and item text. **Exchange links are
  rejected** with a toast.
- Rail rows (searches and folders) are drag-and-droppable to organize; that is the "keep this" gesture too.
- Web is a dev environment only; no feature parity is owed. Desktop is the product.
- Telemetry lines are permanent beta-channel diagnostics.
- The zoom bug is a **separate bug fix**, shipped on its own, not part of this feature set (§10).
- **Sales tab:** a new Trading → **Sales** sub-tab renders the trade site's Merchant History in Arbiter's UI
  and keeps a local ledger **forever**; refresh every **10 min** while visible; defaults to the top-bar league
  but any league the ledger holds is browsable — Arbiter only stores what it fetched and serves it.
- **Client.txt:** build the parser as dormant infrastructure, unwired, disabled, marked "reserved for future
  work". Nothing planned uses it.
- Own-listing marking via EE2's account name: dropped (over-engineering).

## 3. Grounding facts (verified in both repos; they shape the design)

### Arbiter

- **One writer.** `frontend/src/lib/workspaceStore.js:18-27` debounces every mutation 700 ms into
  `api.putWorkspace(...)`; the `armed` flag (`:16`, `:82`) suppresses the PUT during hydrate.
  `backend/app/main.py:395-401` validates only `version == 2` and `tree` is a list; `datapolicy.py:12-21`
  classifies `trading_workspace` as user data (user.sqlite, migrated, backed up).
- **Data-loss bug, latent today, live tomorrow.** `loadWorkspace()` (`workspaceStore.js:140-147`) catches any
  load error and hydrates `{version:2, tree:[]}`, which arms persist on the next tick (`:82`); the next
  mutation PUTs an empty tree over the user's real document. Today a human must edit after a failed load; an
  unattended producer removes that step. **Fixed first, alone, before any producer exists (§4, item 1).**
- **`parseTradeUrl()` cannot handle `?q=` URLs.** `session.js:46`'s regex runs over the whole string; a JSON
  containing `/` yields a garbage slug, otherwise `null`. A query-only node is not representable in today's
  `{type,slug,live}` shape: it needs a `q` field, `mountUrl` (`WorkspaceView.jsx:121-124`) needs a third
  branch, and the parser must look at the pathname only.
- `searchNode()` (`workspaceStore.js:52-59`) is
  `{ id:'n_'+uid(), kind:'search', name, auto:true, type, slug, live, done:false, armed:false, notify:{sound,orb,os} }`;
  `newFolder()` (`:49-51`) is `{ id, kind:'folder', name, open:true, children:[] }`. `addFolder` always appends
  at root (`:85-91`); `addSearch` always appends (`:92-98`). Nothing prepends.
- **The league never lives on a node** (`workspaceStore.js:10-12`, `session.js:37-40`): injected at open time.
  EE2's `?q=` body carries no league either (it is in the path). The two invariants agree.
- `readSearchName()` (`WorkspaceView.jsx:46-84`) scrapes the trade page's DOM with English labels on every
  capture unless `n.auto === false` (`:158`). `ensureInstantBuyout()` (`:25-42`) dispatches synthetic mousedowns
  on every `dom-ready`, 6 × 900 ms, failing silently; forcing it would rewrite a query EE2 built.
- `navState.loading` is never set true (`WorkspaceView.jsx:100,144`); main forwards only `did-navigate` /
  `did-navigate-in-page` (`main.js:574-576`) on **one channel fired by any webview**, including the
  `open-trade` pop-out (`main.js:350-355`). `findBySlug` (`WorkspaceView.jsx:14-20`) is the only guard.
- `App.jsx:188` `<TradingView key={league} …/>` remounts the tab on league change, destroying the `<webview>`
  that `TradingView.jsx:24` deliberately keeps mounted.
- **The renderer has no telemetry path and no clipboard path.** `installLog()` (`telemetry.js:23-31`) is
  main-only, gated by `diagTelemetryOn()` (`main.js:73-76`); `preload.js:8-48` exposes neither. Clipboard reads
  happen only inside the EE2 package; the renderer only ever writes.
- `dev-ee2-telemetry.js:16-17` prefixes `v<appVersion>` and `telemetry.js:26` prefixes it again: every
  existing `p=ee2` line reads `v0.2.55-beta.2 darwin v0.2.55-beta.2 …`. Free fix.
- **EE2 package contract** (`desktop/src/integrations/exiled-exchange/CLAUDE.md`): no settings toggle gating
  *the package*; local only; passive; original code only inside it. Its README's "Adding an actions layer
  later" (`README.md:101-109`) is the hook this roadmap uses; consumers attach at `main.js:495-509`.
- The package emits `item-checked {name, baseType, rarity, itemClass, corrupted, unidentified, mirrored, raw,
  ts, origin}` (`index.js:188-199`), `origin:'ee2'` when an EE2 hotkey fired within 700 ms, else `'clipboard'`;
  it dedupes identical `raw` within 1500 ms. Without uiohook (macOS Accessibility withheld) it polls the
  clipboard at 90 ms and every capture is `origin:'clipboard'` — which no longer matters, since both origins
  are recorded. `ee2-config.js:52-54` exports `loadConfig()`; `watchConfig()` (`:111-128`) re-fires on EE2's
  tmp+rename writes. `detectEE2()` (`detect.js:69-81`) reports `{present, method, dir, config, running}`.
- `log-watcher.js` is a complete PoE2 `Client.txt` tailer that nothing consumes. `server-watcher.js` (EE2
  `GET /config` probe) is likewise unwired and documents why EE2's `/events` websocket must never be joined
  (every connection becomes EE2's `lastActiveClient` and diverts its price-check results).
- Tests gate deploys: `ops/run-tests.sh` (pytest, `node --test frontend/test/`,
  `node frontend/test/workspace-store.fuzzy.mjs`, `node --test desktop/test/`, style lint) runs at the top of
  `ops/deploy-web.sh` and `desktop/publish-github.sh`.
- Dead persisted fields: `layout`, `openTabs`, per-node `notify`, per-node `done` (`done` has a rendering,
  `SearchTree.jsx:17` + `styles.css:182`, and no toggle). This roadmap spends `done` and `layout`.

### EE2 (reference only)

- **The entry point is `createPresets(item, opts)`** (`renderer/src/web/price-check/filters/create-presets.ts:14-114`)
  → the *active* preset → `createTradeRequest(preset.filters, preset.stats, item)`
  (`trade/pathofexile-trade.ts:567`). Uniques, logbooks and craftables take different preset branches, so
  `createFilters` alone is not enough.
- `opts` as `CheckedItem.vue:159-179` passes them:
  `{ league, collapseListings, activateStockFilter, searchStatRange, useEn, currency, listingType, defaultAllSelected }`,
  `useEn = (language === "cmn-Hant" && realm === "pc-ggg") || preferredTradeSite === "www"`
  (`CheckedItem.vue:165-168`). `currency`/`listingType` are in-memory carry-overs from the previous popup when
  `rememberCurrency`/`rememberListingType` are on; the port has no previous popup and passes `undefined`.
  **Parity therefore means "EE2's query for this item on a cold start"**, and goldens are generated that way.
- Search vs bulk: `apiToSatisfySearch(item, stats, filters)` (`trade/common.ts:26-45`) → `"trade" | "bulk"`.
  We only ever use the `"trade"` branch.
- Link form (`TradeListing.vue:206-207`, `CheckedItem.vue:356`):
  `` `https://${getTradeEndpoint()}/trade2/search/poe2/${league}?q=${JSON.stringify(createTradeRequest(...))}` ``.
  `getTradeEndpoint` is `poeWebApi()` re-exported (`trade/common.ts:7`), defined at `Config.ts:92-117`
  (`www.pathofexile.com` for `en`/`pc-ggg`). EE2 interpolates the league raw; `poe2` is a literal.
- **Network-backed fallbacks in the parser.** `TRADE_ITEM_BY_REF` (`Parser.ts:340`, `magic-name.ts:30`) and
  `TRADE_STAT_BY_MATCH_STR` (`stat-translations.ts:341`) are populated by `loadTradeData()`
  (`assets/data/index.ts:517-519`) from `www.pathofexile.com/api/trade2/data/{items,stats}`
  (`background/TradeData.ts:52-54`). Unfed, an unknown item yields `err("item.unknown")` (`Parser.ts:346-348`).
  We feed them from a release-time snapshot instead.
- **The data set is more than four files.** `assets/data/index.ts:165-236` also loads
  `items-{name,ref}.index.bin` and `stats-{ref,matcher}.index.bin`, build artifacts of
  `renderer/src/assets/make-index-files.mjs`. The sync must run that generator or the loader will not load.
  `item-drop.json`/`patrons.json` (`:289-292`) are not on the query path.
- Non-relative deps of the TS set: `dot-prop`, `luxon`, `neverthrow`, `@sindresorhus/fnv1a`; EE2 modules
  `@/web/Config` (9 `AppConfig` sites across 7 files), `@/web/background/IPC`, `@/web/background/Prices`,
  `@/assets/data`. No `vue` import. `performance.mark` at `create-item-filters.ts:44` (Node has it).
- **EE2 ships the golden harness we need**: `renderer/specs/vitest.setup.ts` mocks `AppConfig`, the
  client-string loader and `fetch`; `specs/Parser/example.test.ts:12-15` is `setupTests(); await init("en")`.
- EE2 config: `<userData>/apt-data/config.json` (`main/src/host-files/ConfigStore.ts:9-12`; macOS
  `~/Library/Application Support/exiled-exchange-2/apt-data/config.json`, Windows
  `%APPDATA%\exiled-exchange-2\apt-data\config.json`). `Config.ts:128-157`; price-check widget
  `overlay/widgets.ts:38-64`.
- **The trade site's Merchant History** (`https://www.pathofexile.com/trade2/history`, researched read-only
  2026-09-16): one XHR `GET /api/trade2/history/poe2/<league>` returns
  `{ result: [ { time, item_id, item: {…full trade item JSON…}, price: {amount, currency} } ] }`, newest first,
  a fixed recent window with **no paging** (`?page=2` returned the same rows), only `Sold:` rows observed.
  `item` carries `icon, name, typeLine, baseType, rarity, frameType, ilvl, identified, w, h,
  properties[{name, values:[[text, mode]], displayMode, type}], requirements[…], explicitMods[{description}]`
  (plus implicit/enchant/rune blocks on other items). Clicking a row draws the item card from that JSON with no
  further request. **Five quick GETs produced a 429**: the endpoint is under GGG's trade rate policy.

## 4. Cross-cutting design (read once)

1. **One intent, one store action.** `IngestIntent` (shape in §5) is built where the evidence is (main for the
   item stream and for clipboard classification) and always applied by `ingest()`. Nothing else inserts nodes.
2. **`q` is a string, never re-serialized; the league is never stored for opening.** `q` is the exact
   `JSON.stringify` bytes EE2 puts after `?q=`, so goldens are byte comparisons. `queryUrl({q}, league)` injects
   the top-bar league at open time exactly like `tradeUrl()`. A row's `league` field is a display filter only.
3. **The builder runs in an Electron `utilityProcess`** (`desktop/src/ee2-history/worker.js`): off the UI
   thread, off main's event loop, crash-isolated, with a `--stdin` CLI mode so the port is testable without
   Electron. Warmed at startup when EE2 is running, otherwise started on first use and exited after 10 idle
   minutes. If it dies, the next request restarts it (at most once per 5 minutes); the request in flight is
   reported as a skip.
4. **The port's seam** is `parseClipboard → createPresets → active preset → apiToSatisfySearch →
   createTradeRequest`. Nothing above it is ported. The `AppConfig` touch points become a `Prefs` record.
   Parity is proven by goldens generated from EE2's own code, never by reading the port back.
5. **Zero network at runtime.** The parser's live-data fallbacks read a snapshot bundled at release time.
6. **Ingested rows are born `auto:false`** — they carry EE2's parsed name and the DOM scraper must never
   overwrite it. The capture path also skips `ensureInstantBuyout()` for `q`-mounted nodes (the query already
   carries `status.option`) and never writes a slug into a node inside the history folder.
7. **Clipboard text never crosses into the renderer.** Main classifies and returns only the parsed result.
   One human click per read; no clipboard watching outside the EE2 package.
8. **Backend validates, never truncates.** Size/node/depth guards return 413/400 with a specific detail; the
   store's `sanitize()` keeps every PUT inside the limits, so a rejection means a bug.
9. **One telemetry sender, one narrow renderer bridge.** `poe2desktop.diag.log(marker, line)` →
   `ipcMain.handle('diag:log')` → `installLog`, marker allow-list `ee2 | ws | sales`, 300-char clamp,
   30 lines/min, same `diagTelemetryOn()` gate. Names, labels, counts and byte lengths only — never `q`, never
   raw clipboard, never a full slug. The bridge ships one desktop cut before the feature it verifies.
10. **Desktop is the product.** The item stream, clipboard-add and the Sales tab exist only when
    `window.poe2desktop` exposes them, exactly as the live engine is gated on `hasTradeEngine()`
    (`session.js:11`). On web those controls are absent; store-level logic still runs there for cheap tests.

## 5. Shapes and contracts

**Search node** (superset of today's; every new field optional, so old documents load unchanged):

```jsonc
{
  "id": "n_k3f9a2x", "kind": "search",
  "name": "Headhunter Heavy Belt",
  "auto": false,                 // ingested rows: never auto-renamed by the DOM scraper
  "type": "search",              // always "search" for ingested rows
  "slug": "",                    // history rows: always ''. Clipboard/promoted rows: filled by capture on first open
  "q": "{\"query\":{\"status\":{\"option\":\"securable\"},\"name\":\"Headhunter\",\"type\":\"Heavy Belt\",\"stats\":[{\"type\":\"and\",\"filters\":[]}],\"filters\":{}},\"sort\":{\"price\":\"asc\"}}",
  "live": false, "done": false, "armed": false,
  "notify": { "sound": true, "orb": true, "os": true },
  // new
  "origin": "ee2",               // "ee2" | "clipboard"  (the package's attribution; chip only)
  "ts": 1758013456789,           // ms epoch at ingest — ordering, dedupe age, cap, expiry, "12m ago"
  "league": "Forbidden Rites",   // history rows only: the app's league at ingest — folder display filter
  "degraded": false,             // true when q is null (query could not be built)
  "item": { "name":"Headhunter", "baseType":"Heavy Belt", "rarity":"Unique", "itemClass":"Belts" }
}
```

**History folder:** `{ "id":"n_h1st0ry", "kind":"folder", "sys":"ee2-history", "name":"ExiledExchange2 History", "open":true, "children":[…newest first…] }`.

**`IngestIntent`** — the payload of `trade:ingest` (main → renderer) and the argument of `ingest()`:

```jsonc
{
  "id": "i_1758013456789_3",     // echoed in the ack so main can log the outcome
  "source": "ee2",               // "ee2" | "clipboard"   (ee2 = the item stream, any origin)
  "origin": "ee2",               // the package's attribution, passed through
  "q": "{…}",                    // null when degraded
  "degraded": false, "stage": null,   // stage ∈ parse | presets | request when degraded
  "name": "Headhunter Heavy Belt",
  "item": { "name":"Headhunter", "baseType":"Heavy Belt", "rarity":"Unique", "itemClass":"Belts" },
  "folder": "ee2-history",       // sys key of the target folder, or null = the user's selected folder
  "cfgLeague": "Forbidden Rites",// EE2's configured league — telemetry only (league-match)
  "buildMs": 38, "ts": 1758013456789
}
```
`league` (the app's league) is stamped by the store at ingest, not carried on the intent.

**`Prefs`** — the fields the vendored code actually consumes, read from EE2's config by
`desktop/src/ee2-history/prefs.js` via the package's `loadConfig()`; missing values fall back to EE2's own
`defaultConfig()` values mirrored in the shim:

```jsonc
{ "leagueId": "Forbidden Rites", "language": "en", "realm": "pc-ggg", "preferredTradeSite": "default",
  "host": "www.pathofexile.com",   // derived: poeWebApi() (Config.ts:92-117)
  "useEn": false,                  // derived: CheckedItem.vue:165-168
  "searchStatRange": 10, "defaultAllSelected": false, "activateStockFilter": false,
  "collapseListings": "api", "savedAugments": {} }
```
Not read: `rememberCurrency`/`rememberListingType` (cold start passes `undefined`), `smartInitialSearch`/
`lockedInitialSearch` (they only gate EE2's auto-run), `coreCurrency` (bulk only), `accountName`.

**Clipboard classification** (`clipboard:classify`; the text itself is never returned):

```jsonc
{ "kind":"trade-url", "parsed":{ "slug":"H4sIAAAA…", "live":false } }   // …/trade2/search/…/<id>
{ "kind":"query-url", "parsed":{ "q":"<string>" } }                       // …/trade2/search/…?q=…
{ "kind":"item",      "intent":{ /* IngestIntent, source:"clipboard", folder:null */ } }
{ "kind":"exchange" }                                                     // any …/trade2/exchange/… link → rejected
{ "kind":"none", "len": 57 }
```

**IPC additions:**

| channel | dir | batch | payload |
|---|---|---|---|
| `diag:log` | R→M invoke | 1 | `{ marker, line }` → `true|false` (dropped) |
| `clipboard:classify` | R→M invoke | 1 | `{}` → classification above |
| `ws:flush` | M→R | 1 | sent on `before-quit`; the renderer flushes the pending autosave |
| `trade:webview-nav` | M→R | 1 | **changed** to `{ url, wcId, phase:'nav'|'start'|'stop' }` (was a bare url) |
| `trade:ingest` | M→R | 3 | `IngestIntent` |
| `trade:ingest-ack` | R→M | 3 | `{ id, result:'added'|'bumped'|'degraded'|'dropped', reason? }` |
| `ee2:set-enabled` | R→M | 3 | `{ enabled }` — lets main skip builds when off |
| `ee2:status` | R→M invoke | 3 | `{ present, running, configRead, leagueId, warm }` for the Settings status line |

**Backend additions:** `validate_workspace()` guards (batch 0); `settings.ee2History` defaults (batch 3);
user migration 5 + `POST /api/sales/ingest`, `GET /api/sales?league=` (batch 6).

**Telemetry lines** (auto-prefixed `v<version> <platform>`):

```
# marker ee2
warm ms=1842 items=13407 stats=4991                # builder process ready
history-attached cfg=ok|default league="…"        # consumer attached; whether EE2's config was readable
history-build origin=ee2|clipboard rarity=Unique name="…" ms=38 qb=812      # qb = byte length of q
history-skip reason=currency|disabled|timeout|worker origin=…
history-degraded stage=parse|presets|request name="…"
history-add name="…" total=37 league-match=1
history-bump name="…" age=3600000                  # same query again: old row removed, new on top
history-cap pruned=1 total=200
history-expire n=3 oldest=15d
history-clear n=37
history-open age=12m
ingest-drop reason=load-error|no-window
clipboard-add result=ok|empty|invalid|exchange|dup src=url|query-url|item
# marker ws
ws-load fail err="…"   ws-save fail err="413 …"   ws-undo n=3   ws-flush-on-quit ok|timeout
# marker sales
sales-fetch status=200|429 n=8   sales-ingest new=2 total=137   sales-open
```

## 6. Batch 0 — Stop the data loss, then the workspace QOL core (no desktop cut)

**Goal.** Make the workspace safe to write to automatically and pleasant to use before any producer exists.

**Files.** `frontend/src/lib/{workspaceStore,tree(new)}.js`,
`frontend/src/components/{WorkspaceView,SearchTree,LiveView,CommandPalette,ContextMenu(new)}.jsx`,
`frontend/src/App.jsx`, `frontend/src/styles.css`, `backend/app/main.py`, `backend/app/workspace.py` (new).

1. **Load failure must not arm persist** — own commit, first. On `catch`, `loadWorkspace()` sets
   `{ loaded:true, loadError:<message>, tree:[] }` and leaves `armed === false`; `WorkspaceView` shows a
   blocking banner "Couldn't load your searches · Retry" instead of the tree; every mutation, including
   `ingest()`, is refused while `loadError` is set.
2. **Save state + flush.** `persist()` exposes `saveState: 'idle'|'dirty'|'saving'|'error'` (a 6 px dot in the
   rail head) and `flush()`, which cancels the debounce and PUTs now; called on `pagehide`/hidden and on
   `ws:flush` from main's `before-quit` (batch 1 wires the IPC).
3. **Undo delete.** `remove()` returns `{node, parentId, index}`; toast "Deleted "X" · Undo" for 10 s via the
   existing bus (`api.js` `bus.emit({id, node, ttl})`); restore is `move()`-shaped. Folders with children get an
   inline two-step confirm (never `window.confirm`).
4. **Drop `key={league}`** on `<TradingView>` (`App.jsx:188`); `mountUrl` already depends on `league`.
5. **Remove the module-level `ui` object** (`WorkspaceView.jsx:11,109-114`) → `useCallback`s.
6. **One tree walker.** `lib/tree.js` `{find, findWhere, flatten, mapNode, removeNode}`; `findBySlug`,
   `flattenSearches`, `liveWiring.walk` and the store's `findNode` become one-liners.
7. **Discoverability + a11y.** `aria-label` on every icon button; controls visible on `:focus-within` as well
   as hover; a **right-click context menu** (`ContextMenu.jsx`): Open · Open in browser · Copy link · Rename
   (F2) · Duplicate · Mark done · Move to ▸ · Delete (⌫). Keyboard: ↑↓ move, →← fold, Enter open, F2, ⌫
   (with undo), ⌘N new search, ⌘⇧N new group — scoped to the row container. **Drag-and-drop made obvious**:
   a drag handle on hover and a drop highlight on folders (react-arborist DnD already exists, `SearchTree.jsx:53-58`).
8. **Filter box** above the tree: filters `name` and `item.name` case-insensitively via react-arborist
   `searchTerm`/`searchMatch`; folders auto-expand on match; Esc clears.
9. **⌘K commands:** New search, New group, Add from clipboard, Clear EE2 history, Toggle rail, and one
   "Open search: <name>" per node (hint = folder path).
10. **Spend the dead fields.** `done`: a ✓ in the trailing controls and the context menu (the strikethrough
    already ships). `layout`: `{ railWidth: 280, collapsed: false }` — the divider becomes a drag handle
    (220–420 px, rAF-throttled, persisted on mouseup) and a toggle with `aria-expanded`.
11. **Header bar** over the trade pane: chips `captured` / `from item` / `live` instead of `captured ·
    search/H4sIAAAA`; actions copy link, open in window, reload; URL on `title`.
12. **One empty state** (rail and pane): *Press + to build a search · Paste a trade URL · Copy an item in game
    and it appears under ExiledExchange2 History.*
13. **Live tab framing:** reuse the `.trade-ws` two-pane skeleton; "0/20 searches live" becomes a badge; the
    empty newest-ping placeholder collapses to one line; `liveLabel()` (`pingStore.js:35-46`) gets a 15 s
    timeout → "Reconnecting…".
14. **Backend guards** in a pure `backend/app/workspace.py` `validate_workspace(ws)`: `MAX_WORKSPACE_BYTES =
    2_000_000` (413), `MAX_WORKSPACE_NODES = 5000`, `MAX_WORKSPACE_DEPTH = 32` (400, detail names the limit);
    iterative walk so a cyclic document terminates; every node a dict with `id:str`, `kind ∈ {folder, search}`,
    folder `children` a list; duplicate ids rejected. No per-field schema; no migration (fields are additive).

**Tests.** `workspace-load.test.mjs` (fetch rejects → `loadError`, and a following `addFolder()` issues no
PUT); `workspace-store.fuzzy.mjs` (no persist after a load failure; `flush()` yields exactly one payload equal
to state; undo restores the exact subtree at the exact index; `done` and `layout.railWidth` round-trip);
`tree.test.mjs` (walkers, incl. `findBySlug` semantics); `ping-store.test.mjs` (timeout mapping);
`test_workspace_validate.py` (each guard, cyclic terminates, documents carrying the new fields round-trip);
`lint-style` clean.

**Verify.** Web test env: create, drag, rename, delete + undo, reload → identical tree; kill the backend,
reload → banner, and `GET /api/trading/workspace` still returns the real tree afterwards. Desktop over CDP:
switch league → the `<webview>` element is the same one (tag `data-mounted-at` on mount);
`document.getAnimations().forEach(a => a.finish())` before reading settled DOM.

## 7. Batch 1 — Desktop plumbing: webview hardening, diag bridge, clipboard-add (desktop cut 1)

**Goal.** A small, high-confidence desktop release that lands the two bridges every later batch depends on.
Shipping the telemetry bridge before the feature is what makes the feature verifiable remotely.

**Files.** `desktop/src/main.js`, `desktop/src/preload.js`, `desktop/src/clipboard-add.js` (new),
`desktop/src/trade/urls.js` (new), `frontend/src/lib/{session,diag(new),workspaceStore}.js`,
`frontend/src/components/WorkspaceView.jsx`.

**1-A Webview channel.** `trade:webview-nav` payload becomes `{ url, wcId: contents.id, phase }`;
`WorkspaceView` ignores events whose `wcId` is not the embedded webview's (`wv.current.getWebContentsId()`).
`did-start-loading`/`did-stop-loading` are forwarded as `phase:'start'|'stop'` and drive a 2 px progress
hairline under the header bar. `ensureInstantBuyout()` is skipped for `q`-mounted nodes and shows one muted hint
after giving up. `main.js` `before-quit` sends `ws:flush` and waits up to 1 s.

**1-B URL helpers** (`desktop/src/trade/urls.js`, re-exported by `session.js`, one regex for both runtimes):
- `parseTradeUrl(url)` parses `new URL(url, TRADE_BASE).pathname` only → `{type, slug, live}` or `null`.
- `parseTradeQueryUrl(url)` → `{q}` for `/trade2/search/poe2/<league>?q=…` (JSON validated, league dropped);
  `null` otherwise.
- `queryUrl({q}, league)` → `` `${TRADE_BASE}/search/poe2/${encodeURIComponent(league)}?q=${encodeURIComponent(q)}` ``.
  EE2 interpolates raw; we percent-encode both — the site decodes identically (pinned by a test) and a raw
  space or brace in a `src` attribute is a needless hazard.
- `mountUrl` becomes `n?.slug ? tradeUrl(n, league, n.live) : n?.q ? queryUrl(n, league) : tradeHome(league)`.

**1-C Diag bridge** as in §4.9, plus `frontend/src/lib/diag.js`:
`export const diag = (m, l) => { try { window.poe2desktop?.diag?.log(m, l) } catch {} }` (a no-op on web).
Wire the batch-0 `ws-*` lines. Drop the local version tag in `dev-ee2-telemetry.js`.

**1-D Clipboard-add.** Main's `clipboard:classify` reads `clipboard.readText()` (≤ 8000 chars) and returns
only the classification in §5 (`item` needs the port and returns `{kind:'none'}` until batch 3 lands). UI: a
rail-head button ⎘ "Add from clipboard" (`aria-label`), ⌘⇧V, `Ctrl/⌘+V` while the tree (not an input) has
focus, a folder context-menu item "Add from clipboard here", and the ⌘K command. Target = the selected folder,
else the selected node's parent, else root — never the history folder. Ladder:

```
empty      → toast "Clipboard is empty"                                   clipboard-add result=empty
trade-url  → ingest({source:'clipboard', slug, name:'Search '+slug.slice(0,6)})   result=ok src=url   (auto-named on open, as today)
query-url  → ingest({source:'clipboard', q, name from q.query.name / q.query.type})   result=ok src=query-url
item       → batch 3: ingest(intent from the builder, folder:null)         result=ok src=item
exchange   → toast "Bulk exchange links aren't saved here — use the Board"  result=exchange
none       → toast "That's not a trade link"                                result=invalid len=…
```
An existing node with the same `slug` or byte-identical `q` is **selected instead of duplicated** (toast
"Already saved — selected it", `result=dup`). The store gains `ingest()` for the two URL rungs,
`ensureFolder(sysKey, name)` (find by `sys` at any depth; create at root index 0 if absent),
`prependSearch(parentId, node)`, and `sanitize()` before every PUT (drops any `q` over 16 KB; trims the history
folder to the cap).

**Tests.** `webview-nav.test.mjs` (`shouldAcceptNav`); `clipboard-add.test.mjs` (classifier with injected
`readText`: search id link, `?q=` link, exchange link → `exchange`, junk, empty; never returns the text);
`telemetry.test.mjs` (unlisted marker rejected, 300-char clamp, nothing when the gate is off, budget);
`session.test.mjs` (pathname-only parse incl. the garbage-slug case; `queryUrl` decodes byte-for-byte to EE2's
string; `queryUrl → parseTradeQueryUrl` round-trip; league with a space; `mountUrl` precedence);
`ingest.test.mjs` (URL rungs, dedupe-selects, target-folder rule, `ensureFolder` finds a renamed/moved folder);
`dead-sweep.test.mjs` (preload exposes `diag.log` and `clipboard.classify`; no local version tag).

**Verify.** Over CDP: navigate the pop-out to another search → the active node is untouched; copy a search
link → ⎘ → node appears and the pane loads it; copy a `?q=` link from EE2's "open in browser" → node with `q`
and `slug:''`, open it → the site runs the search, the slug fills, the name stays; paste again → "already
saved"; copy an exchange link → rejected; random text → invalid. Beta: `clipboard-add result=ok src=url`
appears in `GET /api/installlog` — the first proof the renderer→server path works.

## 8. Batch 2 — The EE2 query port: vendored library, goldens, automated sync (no cut, ships dark)

**Goal.** Item clipboard text → the exact query EE2 would build, in Node, offline, byte-exact, refreshed
automatically on every release. No user-visible change; batches 0 and 1 ship regardless.

**Layout.**
```
desktop/src/vendor/ee2-query/
  LICENSE.EE2  NOTICE  PROVENANCE.md     # MIT attribution (EE2 + Awakened PoE Trade upstream), what was changed and why
  vendor/                                # esbuild output of EE2's own TS — committed, never hand-edited
    parser/*.js  filters/*.js  trade/{pathofexile-trade,common}.js  assets/data/index.js
  shims/                                 # ours, ≤ 60 lines each, one per aliased EE2 module
    config.js      AppConfig() over the injected Prefs; AppConfig('price-check') → the widget subset
    ipc.js         Host.proxy → throws Error('ee2-query: network disabled')   (never reached on the search path)
    prices.js      usePoeninja → inert stubs
    tradedata.js   useTradeData → serves the release-time snapshot (data/trade/{items,stats}.json); no fetch
    fetch.js       fetch('ee2data://…') → fs.readFile under data/
  data/en/         items.ndjson, stats.ndjson, client_strings.js, app_i18n.json, items-{name,ref}.index.bin, stats-{ref,matcher}.index.bin
  data/trade/      items.json, stats.json          # GGG /api/trade2/data snapshot taken at sync time
  data/MANIFEST.json                              # { ee2Tag, ee2Commit, syncedAt, files: { path: { sha256, bytes } } }
  index.js                                        # buildQuery(rawItemText, prefs) — the only export
desktop/src/ee2-history/worker.js                 # utilityProcess entry; `--stdin < item.txt` prints the result
desktop/scripts/sync-ee2.mjs                      # the whole refresh, see below
desktop/test/fixtures/ee2/items/*.txt             # real clipboard texts
desktop/test/goldens/ee2-query/*.json             # pinned { prefs, q, name } generated by EE2's own code
```
`esbuild` is a devDependency; `dot-prop`, `luxon`, `neverthrow`, `@sindresorhus/fnv1a` become dependencies
(pure JS). The vendor directory lives outside the integration package, so that package's "original code only"
rule is untouched.

**`buildQuery(raw, prefs)`**, in order:
1. `parseClipboard(raw)` (`Parser.ts:189`) → item, or `{error:{stage:'parse'}}`.
2. `prefs.language !== 'en'` → `{error:{stage:'lang'}}` (en-only data).
3. `createPresets(item, opts)` with `opts` from `Prefs` (`currency`/`listingType` undefined — cold start);
   active preset = `presets.find(p => p.id === active)`.
4. `apiToSatisfySearch(item, preset.stats, preset.filters)` → `'bulk'` → `{error:{stage:'currency'}}`
   (currency and stackables are never history material; `pathofexile-bulk.ts` is not vendored).
5. `q = JSON.stringify(createTradeRequest(preset.filters, preset.stats, item))`.
6. `name` = `item.name` for uniques, else `item.name ? `${item.name} ${item.baseType}` : item.baseType`, ≤ 60 chars.
Returns `{ q, name, item:{name, baseType, rarity, itemClass}, host }` or `{ error:{ stage, message } }`,
`stage ∈ parse | lang | currency | presets | request`. The ≈40 lines reimplemented from
`CheckedItem.vue:160-205` are the only hand-written logic on the parity path; the goldens pin them.

**Worker protocol** (`{t:'init', dataDir}` → `{t:'ready', ms, items, stats}`; `{t:'build', id, raw, prefs}` →
`{t:'built', id, …result}` | `{t:'error', id, stage, message}`); 3 s per-build timeout. Lifecycle per §4.3.

**`desktop/scripts/sync-ee2.mjs`** — run by `desktop/publish-github.sh` before the test gate on every release
(network is required to release anyway); any step failing aborts the release:
1. Resolve EE2's latest GitHub release tag (`Kvan7/Exiled-Exchange-2`; `--tag` to pin) and fetch it into
   `~/.cache/arbiter/ee2/<tag>`. The local `~/Exiled-Exchange-2` checkout is not used.
2. `npm ci` in the cache's `renderer/` (once per tag); run `make-index-files.mjs` for `en`; esbuild the TS set
   with the shim aliases (`--format=cjs --platform=node`, `define import.meta.env.BASE_URL='"ee2data://"'`);
   copy data + index bins.
3. Fetch `www.pathofexile.com/api/trade2/data/items` and `/stats` once into `data/trade/`.
4. Regenerate the goldens by running EE2's own code at that tag under its vitest setup (a throwaway spec,
   `mockConfig` = fixture prefs) and run the port's golden test against them. A parity failure (the vendored
   build disagreeing with EE2's code at the same tag) aborts; a golden diff versus the previous tag is printed
   for review and committed.
5. Write `MANIFEST.json`; the refreshed vendor, data, snapshot, goldens and manifest are part of the release commit.

**Tests.** `ee2-query-golden.test.mjs` (every fixture's `q` equals its golden **as a string**; fixtures ≥ 20:
unique with a preset, rare with 6 mods, rare with a multi-id stat, magic, normal base, corrupted, unidentified,
mirrored, a currency stack and a single Divine → `currency`, waystone, gem with quality, jewel, charm, relic,
augment/rune sockets, fractured, non-English → `lang`, an unknown base → `parse`; prefs variants
`searchStatRange` 10/20 and `defaultAllSelected` on/off); `ee2-query-data-drift.test.mjs` (every vendored file's
sha256 matches `MANIFEST.json` — catches hand edits); `ee2-query-shape.test.mjs` (never throws; `q` parses
back; warm build median < 20 ms over 200 items); `ee2-query-bundle.test.mjs` (the bundle contains no `fetch(`,
`XMLHttpRequest`, `WebSocket`, `Host.proxy`; `main.js`'s import graph does not reach the vendor except through
the worker); `ee2-prefs.test.mjs` (every `Prefs` field from a fixture `config.json`, `host` per language/realm
branch, `useEn`, and a missing widget → EE2 defaults).

**Verify.** `node desktop/src/ee2-history/worker.js --stdin < fixture.txt` prints the query; the URL it
composes, opened in a browser, returns the same results as EE2's own "open in browser" link for the same item.

**Non-goals.** Result display, price prediction, third-party price feeds, EE2's rate limiter, EE2's in-app
browser, languages other than `en`, bulk/exchange queries, per-popup edits.

## 9. Batch 3 — "ExiledExchange2 History" end to end (desktop cut 2)

**Goal.** Every copied item becomes a row at the top of the folder within a second, with no network call and
no second writer; verified on Windows through beta telemetry.

**Files.** `desktop/src/ee2-history/{index,prefs}.js` (new), `desktop/src/main.js` (attach in
`startEe2Integration()`, detach in `stopEe2Integration()`, the `ee2:*` handlers), `desktop/src/preload.js`,
`frontend/src/lib/{ee2History(new),workspaceStore}.js`,
`frontend/src/components/{WorkspaceView,SearchTree,TradingSettings}.jsx`, `frontend/src/App.jsx`,
`backend/app/settings.py`.

**Flow.**
```
item copied in game ─▸ EE2 package 'item-checked' {raw, name, rarity, itemClass, origin, ts}
        ▼
desktop/src/ee2-history/index.js   (the "actions layer"; the package is untouched)
   if !enabled → history-skip reason=disabled
   prefs = prefs.js (cached; invalidated by the package's watchConfig)
   worker.buildQuery(raw, prefs) → result | error(stage)
   error.stage === 'currency' → history-skip reason=currency (no intent)
   other error → intent{degraded:true, q:null, stage}
   win.webContents.send('trade:ingest', intent)        (raw never crosses IPC; ≤ 20 intents held while no window is loaded)
        ▼
useEe2History() (mounted in App.jsx beside useLiveSync) → useWorkspace.getState().ingest(intent) → trade:ingest-ack
        ▼
debounced persist() → PUT /api/trading/workspace
```

**`ingest(intent)`** — one atomic `set()`; returns `{result, reason?}`:
1. `loadError` → `dropped/load-error`. `!loaded` → buffer in the store and apply in order right after `hydrate()`.
2. `q && q.length > 16384` → `dropped/oversize`.
3. Folder = `intent.folder ? ensureFolder(intent.folder, 'ExiledExchange2 History') : the selected folder,
   else the selected node's parent, else root`.
4. **Dedupe** (history folder only): a child with the same `league` and byte-identical `q` is removed and the
   new row inserted at index 0 → `bumped`. A renamed twin passes its `name` to the new row.
5. Build the node: `auto:false`, `slug:''`, `origin`, `ts`, `item`, `degraded`, and — for the history folder —
   `league` = the app's current league. `prependSearch`.
6. **Cap** (history folder only): while `children.length > max`, remove the last child. Every child counts,
   including hidden other-league rows.
7. **Expiry** (history folder only): remove every child with `ts < now − retentionDays·86 400 000`.
   `expireHistory(now)` also runs once after `hydrate()` and on a 1-hour timer while the app is open.
`clearHistory()` removes all of the folder's children (undoable, one toast "Cleared N entries · Undo").

**Opening, promoting, league.** Selecting a row only selects it. Opening it mounts `queryUrl(row, league)`
with the **top-bar league**; the site POSTs and navigates to a search id; the capture path recognises the node
is inside the history folder and writes nothing. Dragging a row out (or *Move to ▸* in its context menu) makes
it an ordinary search: the capture path fills its slug on the next open, it can be armed, and cap/expiry no
longer apply. The folder renders only rows whose `league` equals the top-bar league.

**Consumer details.** `index.js` accepts every `item-checked` regardless of `origin`. Prefs are read through
the package's `loadConfig()`; if the config is unreadable, EE2's defaults are used and
`history-attached cfg=default` says so. The worker is warmed 15 s after launch when `detectEE2().running`, and
on any later `ee2-detected running=true`; otherwise started on first use. The renderer sends
`ee2:set-enabled` on mount and on change so main skips builds when off; if it never arrives main assumes on
and the renderer drops — fail toward "the feature works".

**Workspace UI.**
- Rail head: the `<Toggle>` slider "EE2 history" (`components/Toggle.jsx`, `role="switch"`, `aria-checked`),
  bound to `settings.ee2History.enabled` via `useStatus.getState().saveSettings({ ee2History })`. Desktop only.
- History folder row: a count badge, a 🗑 "Clear history" trailing button, and a context menu with *Clear
  history* and *Move to ▸* on its rows. The folder name is always "ExiledExchange2 History".
- Rows: icon `degraded ? '⚠' : slug ? '🔎' : q ? '🧾' : '✎'`; an `origin==='ee2'` chip; tooltip
  `${rarity} · ${itemClass} · checked ${relative(ts)}`; rarity tint via `theme.js`. Degraded rows open
  `tradeHome(league)` and their tooltip says the item is newer than Arbiter's data.
- ⌘K: "Clear EE2 history". Empty-state card gains the EE2 line only while the slider is on.

**Settings → Trading → ExiledExchange2 history** (`TradingSettings.jsx`, desktop-gated like the hotkey row;
backend `DEFAULTS["ee2History"] = {"enabled": True, "max": 200, "retentionDays": 14}`): the same
**Record copied items** slider; **Keep last N** (20…1000); **Keep for N days** (7…90); **Clear history**; a
status line from `ee2:status` ("EE2 detected · config OK · league Forbidden Rites · builder ready" /
"not detected").

**Tests.** `ingest.test.mjs` (every rule above: load-error drops, pre-hydrate buffer applies in order,
oversize, dedupe removes the older twin per league and inherits a renamed name, newest-first, cap counts
hidden-league rows, expiry at 13 d 23 h vs 14 d 1 h, rows outside the folder never touched by dedupe/cap/expiry,
folder created once at root index 0 and found again after rename/move, recreated after deletion, degraded
intent inserts `q:null`, `persist` fires once per ingest, `clearHistory` empties only the folder and is one
undo slot); `workspace-store.fuzzy.mjs` (`ingest`/`ensureFolder`/`clearHistory`/`expireHistory` in the random
op set; invariants: one node per `sys` key, folder length ≤ max, byte-stable round-trip with the new fields);
`session.test.mjs` (a `?q=` mount URL never yields a slug); `ee2-history.test.mjs` (pure: any origin accepted;
`currency` skipped without an intent; other errors produce a degraded intent; the no-window buffer holds 20;
timeout; restart-at-most-once-per-5-min; `enabled:false` never spawns the worker — `require.cache` probe; the
sent intent contains no `raw` and no substring of the fixture's mod text); `ee2-prefs.test.mjs` (config
invalidation re-reads); `history-toggle.test.mjs` (rail slider and Settings slider read/write one setting; off
→ `dropped/disabled`); `test_settings_defaults.py`.

**Verify.** Over CDP with EE2 running, the owner copies three real items (a unique, a rare, a currency
stack): the folder appears at `tree[0]` with two rows newest-first (`q`, `origin:'ee2'`, `auto:false`,
`slug:''`) and one `history-skip reason=currency`; open the first → results match EE2's own panel and no slug
is written; copy the same item again → it moves to the top, no new row; drag a row into a curated folder →
its next open fills a slug; switch league → the folder shows only that league's rows; slider off →
`history-skip reason=disabled`; 🗑 → rows gone, Undo restores. `useEe2History()` exposes its handler as
`window.__ee2HistoryTestHook` in dev builds so the renderer path can be driven without EE2; it inserts through
the store's normal PUT, never a probe at a write endpoint.

**Beta telemetry (Windows).** After a few copies, `GET /api/installlog` filtered on ` ee2 ` shows, in order:
`ee2-detected … running=true` → `warm ms=…` → `history-attached cfg=ok` → `history-build …` → `history-add …
total=1 league-match=1` → `history-open …`. No `warm` = the worker never spawned (the asar data path on
Windows is the one thing a Mac cannot check). `history-build` without `history-add` = the renderer path is
broken. `history-degraded` dominating = the snapshot/data is stale. `history-add origin=clipboard` dominating
with EE2 running = uiohook attribution failing on that machine (cosmetic).

**Failure modes.**

| failure | behaviour | signal |
|---|---|---|
| EE2 not installed | package dormant; nothing recorded; Settings "not detected" | `ee2-missing` (existing) |
| EE2 config unreadable | EE2 defaults used | `history-attached cfg=default` |
| uiohook blocked (macOS Accessibility) | nothing changes; rows carry `origin:'clipboard'` | `history-add origin=clipboard` |
| worker data load fails (bad asar path) | every build errors → degraded rows; restart at most once per 5 min | no `warm`; `history-degraded` |
| worker dies mid-build | in-flight item skipped; restarted on next request | `history-skip reason=worker` |
| build times out (3 s) | skipped | `history-skip reason=timeout` |
| unknown base (newer than the snapshot) | ⚠ row | `history-degraded stage=parse` |
| no window loaded yet | main holds ≤ 20 intents, sends when the window loads | `ingest-drop reason=no-window` beyond 20 |
| workspace failed to load | nothing inserted, nothing persisted | `ingest-drop reason=load-error` |
| PUT rejected (size guard) | toast + `saveState:'error'`; tree stays in memory | `ws-save fail` |
| EE2 league ≠ app league | row captured under the app's league; opens in the app's league | `history-add league-match=0` |
| `?q=` rejected by the trade site (schema change) | the site shows its own error; the row can be deleted | `history-open` with no navigation following |
| user deletes the folder | recreated on the next item at root index 0 | — |

**Non-goals.** Per-popup EE2 tweaks (never persisted by EE2; capturing them means patching EE2). The row is
the query EE2's active preset *would* produce whether or not EE2 auto-ran it (`CheckedItem.vue:181-196`).
No auto-open, auto-select, auto-arm or auto-whisper.

## 10. Bug (separate) — trade-pane zoom drifts and sticks

Shipped on its own; listed here for completeness. Two defects, both in `desktop/`:
1. **Script artifact.** `scripts/shot.mjs:26` captures with `clip.scale: 2`, which flashes device emulation on
   the visible window. Drop `scale`; `try/finally` around the capture; close the socket on `SIGINT`.
2. **Real bug.** `main.js:481` `{ role: 'viewMenu' }` installs ⌘+/⌘−/⌘0; nothing pins zoom; the `<webview>`
   shares `defaultSession` with no partition, so a pathofexile.com zoom persists across restarts and leaks into
   the `open-trade` pop-out; Electron syncs guest zoom to the embedder on navigation. Fix: replace the role
   with an explicit submenu from an exported `buildMenuTemplate()` (reload, forceReload, toggleDevTools,
   togglefullscreen, plus **"Reset trade window zoom"** = `setZoomLevel(0)` on every guest; no zoom roles);
   `webPreferences.zoomFactor: 1` on the main window and the pop-out (which today passes only `{sandbox:true}`);
   on `web-contents-created` for webviews `setZoomFactor(1)` + `setVisualZoomLevelLimits(1, 1)` (wrapped);
   `setZoomLevel(0)` in the `did-navigate` forwarder to clear already-persisted zoom. **Never** give the webview
   its own partition — `main.js:334-347,558` depend on the shared logged-in session.
Test: `menu.test.mjs` (no zoom role; reset item present). Verify: ⌘+ does nothing; `getZoomFactor()` is 1 for
every webContents; zoom the pop-out, quit, relaunch → 1; `shot.mjs` no longer flashes.

## 11. Batch 4 — Item paste, rate-budget hint, dormant Client.txt (desktop cut 3)

**4-A Paste an item into a chosen folder.** The `item` rung of clipboard-add: `looksLikeItem(text)`
(`clipboard-watcher.js:54-58`, reusable export) → the same worker → `IngestIntent{source:'clipboard',
folder:null}` into the selected folder. This is the explicit variant of the item stream: it works with EE2
installed but not running, and it targets the folder you chose instead of the history folder. One handler, one
rung, one test (`clipboard-add.test.mjs` gains the item case; golden fixtures reused). (Note: the automatic
item stream needs the EE2 package active, i.e. EE2 installed.)

**4-B Shared GGG rate-budget awareness.** EE2 and Arbiter run on the same account and IP, so an EE2 price
check spends the budget Arbiter's engine reserves through `desktop/src/trade/budget.js`
(`POST /api/ratelimits/acquire|observe`). On `item-checked{origin:'ee2'}`, main calls a new loopback-only
`POST /api/ratelimits/hint {policy:'trade-fetch'}` that `gateway.Policy` folds in as a used slot (header parsing
stays in Python). Fewer penalty boxes with live searches armed. Test: the hint's budget math in
`test_ratelimits_api.py`.

**4-C Client.txt — dormant infrastructure only.** Beside the existing unwired tailer (`log-watcher.js`; prefer
EE2's configured `clientLog` path, `Config.ts:140`), our own ≤ 80-line parser (EE2's `client-log-parser.ts` is
reference only): `@From <name>: …`, `@To <name>: …`, zone entry, "Trade accepted." / "Trade cancelled.", AFK
on/off → typed events on the package's bus. **Not attached in `main.js`, no settings row, no consumers.** Every
file carries `// DORMANT — not wired; reserved for future feature work (whisper pings, hideout arrival,
trade-done). Nothing planned.` Tests: line-grammar fixtures (names scrubbed); a dead-sweep test asserts
`main.js` never requires it. What it *could* enable later, for the record: "someone wants to buy your X" pings,
the teleport button knowing you arrived, auto-marking a row done on "Trade accepted.", muting pings while AFK.

## 12. Batch 5 — QOL tier 2 (as wanted, no cut)

From the catalogue (§14), whatever earlier batches did not deliver: relative-time + rarity chips on history
rows; duplicate node; "Re-run from item" on a clipboard/promoted node with both `q` and `slug` (clears the slug
and remounts from `q`; useful after a league reset); sort A–Z; multi-select delete with one undo slot; folder
go-live-all with `MAX_SOCKETS=20` awareness; market price beside a history row (`/api/asset?q=`, cached,
graceful miss); session-freshness chip in the header bar; export/import of the curated workspace with the
history folder excluded. All store-level; tests extend `ingest.test.mjs` and the fuzzy store test.

## 13. Batch 6 — Sales tab: the trade site's Merchant History in Arbiter's UI (desktop cut, independent)

**What the site has** is in §3 (endpoint, shape, no paging, 429 risk). Screenshots from the research are in
the session scratchpad (`history.png`, `history4.png`).

**What Arbiter builds — Trading → Sales.**
- **Fetch path (main).** Through the existing trade proxy (`desktop/src/trade/proxy.js`, full logged-in cookie
  jar) with the budget reserved through `budget.js` under a new backend policy `trade-history` (defaults
  conservative; `observe` refines it from the response's `X-Rate-Limit-*` headers). Triggered by a manual
  refresh button and by a 10-minute timer **only while the Sales tab is visible**, for the top-bar league.
- **Ledger (backend, user data).** User migration 5 creates `sales(item_id TEXT, time TEXT, league TEXT,
  price_amount REAL, price_currency TEXT, item_json TEXT, PRIMARY KEY(item_id, time))` in `user.sqlite`.
  `POST /api/sales/ingest` (loopback) upserts what main fetched — idempotent, nothing is ever deleted;
  `GET /api/sales?league=` serves it. The backend is the ledger's only writer; the ledger and the workspace
  never mix. Rows are kept forever.
- **Ledger list.** One row per sale: item icon (16 px), `name` + muted `baseType`, rarity-tinted glyph via
  `theme.js`, the price through the Wealth rule (`<Wealth v cur/>`), `fmt` relative time; newest first. A
  header strip: sales today / this week and total value through `<Wealth>`, and a league selector listing
  every league the ledger holds, defaulting to the top-bar league.
- **Item card.** A new `ItemCard.jsx` rendering trade item JSON in Arbiter's style: rarity-coloured
  double-line header, property lines with augmented values, item level, requirements, mod groups (implicit /
  explicit / rune / enchant / corrupted), the icon. Built once and reusable (live pings carry the same item
  shape from `/api/trade2/fetch`). Tokens only, no raw hex.
- **Cross-link.** A sale whose item name matches a workspace node links to that node.
- **Telemetry** (`sales` marker): `sales-fetch status=… n=… policy="…"`, `sales-ingest new=… total=…`,
  `sales-open`. Item names only, never mods.

**Tests.** Backend: upsert idempotency (same `item_id`+`time` twice → one row), league filter, migration 5
forward-only and idempotent; a golden of the observed response shape → `ItemCard` props. Frontend: `ItemCard`
renders each block from fixtures (rare body armour with 5 mods; a unique; a currency stack); Wealth conversion of
`price`; relative time. Desktop: fetch acquires before and observes after; 429 backs off per the policy; a
hidden tab never polls.

**Verify.** Open Trading → Sales with the real session: rows match the site's Merchant History for the same
league; open a row → the card matches the site's card (screenshot side by side); refresh → no new rows, no
429; leave the tab → no polling in the network log.

**Settle during the build (read-only, spaced-out probes):** how far back the site's window goes, whether
purchases ever appear, and the exact rate-limit policy name and budget for this endpoint.

**Non-goals.** Nothing is written to the trade site; no polling while hidden; no reconstruction of purchases;
no whisper/contact data (the endpoint has none).

## 14. QOL catalogue (ranked by value ÷ effort; batch column says where it lands)

Effort: XS ≤ 20 lines · S an afternoon · M a day · L multi-day.

| # | Feature | Value | Effort | Design | Batch |
|---|---|---|---|---|---|
| 1 | Fix the empty-hydrate data loss | Critical | S | `loadError`, never armed; banner + Retry | 0 |
| 2 | Add from clipboard | ★★★★★ | S | ⎘ + ⌘⇧V + ⌘V-in-rail + ⌘K + folder menu; main classifies; duplicate → select; exchange rejected | 1 |
| 3 | ExiledExchange2 History folder | ★★★★★ | L | the headline (§9) | 2, 3 |
| 4 | History on/off slider in the rail head | ★★★★☆ | XS | styleguide `<Toggle>`; same setting as Settings | 3 |
| 5 | Clear history from everywhere | ★★★★☆ | S | one `clearHistory()`; folder row 🗑, context menu, ⌘K, Settings; undoable | 3 |
| 6 | Two-week expiry + 200 cap | ★★★★☆ | XS | on ingest, after hydrate, hourly; settings-driven | 3 |
| 7 | Undo delete | ★★★★★ | S | `remove()` returns the subtree; 10 s toast with Undo | 0 |
| 8 | Save state + flush on quit | ★★★★☆ | S | dot in the rail head; `flush()` on hide and `before-quit` | 0, 1 |
| 9 | Right-click context menu | ★★★★☆ | S | Open · Open in browser · Copy link · Rename · Duplicate · Mark done · Move to ▸ · Delete | 0 |
| 10 | Keyboard nav + a11y + visible drag handle | ★★★★☆ | S | arborist keys + ⌘N/⌘⇧N; `aria-label`s; `:focus-within`; drag handle + drop highlight | 0 |
| 11 | Filter box | ★★★★☆ | S | `name` + `item.name`; auto-expand | 0 |
| 12 | ⌘K workspace commands | ★★★★☆ | XS | `kind:'ws'` group + per-node "Open search" | 0 |
| 13 | Paste an item into a chosen folder | ★★★★☆ | S | the item rung; works with EE2 not running | 4 |
| 14 | Header bar that does something | ★★★☆☆ | S | chips, copy link, open in window, reload, loading hairline | 0, 1 |
| 15 | `done` toggle | ★★★☆☆ | XS | ✓ in trailing controls / menu | 0 |
| 16 | Resizable + persisted rail | ★★★☆☆ | S | divider drag + toggle; `layout.{railWidth,collapsed}` | 0 |
| 17 | Relative-time + rarity chip on history rows | ★★★☆☆ | S | `ts`, `item.rarity` via `theme.js` | 5 |
| 18 | Re-run from item / duplicate | ★★★☆☆ | XS | clipboard/promoted rows only | 5 |
| 19 | Live tab frame + "Live …" timeout | ★★★☆☆ | S | reuse `.trade-ws`; badge; 15 s timeout | 0 |
| 20 | Multi-select delete | ★★★☆☆ | M | Shift-range select; one undoable batch | 5 |
| 21 | Market price beside a history row | ★★★☆☆ | M | `/api/asset?q=` chip; cached; graceful miss | 5 |
| 22 | Folder go-live-all / stop-all | ★★☆☆☆ | S | arm up to the 20-socket budget; one human click | 5 |
| 23 | Session-freshness chip | ★★☆☆☆ | S | POESESSID present? the #1 reason a capture silently fails | 5 |
| 24 | Export / import (history excluded) | ★★☆☆☆ | S | Settings buttons; merge-or-replace | 5 |
| 25 | Sales tab | ★★★★☆ | L | §13 | 6 |

**Rejected:** own-listing marking via EE2's account name (over-engineering); a "recent" list outside the tree
(two truths); auto-opening new rows (steals focus mid-fight); "open all" (mass navigation, ToS-adjacent);
auto-arming history rows (burns the 20-socket budget); clipboard polling to light the ⎘ button; "teleport
from history" (no ping token); dockview / `openTabs`; per-node `notify` channels (settings-level prefs exist);
per-node notes; daily sub-folders (fight drag-reordering); a history notification (noisy).

## 15. EE2 integrations catalogue

| # | Integration | What EE2 exposes | What Arbiter does | Privacy / ToS | Status |
|---|---|---|---|---|---|
| 1 | Price-check query port | item text + `createPresets`/`createTradeRequest` (MIT) | the history folder | local; zero network; one human click per open | batches 2–3 |
| 2 | Config mirror | `apt-data/config.json`: league, realm, language, trade site, widget prefs | prefs for the builder; `league-match` telemetry | reads a local file the user owns; already read for hotkeys | batch 3 |
| 3 | Shared GGG rate budget | same account + IP | hint the local budget on each EE2 check | local; keeps us under GGG limits | batch 4 |
| 4 | Client.txt parser | the game's log (EE2 tails it too); EE2's config gives the path | dormant parser, unwired, marked reserved | read-only local file; opt-in if ever wired; names never telemetered | batch 4 (dormant) |
| 5 | `item-checked` stream beyond history | `{name, baseType, rarity, itemClass, …}` | a "checked but not bought" view in Strategy ("Breach Rings 41× this week") | names/labels only | later |
| 6 | Currency copy → Board price | a copy the history consumer skips | opt-in banner "Divine Orb · board 173.2 ex" with "Open on board" | local backend only | later |
| 7 | EE2 local `GET /config` | `{version, updater, contents}` (`server.ts:118-127`) | liveness + version in Diagnostics; prefs fallback for portable installs | stateless read; **never** `/events` (hijacks EE2's `lastActiveClient`), never `/proxy` | keep unwired unless the file watch proves flaky |
| 8 | EE2's CSV item logs | `apt-data/csv-data/*` | one-shot opt-in import | user's own files | low priority |
| 9 | Hotkey stream | `ee2-hotkey {action, shortcut}` | collision detection if Arbiter ever adds its own chord | passive, never logs keys | low value |
| 10 | Item-check links | poe2db/wiki URL builders | "Open on poe2db" in a row's context menu | external links only | later |
| — | Stash-search entries | EE2 types into the game (`main/src/shortcuts/text-box.ts:57` via `Shortcuts.ts:74-75,213-214`) | nothing | keystroke injection is never ours | rejected |
| — | Price prediction / poe.ninja feeds | third-party network | nothing | desktop contract: updates + beta telemetry only | rejected |
| — | Overlay widgets (map-check, OCR, stopwatch, delve, notepad) | overlay features | nothing | Arbiter is not an overlay | rejected |
| — | Patching EE2, joining `/events`, writing EE2's config, driving its UI | — | nothing | a patch is reverted by EE2's updater; `/events` hijacks; a config write races EE2's tmp+rename | rejected |

**Never** (with the mechanism): patch EE2 or ship a modified build; connect to `ws://…/events`; write EE2's
config; inject into EE2's overlay or consume keys (package CLAUDE.md); inject CSS/JS into GGG's logged-in page
beyond the existing read-only scrapes; automate a trade action (one human click per outbound action, as
enforced for teleport).

## 16. UI polish register

| # | Rough edge | Evidence | Fix | Batch |
|---|---|---|---|---|
| P1 | Zoom drifts and sticks | `main.js:481`; no partition; pop-out has only `{sandbox:true}` | §10 | separate |
| P2 | `shot.mjs` flashes device emulation | `scripts/shot.mjs:26` `scale:2` | §10 | separate |
| P3 | Rail controls hover-only, unlabeled, unreachable by keyboard | `styles.css:187-188`; `WorkspaceView.jsx:173-183` | labels, `:focus-within`, context menu, keys, drag handle | 0 |
| P4 | Two different empty states | `WorkspaceView.jsx:177` vs `:203-207` | one card | 0 |
| P5 | "Loading…" never appears | `WorkspaceView.jsx:100,144` | `phase:'start'|'stop'` → hairline | 1 |
| P6 | Header bar repeats the selection + a gzip slug | `WorkspaceView.jsx:198-201` | chips + actions | 0 |
| P7 | Trade site's own header eats ~340 px | `workspace.png` | the page stays untouched; flex-fill the pane, auto-collapse the rail below ~1100 px, scroll the guest to the search bar on load | 0 |
| P8 | Live tab has no container | `LiveView.jsx:78-110`; `styles.css:229` | reuse `.trade-ws` | 0 |
| P9 | "Live …" can hang forever | `pingStore.js:35-46` | 15 s timeout | 0 |
| P10 | Tab remounts on league change | `App.jsx:188` vs `TradingView.jsx:24` | drop `key={league}` | 0 |
| P11 | Module-level mutable `ui` | `WorkspaceView.jsx:11,109-114` | `useCallback`s | 0 |
| P12 | Pop-out navigation can overwrite the active node | one global `trade:webview-nav` | `wcId` filter | 1 |
| P13 | `ensureInstantBuyout` fails silently, would rewrite an EE2 query | `WorkspaceView.jsx:25-42` | skip for `q`-mounts; one hint | 1 |
| P14 | `readSearchName` hard-codes English labels | `WorkspaceView.jsx:46-84` | never runs for `auto:false` nodes | 3 |
| P15 | Four hand-rolled tree walks | `findBySlug`, `flattenSearches`, `liveWiring.walk`, `findNode` | `lib/tree.js` | 0 |
| P16 | `p=ee2` lines carry the version twice | `dev-ee2-telemetry.js:16-17` + `telemetry.js:26` | drop the local tag | 1 |

## 17. Sequencing

```
B0  workspace safety + QOL core            no desktop cut
 ├─ B1  webview + diag bridge + clipboard-add     desktop cut 1  (proves the telemetry channel first)
 │    └─ B3  history folder end to end             desktop cut 2  (needs B2)
 │          └─ B4  item paste + budget hint + dormant Client.txt   desktop cut 3
 └─ B2  vendored port + goldens + release-time sync   no cut (dark; parallel with B0/B1)
B5  QOL tier 2                              no cut, as wanted
B6  Sales tab                               its own desktop cut; needs only B1
Zoom bug                                    its own fix, outside this feature set
```

| Batch | Desktop shell additions | Depends on | Desktop build |
|---|---|---|---|
| 0 | — | — | no |
| 1 | `trade:webview-nav` payload, `ws:flush`, `diag:log`, `clipboard:classify` | 0 | yes |
| 2 | vendored lib, worker, sync script | — | no (nothing calls it) |
| 3 | consumer, prefs, `trade:ingest*`, `ee2:*`, settings | 1, 2 | yes |
| 4 | item rung, ratelimit hint, dormant parser | 3 | yes |
| 5 | — | 0, 3 | no |
| 6 | history fetch via trade proxy + budget; `/api/sales`; migration 5 | 1 | yes |

Four feature cuts in total (1, 3, 4, 6) plus the zoom fix; the two largest pieces of work (polish, the port)
cost no cut.

## 18. Non-goals

1. Modifying Exiled-Exchange-2 in any way; joining its `/events` socket; writing its config.
2. Capturing per-popup EE2 tweaks (never persisted by EE2). History records EE2's cold-start query.
3. Any network call to build a query. The parser's fallbacks read the bundled snapshot.
4. A second writer to `trading_workspace`. Main never PUTs; the backend never mutates; no shadow history table.
5. Automating trade actions: no auto-whisper, auto-teleport, auto-navigation, stash typing.
6. Syncing history or the sales ledger to the server (user data stays in `user.sqlite`).
7. Reviving `openTabs` / per-node `notify`; dockview layouts.
8. Porting EE2's result display, price prediction, third-party price feeds, or rate limiter.
9. A settings flag inside the EE2 integration package.
10. Injecting CSS/JS into GGG's page beyond the existing read-only scrapes.
11. Vendored data in languages other than `en`.
12. Feature parity on the web build. GitHub Actions for any of this.

## 19. Open questions

None. Every decision is recorded in §2.

## Synthesis note (arena record, 2026-09-16 — historical; later owner decisions supersede details here)

**Candidates.** Four independent plans from the same grounding (2 × Fable, 2 × Opus), plus an independent
Opus judge that read all eight files and spot-checked 9–12 file:line claims per candidate against both repos.
No candidate invented a file or API. Judge scores: C1 23, **C2 25**, C3 23, C4 21. Parent scores before the
judge: C1 23, C2 22, C3 22, C4 22 (parent leaned C4 for its mental model + sequencing).

**Base = candidate 2.** Its `IngestIntent` unification does structural work — one shape, three producers, one
store action — which lets clipboard-add ship before the 8.7k-line port into a surface already tested. It was
also the most repo-honest plan (found the two prefs the grounding omitted, `collapseListings` and `useEn`; the
`ensureInstantBuyout` rewrite hazard). Parent and judge agreed after reading rationales: candidate 4's consumer
built the query synchronously in main's listener, contradicting its own off-thread rationale.

**Grafted.** From C3: the `.index.bin` + `make-index-files.mjs` sync step (the only plan whose loader would
load); clipboard classification in main; the failure-mode table; `buildMenuTemplate()`; the `data-mounted-at`
assertion; `ee2:status`; the `ws` marker; the `lib/tree.js` collapse. From C1: pathname-only `parseTradeUrl`
(the garbage-slug case, verified by the judge); goldens through EE2's own vitest setup; the shared rate-budget
hint. From C4: ship the `diag:log` bridge one cut before the feature; the double-version-prefix fix; degraded
rows instead of dropped events; the "never" list with a mechanism per entry; the `__ee2HistoryTestHook` seam;
spending `done` and `layout`; the widest QOL catalogue and polish register.

**Rejected.** C1's `q` as an object and its backend trim-and-return cap (a truncating backend is a second
author); C4's synchronous build in main, raw clipboard text to the renderer, CSS injection into GGG's page, and
512 KB body cap; C2's `keep` star; C3's `worker_threads` (either works; `utilityProcess` kept for crash
isolation and the CLI entry). **Convergence** (all four): `q` on the node, `sys`-tagged folder, load-failure fix
as a hard prerequisite, drop `key={league}`, the identical zoom fix, vendored EE2 TS with shims, goldens from
EE2's own code, a data-drift test, an allow-listed renderer bridge, refuse `/events`. Several arena-era
choices (protected rows, head-only dedupe, bulk/exchange support, the lazy-only worker, own-listing marking)
were later overruled by the owner; §2 is authoritative.
