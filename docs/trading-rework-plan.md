# Trading + Watches rework — staged PR implementation plan

> **Synthesized via `/arena`** (2026-09-14) from 4 independent candidate plans. Base = candidate 3
> (most repo-grounded); grafts folded in from candidates 4, 2, 1 (see the Synthesis note at the
> end). Plans **to** the locked design in [`trading-rework-research.md`](./trading-rework-research.md);
> does not re-litigate it. Repo: `/Users/ianmoreno/shazam-poe2-dashboard` (FastAPI backend +
> React/Vite frontend + Electron "Arbiter" desktop).

## Grounding facts (confirmed by reading the repo — they shape every decision)

- **Nav** is a hardcoded `TABS` array + `useState('Board')` in `frontend/src/App.jsx`; no router;
  `CommandPalette` takes `tabs`/`onGoTab`; framer-motion `layoutId="tab-underline"` underline.
- **A header-driven rate limiter ALREADY exists in the backend:** `backend/app/gateway.py`
  `class Policy` with `observe()` reconciling GGG `X-Rate-Limit-*`/`-State` triples + a penalty
  box, surfaced by `/api/ratelimits` (`main.py`) and `RoutesView`'s "Fetch status". This is the
  EE2 `RateLimiter.ts` algorithm, already shipped — we **mirror this algorithm**, we do not invent
  a second dialect.
- **`orderbook.py` already speaks trade2** (`POST /api/trade2/exchange/...` via
  `gateway.request(policy="trade")` with the `POESESSID` cookie; `_parse_offers` walks
  `listing.offers`/`account`, extracting `whisper`+`account`). But it carries **only `POESESSID`,
  not `cf_clearance`** — fine for the exchange endpoint today, **insufficient** for the
  Cloudflare-gated live-search WS / fetch / whisper.
- **The Electron `defaultSession` is the only place holding both `POESESSID` AND `cf_clearance`**
  bound to the in-app UA (the login flow / `<webview>` in `desktop/src/main.js` populates it;
  `getPoeCookie()` reads POESESSID by name today). The bundled backend never sees `cf_clearance`.
  ⇒ **the live half is inherently desktop-only** (decision #1).
- Desktop already has: single-instance lock, `win`, `<webview>` trade browser (`TradeView.jsx`),
  `startUiServer()`, `session.defaultSession.cookies`, contextIsolated `preload.js` exposing
  `window.poe2desktop`, and auto-updater telemetry via `/api/installlog?p=<tag>`.
- `watches` is a **user-kv JSON blob** in `user.sqlite` (`_USER_KV` in `db.py`, `_LEGACY_USER_KV`
  in `migrations_user.py`); shape is `folders[] → searches[]`, each search `{id,title,type,slug,
  live,done}`. `migrations_user.py` is numbered / forward-only / idempotent; last id = 1. The DB
  layer already takes a whole-DB `.bak-N` before running migrations.
- `BrandOrb.jsx` = a CDN currency-orb `<img>` with a CSS `orb-spin` animation + `onAnimationIteration`
  — the exact machinery the Vaal orb reuses. (Note: `BrandOrb` is coupled to backfill polling, so
  the ping orb is a **separate** `VaalPingOrb` to avoid tangling concerns.)

---

## Architecture decisions that span the PRs (read once)

1. **The live-search / fetch / teleport engine lives in the Electron MAIN process** — not the
   backend, not the renderer. Only `defaultSession` carries `cf_clearance`+`POESESSID`+matching UA;
   only `net.request({ session: defaultSession, useSessionCookies: true })` from main sends both
   cookies with the right UA past Cloudflare. The backend's `gateway.py` (bare POESESSID) would be
   403'd on the internal `/trade2/live|fetch|whisper` endpoints. This is what makes the live half
   desktop-only, and it stays inside the **desktop contract** (the call is the *user's own* Electron
   session hitting pathofexile.com — exactly like the existing `<webview>` — never our server).
2. **Pings reach the renderer over Electron IPC** (`webContents.send`), not SSE and not a
   renderer-side WebSocket. The producer is in main; main also owns `globalShortcut`, `Notification`,
   and `setBadgeCount`, so co-locating is the least-seams path, and IPC survives a hidden/blurred
   window. (SSE is backend→renderer and the backend can't do the Cloudflare WS; a renderer WS can't
   pass Cloudflare / carry third-party cookies.)
3. **Rate limiting mirrors the shipped `gateway.py` algorithm.** There's no shared runtime between
   Python and Node, so main gets a small JS `RateGate` that ports `Policy.observe()`'s header
   reconciliation (SEARCH/FETCH/WHISPER policies + penalty box + a `preventQueueCreation`-style
   clean "retry in Ns" rejection). One conceptual limiter across the app. The WS itself is governed
   only by the 20-concurrent cap.
4. **Workspace data is USER data** → a **new** user-kv key `trading_workspace`, leaving the old
   `watches` blob intact as a rollback-proof backup, via a numbered forward-only migration. New key
   classified user in both `db.py` and `migrations_user.py`.
5. **One renderer build.** Desktop-only behavior is gated at runtime on `window.poe2desktop.*` (as
   `TradeView.jsx`/`WatchesView.jsx` already do), never a separate bundle. Every live feature has an
   explicit web degradation.
6. **Fail visible, not silent** (ToS-adjacent safety): auth/Cloudflare failures surface "reconnect
   your session"; the 20-cap close code `1013` surfaces "too many live searches"; nothing
   retry-storms.

### IPC contract (added incrementally; listed once here so main↔renderer is auditable)

| channel | dir | added in | payload |
|---|---|---|---|
| `trade:start-search` | R→M | PR3 | `{ itemId, league }` → `{ ok, searchId, budgetUsed }` |
| `trade:stop-search` | R→M | PR3 | `{ itemId }` |
| `trade:engine-state` | M→R | PR3 | `{ active, budgetUsed, budgetMax:20, rate:{…} }` |
| `trade:ping` | M→R | PR4 | `Ping` (see PR4 shape) |
| `hotkey:focus-live` | M→R | PR5 | `{}` (raise + route + focus newest) |
| `hotkey:get` / `hotkey:set` / `hotkey:status` | R→M | PR5 | combo string / `{ ok, registered }` |
| `trade:teleport` | R→M | PR6 | `{ pingId, token }` → `{ success, error? }` |
| `trade:rate-state` | M→R | PR6 | limiter snapshot for the UI |

### Data shapes (referenced across PRs)

**Legacy (current) `watches` kv value** — flat folders:
```jsonc
[ { "id":"ab12", "title":"Captured", "open":true,
    "searches":[ { "id":"x9","title":"Search a1","type":"search","slug":"a1b2c3","live":true,"done":false } ] } ]
```

**New `trading_workspace` kv value** — nested tree + dockview layout, versioned:
```jsonc
{
  "version": 2,
  "tree": [
    { "id":"n_ab12", "kind":"folder", "name":"Chase uniques", "open":true, "children":[
      { "id":"n_cd34", "kind":"search",
        "name":"Headhunter < 500 div",
        "type":"search",            // trade2 URL segment (search|exchange); league injected at open, never stored
        "slug":"aBcDeF",            // trade2 search slug — resolved to a live query at watch-start (PR3)
        "live":true,                // eligible for the live engine
        "done":false,
        "notify":{ "sound":true, "orb":true, "os":true } } ] } ],
  "layout": null,                   // dockview serialized layout (opaque to backend)
  "openTabs": ["n_cd34"]            // which tree items are open as dockview panels  (graft: C2)
}
```
- `kind: "folder" | "search"` (extensible later to `"tool" | "note"`).
- Legacy → new map is 1:1: `folder.id→"n_"+id`, `title→name`, `open→open`; search `id` reused,
  `{type,slug,live,done}` carried, `title→name`, `notify` defaulted all-true.

**Live `Ping`** (renderer-internal, produced by the engine, never persisted):
```jsonc
{
  "pingId":"p_1700000000_3", "itemId":"n_cd34", "searchId":"xYz", "listingId":"abc",
  "item":{ "name":"Headhunter", "typeLine":"Leather Belt", "icon":"<cdn url>" },
  "price":{ "amount":480, "currency":"divine" },
  "account":"SellerName", "online":"online|afk|offline",     // biggest teleport-success predictor
  "indexedAt":1700000000, "receivedAt":1700000001,           // freshness
  "token":"<hideout JWT>", "tokenExp":1700000300,            // ~5-min expiry
  "flags":{ "gone":false, "inDemand":true },
  "state":"fresh"                                             // XState value (PR6)
}
```

---

## PR 1 — Nav merge: one `Trading` tab (web-safe, no behavior change)

**Goal.** Collapse `Trade` + `Watches` into a single top-nav `Trading` tab with an internal
sub-nav, decluttering the main nav. Pure restructuring; zero new behavior.

**Scope / files.**
- `frontend/src/App.jsx`: `TABS` → `['Board','Hold','Inflation','Trading','Routes','Market','Settings']`;
  replace the `{tab === 'Trade'}` / `{tab === 'Watches'}` renders with
  `{tab === 'Trading' && <TradingView key={league} league={league} status={status} />}`. ⌘K palette
  auto-updates (reads `TABS`).
- **New** `frontend/src/components/TradingView.jsx` — the shell: internal sub-nav
  (`['Browse','Watches','Live']`) with its own `useState` + a scoped underline
  (`layoutId="subtab-underline"`). Renders existing `TradeView` under **Browse**, `WatchesView`
  under **Watches**; **Live** is a placeholder "arrives in a later update" empty-state so the sub-nav
  shape is stable for later PRs.
- `frontend/src/lib/nav.js`: add a `nav.openTrading(sub)` helper (mirrors `nav.openCurrency`); wire
  `CommandPalette` deep-links ("Trading: Watches", "Trading: Live").
- CSS: reuse `.tabs`/`.tab-underline`; add a `.subtabs` variant.

**APIs / data.** None changed. `/api/watches` untouched.

**Desktop vs web.** Identical on both. `TradeView` keeps its `window.poe2desktop` gate (desktop
`<webview>` / web "open in desktop" empty state); `WatchesView` works everywhere.

**Reuse vs build.** Reuse `TradeView`, `WatchesView`, the underline, `CommandPalette`. Build only the
thin `TradingView` shell + `nav.openTrading`.

**Acceptance.** Top nav shows `Trading` (no `Trade`/`Watches`); sub-nav switches Browse/Watches;
underline animates; ⌘K navigates to Trading and sub-tabs; league-select + `?oauth=` flows unaffected;
web + desktop build with no console errors.

**Dependencies.** None. Ships first.

---

## PR 2 — Filesystem workspace: nested tree data model + forward-only migration (web-safe)

**Goal.** Replace the flat `folders[] → searches[]` organiser with a nested, reorderable, persistent
workspace (folders + items tree + tab panels), migrating existing data forward with zero loss. Fully
functional on web.

**Scope / files.**
- **Libraries** (`frontend/package.json`): `react-arborist` (virtualized tree: DnD, rename,
  keyboard), `zustand` (+ `persist`), `dockview` (tab groups / split panes). Import their CSS in
  `frontend/src/main.jsx`; theme via CSS vars to match dark mode.
- **Backend.**
  - `db.py`: add `"trading_workspace"` to `_USER_KV`.
  - `migrations_user.py`: add `"trading_workspace"` to `_LEGACY_USER_KV`; append **migration id 2**
    `_m2_watches_to_workspace` — forward-only, idempotent, data-preserving:
    - No-op if `trading_workspace` already present.
    - Read `kv['watches']` (may be absent/empty). Transform `folders[]`→tree (`title→name`,
      `open→open`, each search → `kind:"search"` child copying `title→name,type,slug,live,done`,
      id reused, `notify` all-true). Empty/missing → seed an empty tree.
    - Write `trading_workspace` (`version:2`, `layout:null`, `openTabs:[]`). **Leave `watches`
      untouched** as an automatic backup (roll-forward: fix `_m2` and re-derive if wrong, never
      revert user data). Wrap in try/except that logs and leaves legacy intact on parse failure.
  - `main.py`: add `GET/PUT /api/trading/workspace` (mirror `get_watches`/`put_watches`; store under
    `trading_workspace`; `PUT` validates `version==2` + well-formed `tree`, rejects malformed writes).
    **Keep `GET/PUT /api/watches` alive serving the legacy shape** so a lagging batch-released
    desktop build during rollout keeps working (graft: C2). Belt-and-suspenders: `GET
    /api/trading/workspace` coerces a legacy `watches` value on read if the migration somehow hasn't
    run in a dev DB.
- **Frontend.**
  - **New** `frontend/src/lib/workspaceStore.js` — zustand store (`tree`, `layout`, `openTabs`),
    hydrated from `GET /api/trading/workspace`, autosaved (debounced, reuse `useAutosave` in
    `lib/hooks.js`) to `PUT`. `persist` caches locally only for instant paint; the backend blob is
    authoritative (round-trips through user.sqlite; survives reinstalls). Actions: `addFolder`,
    `addSearch(parentId, parsed)`, `rename`, `move(id, newParent, index)` (DnD), `toggleOpen`,
    `remove`, `setDone`.
  - **New** `frontend/src/components/WorkspaceTree.jsx` — `react-arborist` tree; row actions =
    Open / Live (as today) / delete; "add search" parses a pasted trade URL (`parseTradeUrl` +
    `searchFromParsed` from `session.js`).
  - `TradingView.jsx`: replace the **Watches** body with a left rail (`WorkspaceTree`) + a `dockview`
    work area (opening a search opens a panel; layout serialized into `workspace.layout`; `Browse`
    becomes a dockview panel too). Retire `WatchesView.jsx`'s flat rendering (delete in PR7 once
    proven). `TradeView.saveCurrent()` appends into the tree via the store.
  - `frontend/src/lib/api.js`: add `workspace()` / `putWorkspace(doc)`.

**Desktop vs web.** Identical — 100% web-safe (organisation + saved searches). A `search` panel on
web = "open in new tab" (`openTrade`); desktop = embedded `<webview>`. The `Live` panel type exists
but shows an "open desktop app" empty state (real wiring lands PR3).

**Reuse vs build.** Reuse `useAutosave`, `session.js` URL helpers, the migration runner + whole-DB
pre-migration backup. Build the two libs' integration, the store, `WorkspaceTree`, endpoints,
migration id 2.

**Acceptance.**
- Fresh install: empty workspace; add folder → add search (paste link) → DnD reorder/nest → rename →
  reload + app restart → persisted (verified in user.sqlite).
- **Migration test (load-bearing):** seed a `user.sqlite` with a realistic legacy `watches` blob;
  run the backend; assert `trading_workspace` materializes with every folder/search preserved
  (`{type,slug,live,done}` + nesting/order) and `watches` still intact; re-run → identical
  (idempotent); corrupt value → legacy preserved, error logged.
- Old desktop build still reads `/api/watches` without error. Web build fully functional.

**Dependencies.** PR 1.

---

## PR 3 — Live-search engine (Electron main; desktop-only)

**Goal.** Stand up the Cloudflare-passing live-search machinery in main: EE2-style proxy + WebSocket
live-search client + `RateGate` + reconnect + the 20-concurrent-WS budget. **No UI alerts yet** —
prove connectivity by emitting raw pings + telemetry.

**Scope / files.**
- **New** `desktop/src/trade/proxy.js` (port of `~/Exiled-Exchange-2/main/src/proxy.ts`): a
  `poeRequest({ method, path, body, referer })` helper over
  `net.request({ session: session.defaultSession, useSessionCookies:true })`:
  - **Host allow-list: `www.pathofexile.com` only** (matches our `isPoeUrl`).
  - Forces the login UA (`app.userAgentFallback`); sets `X-Requested-With: XMLHttpRequest`,
    `Origin: https://www.pathofexile.com`, per-endpoint `Referer`; strips `sec-*`/`host`/`origin`/
    `content-length` from forwarded headers.
  - **Strips Cloudflare's `Partitioned` attr** on `Set-Cookie` (via
    `session.defaultSession.webRequest.onHeadersReceived`) so `net.request` persists `cf_clearance`
    (EE2's exact fix). Exposes `proxyGet`/`proxyPost` used by search/fetch/whisper.
- **New** `desktop/src/trade/rateGate.js` — JS port of `gateway.py::Policy.observe()`: parse
  `X-Rate-Limit-Rules` + `-*` + `-State` triples, keep a penalty box, `acquire(policy)`
  (SEARCH/FETCH/WHISPER) that awaits a free slot and a `preventQueueCreation`-style clean "retry in
  Ns" rejection. Mirrors the shipped Python algorithm so client + server behave identically.
- **New** `desktop/src/trade/engine.js` — the live-search manager:
  - `startSearch(itemId, league)`:
    1. **Resolve the stored slug → live query, then reissue** (graft-preserved from base): the tree
       stores `{type,slug}`, not volatile query JSON. Resolve via `GET /api/trade2/search/poe2/
       {league}/{slug}` to obtain the saved query, then `POST /api/trade2/search/poe2/{league}` to
       get a fresh `{ id: searchId, result[], total }`. (We never persist the query body.)
    2. Open `wss://www.pathofexile.com/api/trade2/live/poe2/{league}/{searchId}` with the `ws` npm
       package, handshake `Cookie` assembled from `session.defaultSession.cookies.get({url:POE})`
       (POESESSID + cf_clearance) + `User-Agent` + `Origin` + `Referer` (Node WS can't read
       Electron's jar implicitly).
  - **20-WS budget:** a `Set` of open sockets; refuse/queue the 21st (GGG closes excess with `1013`);
    surface "live budget N/20". Closing/disabling a watch frees a slot.
  - **Reconnect:** exponential backoff + jitter on unexpected close; on `1013` back off longer +
    surface "too many live searches"; on auth/CF failure emit "reconnect session" (fail visible —
    graft: C4). Heartbeat to keep sockets alive; search ids expire → resubscribe with a fresh one.
  - **On ping** (`{"result":"<id-or-JWT>"}` or legacy `{"new":[ids],"auth":true}`): for PR3, emit a
    raw `trade:ping` stub `{itemId, ids, ts}` + log (fetch stage lands PR4).
  - `stopSearch(itemId)`, emits `trade:engine-state`.
- **New** `desktop/src/trade/ipc.js` — registers `trade:start-search`/`trade:stop-search`; wires
  `engine → win.webContents.send('trade:engine-state'|'trade:ping')`. Called from `main.js`
  `app.whenReady`.
- `desktop/src/preload.js` — expose `poe2desktop.trade = { startSearch, stopSearch, onEngineState,
  onPing }` (contextBridge, same style as the updater channel).
- `desktop/package.json` — add `ws`.
- **Frontend.** `workspaceStore` gains a `live` toggle per search (desktop calls `startSearch`/
  `stopSearch`); **new** `frontend/src/lib/tradeLive.js` subscribes to `onPing`/`onEngineState` into
  a zustand `liveStore` (active searches, budget, raw pings buffer). UI: a small "N live • X/20"
  status chip in `TradingView`; web shows the disabled-with-"open in desktop" degradation.
- **Telemetry** (temporary dev diagnostic, per CLAUDE.md): `desktop/src/dev-trade-telemetry.js`
  reports WS open/close/ping counts + RL hits to `/api/installlog?p=trade` (never tokens/cookies),
  kept **outside** contract-clean packages, gated/stripped before a clean release.

**Desktop vs web.** Desktop-only. Web: `poe2desktop.trade` undefined → Live tab keeps the PR1
"open in desktop" state; no engine code imported on the web bundle (lives under `desktop/`).

**Reuse vs build.** Reuse the EE2 `proxy.ts` design (port), the `gateway.py` limiter algorithm
(port `observe()`), the login/cookie plumbing in `main.js`, `/api/installlog`. Build the WS client,
20-cap manager, reconnect, IPC. **Do NOT** copy EE2's keystroke `/hideout` mechanism.

**ToS baked in here.** WS + fetch only (read-only discovery); **no whisper/teleport in this PR**;
obey `RateGate`; cap at 20; user's own session/UA; fail visible.

**Acceptance.** Logged-in desktop: enabling a `live` search resolves→posts→opens a WS→logs pings on
real matches; a 21st is refused with a visible "20 cap" message (not a silent 1013 loop); network
kill → backoff reconnect with a fresh searchId; 429 → penalty honored, no hammering; web unaffected;
Windows verified via `p=trade` telemetry.

**Dependencies.** PR 2 (which searches are `live`, their `type`/`slug`).

---

## PR 4 — Ping pipeline + alerts (fetch → state → sound + Vaal orb + OS notification/badge + banner)

**Goal.** Turn raw pings into enriched, deduped, surfaced pings: fetch-on-ping, **sound**,
**VaalPingOrb**, OS notification + dock/taskbar badge, and the `sonner` most-recent-ping banner —
"one button for all watches," newest ping on top. (Hotkey = PR5; teleport click = PR6, button here
is a state-showing placeholder.)

**Scope / files.**
- `desktop/src/trade/engine.js` — fetch stage: on ping ids → `GET /api/trade2/fetch/{ids}?query=
  {searchId}&realm=poe2` via proxy, **≤10 ids/call** (chunk), FETCH policy through `RateGate`, TTL
  request-body cache (EE2 `Cache.ts` pattern) to avoid duplicate fetches. Extract per listing:
  `hideout_token` (+ `exp`), `account.online`, `indexed`, price, item summary, `gone`/`in_demand`
  (`orderbook.py:_parse_offers` is the reference). **Dedup by listing id** (no machine-gun). Emit
  the enriched `Ping` shape over `trade:ping`.
- **Renderer.**
  - `frontend/src/lib/tradeLive.js` — `liveStore` gains `pings` (newest first), `unseenCount`,
    `markSeen`, dedup. This is the single source both the orb and banner read (no divergence). The
    head ping = "one button for all watches."
  - **Sound** — **new** `frontend/src/lib/ping-sound.js`: a **preloaded** `Audio` (asset in
    `frontend/public/`), **unlocked on first user gesture** (autoplay policy — graft: C2). Fires on
    each *new* ping **even when unfocused/hidden** — HTML `Audio` is **not** frozen by the hidden-tab
    throttle (only rAF/WAAPI are), so backgrounded sound is correct by construction (graft: C1).
    Deduped/throttled (min gap ~1.5s, coalesce bursts). Mutable via Settings (`settings.ping_sound`
    + `ping_volume`). No rAF.
  - **VaalPingOrb** — **new** `frontend/src/components/VaalPingOrb.jsx`, reusing `BrandOrb`'s CDN-orb
    `<img>` + `orb-spin` CSS machinery, themed to the **Vaal Orb** (corrupted-red glyph). Rendered on
    the `Trading` **nav-tab button** in `App.jsx`.
    - Idle: absent / dim still glyph. Pending: pulsing red box-shadow + slow rotation + **unseen
      count badge**. Click = jump to Trading→Live (same target as the hotkey).
    - **Intensity encodes urgency, driven by ping STATE/timestamps, not a rAF loop** (avoids the
      hidden-tab freeze gotcha — correct after backgrounding): fresh+online = hot fast pulse;
      nearing `tokenExp` = dim/desaturate; `gone` = quick "shatter" then dismiss. (PR4 uses a derived
      heuristic; PR6 wires the real XState value.)
    - **`prefers-reduced-motion`:** static intensified glow + badge, no spin (CSS media query).
  - **sonner** (add dep): mount `<Toaster/>` once in `App.jsx` (distinct from the existing home-grown
    toast bus, which stays for app messages). `toast.custom` renders the newest ping as the single
    stateful button (button lifecycle stubbed here; full XState in PR6); new pings bump it to top.
  - `SettingsView.jsx` — a **Trading alerts** section: mute sound + volume, OS-notify toggle.
- **OS notification + badge (desktop, main).** On new ping: Electron `new Notification(...)`
  (survives a hidden window) + `app.setBadgeCount(unseen)` / `win.setOverlayIcon` (Windows). Clicking
  the notification = `win.show()/focus()` (full `hotkey:focus-live` routing lands PR5). `markSeen` →
  IPC clears the badge. **Web fallback:** Web Notifications API (permission-gated); no dock badge.

**Data / APIs.** Enriched `Ping` (above). Alert prefs under the existing `settings` kv (already
`_USER_KV`) — no new migration.

**Desktop vs web.** Desktop: full pipeline. Web: no engine → orb dormant, no sound, no
Electron notification/badge; banner + orb code present but inert; Live tab shows the desktop steer.

**Reuse vs build.** Reuse `BrandOrb` machinery, the existing toast bus (for non-ping toasts),
`orderbook.py` parsing as the extraction reference, `SettingsView` + `/api/settings`. Build the fetch
stage + cache, `VaalPingOrb`, `ping-sound.js`, sonner integration, dedup, notification/badge wiring.

**Acceptance.** Real match → within a fetch cycle: one deduped ding (even blurred/hidden), orb lights
on the Trading tab with correct unseen count + intensity, OS notification fires when unfocused,
taskbar/dock badge shows unseen, sonner banner shows the newest ping with the correct presence dot; a
10-match burst = one throttled ding + no duplicate pings; backgrounding 2 min then focusing shows
**correct** orb intensity for current token age (verifies the no-rAF design); `prefers-reduced-motion`
→ static glow; web dormant with no errors; Windows verified via `p=trade`.

**Dependencies.** PR 3 (engine/pings) + PR 1 (Trading tab hosts the orb).

---

## PR 5 — Global focus hotkey (default `CmdOrCtrl+G`)

**Goal.** A configurable, always-on global shortcut that instantly raises Arbiter onto the live-ping
page and focuses the newest ping's teleport button (focus only — click stays manual, decision #2).

**Scope / files.**
- **New** `desktop/src/trade/hotkey.js`: `globalShortcut.register(combo, handler)` (default
  `CmdOrCtrl+G`) at ready; re-register on config change; `unregisterAll()` on quit. Handler:
  `if (win.isMinimized()) win.restore(); win.show(); win.focus()` (+ raise-from-background;
  `app.focus({steal:true})` on mac) → `win.webContents.send('hotkey:focus-live')`. **Graceful
  failure:** `register()` returns `false` if the combo is taken → store `{registered:false, combo}`
  and surface to Settings for a rebind; never crash.
- `desktop/src/main.js` — call `registerHotkey(win)` in `app.whenReady`; read combo from
  `desktop-settings.json` (extend the existing `settings`/`saveSettings` machinery — hotkey is
  machine/shell config, same class as `mode`/`remoteUrl`, so it lives here, not user.sqlite).
- `desktop/src/preload.js` — `poe2desktop.hotkey = { get, set(combo), status, onFocusLive(cb) }`.
- **Frontend.** On `onFocusLive`: `setTab('Trading')`, switch sub-nav to **Live**, scroll to +
  `.focus()` the newest ping's button (ref on the head ping). Add an **in-app** keybind (same combo,
  window-focused) via the existing `keydown` idiom in `App.jsx`. `SettingsView.jsx`: a hotkey-capture
  field (EE2 `Config.ts` per-command UX) with a "not registered — pick another" warning; **single
  combo only**.

**Desktop vs web.** Desktop: system-wide `globalShortcut` + in-app keybind. Web: in-app keybind only;
Settings shows "global hotkey requires the desktop app".

**Reuse vs build.** Reuse `desktop-settings.json` load/save, the ⌘K keydown pattern,
`liveStore.newest`. Build the `globalShortcut` layer, rebind IPC, capture UI, focus routing.

**Acceptance.** App backgrounded/minimized + a pending ping → the combo raises + focuses onto
Trading→Live with the newest button focused (not clicked); rebinding takes effect without restart +
persists; a taken combo warns and keeps the old bind; web = in-app only; Windows telemetry confirms
register success/conflict.

**Dependencies.** PR 4 (pings + Live surface to focus into). Independent of PR 6.

---

## PR 6 — One-button stateful teleport + XState lifecycle (ToS-safe)

**Goal.** The payoff: one human click = one teleport (`hideout_token` POST). An XState v5 machine
drives BOTH the button and the VaalPingOrb intensity. Strictly human-in-the-loop, rate-limit-obedient.

**Scope / files.**
- **Teleport (main).** `desktop/src/trade/engine.js` `teleport(token)` → `POST /api/trade2/whisper`
  body `{"token": hideout_token}` via proxy, WHISPER policy through `RateGate`, headers
  `X-Requested-With: XMLHttpRequest` + `Origin` + `Referer` (omitting → 403 code 6). Returns
  `{success:bool}` (`false` = contested/already sold). `ipcMain.handle('trade:teleport', …)`; emits
  `trade:rate-state`. `preload.js` → `poe2desktop.trade.teleport(pingId, token)`, `onRateState(cb)`.
- **XState machine (renderer).** **New** `frontend/src/lib/pingMachine.js` (`xstate` v5 +
  `@xstate/react`): states `fresh → sent → pending → stale → sold/gone → rate_limited`, orthogonal
  presence region `online|afk|offline`. Timed: auto-`stale` after N s, token-`exp` expiry
  (→ desaturate/disable), `rate_limited` cooldown from limiter headers. Events: `TELEPORT`(→sent),
  `WHISPER_OK`/`WHISPER_FALSE`(→pending/gone), `ONLINE_CHANGE`, `TICK`, `RATE_LIMIT`. One actor per
  ping; the head ping's value feeds the orb.
- **Stateful button.** **New** `frontend/src/components/PingButton.jsx` — the single button for all
  watches, rendered in the sonner banner and the Trading→Live head. Label/color/enabled per machine
  state (EE2 `TradeListing.vue` badge patterns): `Teleport` / `Sending…` / `Waiting…` / `Stale —
  teleport anyway?` / `Sold` / `Rate-limited (Ns)`; presence dot; token-expiry countdown. **Click →
  `poe2desktop.trade.teleport(...)`; exactly one teleport per click; disabled during `sent`** so a
  double-click can't double-fire.
- **Orb coupling.** `VaalPingOrb` intensity now reads the head ping's machine state (replaces PR4's
  heuristic): fresh+online = hottest; nearing exp = dim; sold/gone = shatter.
- `SettingsView.jsx` — surface the WHISPER/rate-limiter state (EE2 `RateLimiterState.vue` pattern)
  from `onRateState`.

**Desktop vs web.** Desktop-only. Web: `PingButton` renders disabled "teleport is desktop-only" (it
never lights anyway — no pings on web).

**Reuse vs build.** Reuse the proxy + `RateGate` (PR3), `liveStore`/`VaalPingOrb` (PR4), EE2
listing-state semantics. Build the whisper call, XState machine, `PingButton`, orb coupling, RL
surfacing.

**ToS enforcement (in code, not just docs).**
- **Human-in-the-loop:** the teleport IPC is called *only* from `PingButton`'s click handler — no
  timer/auto path. One click = exactly one whisper POST. A test asserts the IPC is bound only to the
  click handler (grep-assertable).
- **Rate-limit obedience:** WHISPER through `RateGate`; `rate_limited` disables with "retry in Ns".
- **No mass automation:** no "teleport all"/queue-drain; single newest-ping button by design.
- **User's own session:** `defaultSession` only; never our server.

**Acceptance.** One click on a `fresh` ping teleports (character lands in seller hideout);
`success:false` → `gone` + orb shatter; double-click never double-fires; token near exp → button+orb
dim, expired → disabled without firing; rate-limit → "retry in Ns", no 429 storm; code audit finds no
teleport path without a click; Windows `p=trade` reports attempts/results (never tokens).

**Dependencies.** PR 3 (proxy/limiter) + PR 4 (pings/machine/button host). PR 5 complementary but not
required.

---

## PR 7 — Polish, degradation, ToS disclosure, release hardening

**Goal.** Ship-quality edges: rate-limit surfacing, reduced-motion, web degradation, Settings
consolidation, disclosure, telemetry cleanup, desktop-build batching.

**Scope / files.**
- **Rate-limit readout** in the Live panel (mirror `RoutesView`'s "Fetch status" via the main-process
  `RateGate` over IPC): SEARCH/FETCH/WHISPER budgets + penalty countdown + sockets `N/20`.
- **Web degradation audit:** every live surface (Live tab, orb, banner, `PingButton`, hotkey field)
  shows a clean "open in the desktop app" state on web (reuse `DownloadApp.jsx` CTA); workspace +
  saved searches fully usable; no dead affordances.
- **ToS/ban disclosure (required):** a first-run modal + a persistent Live-tab note — uses your own
  pathofexile.com session against GGG's unofficial API; teleports are manual (one click = one
  teleport); obeys rate limits; never mass-automates; carries account risk. Gate `Live` behind an
  acknowledgment stored in `settings`.
- **Reduced-motion + a11y:** final `VaalPingOrb` static variant, focus order on hotkey raise, aria on
  `PingButton`, sonner transitions.
- **Settings consolidation:** sound mute/volume, hotkey rebind, stale-after threshold, disclosure —
  one "Trading" section.
- **Telemetry:** gate/strip `p=trade` diagnostics out of the contract-clean release (keep for
  pre-release verification builds only); never tokens/cookies/whisper text.
- **Cleanup:** delete `WatchesView.jsx` once `WorkspaceTree` is proven; retire `/api/watches` reads
  in the UI **after** the desktop batch window (keep the migration + backup kv).
- **Desktop-build batching** (honors the "desktop builds are expensive" rule): land PR1–PR2 on web
  immediately; batch the desktop-shell/main-process changes (PR3–PR7: proxy, engine, hotkey, IPC,
  notifications) into **one** desktop release rather than per-PR cuts. Mac locally, Windows via CI.

**Acceptance.** Reduced-motion honored everywhere; web has no broken live controls; rate readout
matches server headers under load; disclosure blocks Live until acknowledged; release build has no
active `p=trade` telemetry and only `/downloads` outbound besides the user's own trade calls; legacy
endpoint retired with no data loss.

**Dependencies.** All prior PRs.

---

## Ordering & shippability

```
PR1 (nav merge, web)  ── ships alone, no risk
 └ PR2 (workspace + migration, web)  ── ships alone; web value immediately
    └ PR3 (engine, desktop)  ── needs live search model; dormant-until-enabled
       └ PR4 (ping pipeline + alerts, desktop)
          ├ PR5 (global hotkey, desktop)     ┐ parallel-capable atop PR4
          └ PR6 (teleport + XState, desktop) ┘ (PR6 needs PR3+PR4, NOT PR5)
             └ PR7 (polish + ToS + telemetry cleanup)
```

| PR | Ships alone | Web behavior | Desktop-only additions | Hard deps |
|----|-------------|--------------|------------------------|-----------|
| 1 Nav merge | ✅ | full (Watches works) | — | — |
| 2 Workspace + migration | ✅ | full workspace | — | 1 |
| 3 Live engine | ✅ (silent/telemetry) | clean "open in desktop" | proxy/WS/RateGate | 2 |
| 4 Ping pipeline + alerts | ✅ | orb dormant, degraded Live | fetch/IPC/notif/badge | 1,3 |
| 5 Global hotkey | ✅ | in-app keybind only | globalShortcut | 4 |
| 6 Stateful teleport | ✅ | disabled button + steer | whisper POST | 3,4 |
| 7 Polish/ToS/telemetry | ✅ | clean degradation | rate readout | all |

## Reuse ledger (build only the *italics*)

EE2 `proxy.ts` → *`desktop/src/trade/proxy.js`*; `gateway.py::Policy.observe` →
*`desktop/src/trade/rateGate.js`*; EE2 `Cache.ts` → *fetch cache*; `BrandOrb` machinery →
*`VaalPingOrb`*; `useAutosave` / toast bus / `session.js` URL helpers / `SettingsView` +
`/api/settings` / `/api/installlog` telemetry / `desktop-settings.json` load-save / migration runner
+ `.bak-N` → **reused as-is**. New but small/localized: *`workspaceStore`, `WorkspaceTree`,
`tradeLive`/`liveStore`, `ping-sound`, `pingMachine`, `PingButton`, `engine.js`, WS/20-cap/reconnect,
IPC surface, migration id 2, `/api/trading/workspace`*.

## ToS / ban-risk mitigations (threaded through PR3/PR6/PR7; disclosed in PR7)

The `/trade2` live/fetch/whisper endpoints are the game's *internal website API*, not an official
one; auto-firing teleports is exactly what sniper-bot bans target. Every item below is a **build
requirement**, not advice:
1. **Human-in-the-loop, always** (decision #2): no ping ever fires a teleport; one click = one
   whisper POST; button disabled during in-flight; no auto/queue path exists (test-enforced).
2. **Rate-limit obedience:** `RateGate` reconciles to GGG headers per policy, penalty-boxes on 429,
   surfaces "retry in Ns". Whisper stays human-paced (one click per teleport) — well under ~30/min.
3. **No mass automation:** 20-WS cap respected (never probe the limit); fetch ≤10 ids; dedup prevents
   storms; only user-enabled searches run.
4. **User's own session, never our server:** all trade calls go through the Electron `defaultSession`
   directly to pathofexile.com (desktop contract preserved).
5. **User-facing disclosure (PR7):** first-run + Settings notice; Live gated behind acknowledgment.
6. **Fail visible, not silent:** auth/CF failure → "reconnect session"; 1013 → "too many live
   searches"; never retry-storm.
