# Trading + Watches rework — research brief (input for /arena planning)

> Status: **RESEARCH COMPLETE, NOT YET PLANNED/BUILT.** This is the synthesized input for
> an `/arena` planning pass. Four parallel research streams (current codebase, Exiled-Exchange-2
> patterns, PoE2 trade-site mechanics, library candidates) fed this. 2026-09-14.

## Goals (from the user)

1. **Merge `Trade` + `Watches` into one `Trading` top-nav tab** with its own internal sub-nav,
   to declutter the main nav.
2. **File-system-like organization:** create nested, reorderable, persistent tabs/sections
   (folders) to track different things / run different tools.
3. **Live-search watches that actually work:** ping with a notification when a watched item
   hits; surface **one button for ALL watched things** — the most-recent ping bubbles to the top;
   one click **teleports to the seller's hideout**; the button shows **states** by item
   demand/lifecycle (fresh → sent → pending → stale → sold/gone → rate-limited; plus seller
   online/afk/offline).

## User-confirmed design decisions (2026-09-14)

These are locked before planning — `/arena` should plan *to* them, not re-litigate them:

1. **Trade features are desktop-only.** The live-search/teleport half runs only in the Electron
   build (Cloudflare + session). Web build gets org/workspace + saved searches and a clean
   "open in desktop" degradation for the live half.
2. **Never auto-fire teleports.** A live ping never buys anything on its own. It surfaces an
   **alert button** the user must click; one click = one teleport (`hideout_token` POST). Fully
   human-in-the-loop, rate-limit-obedient.
3. **Every live ping plays a sound.** Preloaded audio, fires on each new ping even when the window
   is unfocused/hidden; deduped/throttled so a burst doesn't machine-gun; mutable in Settings.
4. **Vaal-Orb visual alert (the "eye-draw").** Reuse the spinning-currency aesthetic of the load
   orb (`BrandOrb`), themed to the **Vaal Orb** (corrupted red), as the persistent in-UI
   indicator whenever there's a pending live ping. Design below.
5. **Global focus hotkey (EE2-style).** A configurable global shortcut instantly brings the app to
   the front on the exact live-ping page so the user can act the moment the notification fires.

### The Vaal-Orb live-ping alert (design)

- **Idle:** dormant — no orb (or a dim, still Vaal glyph) on the `Trading` main-nav tab. Nothing
  competing for attention.
- **Pending ping(s):** a **Vaal Orb** materializes on the `Trading` tab and pulses — a red
  "corruption" glow (pulsing box-shadow), a slow ominous rotation (echoing `BrandOrb`), and a
  **count badge** of unseen pings. Clicking it = jump to the live-ping page (same as the hotkey).
- **Intensity encodes urgency**, tied to the button state machine + listing signals: fresh + seller
  **online** = hot, fast red pulse; as the `hideout_token` nears its ~5-min expiry it **dims /
  desaturates** (corruption fading); `sold`/`gone` = a quick **"shatter"** flourish then dismiss.
  So the orb's look tells the user *at a glance* whether it's still worth clicking.
- **Placement:** primary indicator on the `Trading` nav tab; optionally mirrored on the OS
  taskbar/dock badge (Electron `setBadgeCount`/overlay icon) so it draws the eye even when the app
  is backgrounded.
- **Respect `prefers-reduced-motion`:** swap rotation/pulse for a static intensified glow + badge.
- Reuses `BrandOrb`'s CDN-orb + spin machinery; new component `VaalPingOrb` (or a `mode` on
  `BrandOrb`). Note the hidden-tab animation-freeze gotcha — drive intensity off ping *state*, not
  a rAF loop, so it's correct even when the tab was backgrounded.

### The global focus hotkey (design)

- **Single combo, default `CmdOrCtrl+G`** (user-chosen 2026-09-14). Always-on system-wide bind
  via Electron `globalShortcut` — fast, easy reach, essentially free globally (only minor cost:
  hijacks "find next" in the focused app while Arbiter runs). **Re-bindable in Settings.** One
  hotkey only (not a set of per-action binds).
- **On fire:** `win.show()` + `win.focus()` (+ restore-if-minimized / raise from background) → IPC
  to renderer → navigate to `Trading → Live` and scroll/focus the **newest ping's teleport
  button** (focus only — the click stays manual per decision #2, so a human can fire it instantly).
- **In-app** equivalent keybind when the window is already focused.
- **Web:** no global shortcut (can't); in-app keybind only. Model the config UX after EE2's
  per-command hotkeys (`Config.ts`).
- Registration must handle conflict/failure gracefully (`globalShortcut.register` returns false if
  the combo is already taken by another app) — surface a Settings warning + let the user re-bind.

## Trade-site mechanics (PoE2 `/trade2`) — the load-bearing facts

- **Live search = WebSocket.** `wss://www.pathofexile.com/api/trade2/live/poe2/{league}/{searchId}`.
  Flow: `POST /api/trade2/search/poe2/{league}` (query body) → `{id: searchId, result[], total}`;
  open the WS with that `searchId`; on each ping (`{"result":"<id-or-JWT>"}` or legacy
  `{"new":[ids],"auth":true}`) → `GET /api/trade2/fetch/{ids}?query={searchId}&realm=poe2`
  (**max 10 ids/call**).
- **"Teleport to hideout" IS the PoE2 buy action** (GGG replaced whispering with travel-to-
  Merchant-NPC). It's a single POST: `POST /api/trade2/whisper` body `{"token": hideout_token}`,
  where `hideout_token` comes from the fetch result's `listing` object (JWT, `tok:"hideout"`,
  **~5-minute expiry**). Requires headers `X-Requested-With: XMLHttpRequest` + `Origin` + `Referer`
  (omitting → 403 code 6). Response `{"success":true|false}`; `false` = contested/already sold.
  Client must be running + logged into the same account for the teleport to land.
- **Auth = `POESESSID` cookie + Cloudflare `cf_clearance`** bound to a matching `User-Agent`
  (NOT OAuth — this is the website's internal API). **Cloudflare is the real gatekeeper.**
- **Limits:** 20 concurrent live-search WS/account (close code 1013 on excess); header-driven
  rate limits (`X-Rate-Limit-*`), HTTP 429 + ~30-min account throttle on abuse; whisper ceiling
  ~30/min observed.
- **Button-state signals** (from `listing`): `indexed` (freshness), `account.online`
  (online/afk/offline — biggest teleport-success predictor), token `exp`, `success:false`
  (contested/gone). Also seen on fetch results: `in_demand`, `gone`, instant-buyout `fee`.

## Exiled-Exchange-2 patterns (what to copy / not copy)

- **Do NOT copy EE2's contact mechanism.** EE2 is a price-checker; it has **no live search and no
  teleport webcall** — it simulates keystrokes (`/hideout @last` typed into game chat via
  `uiohook-napi`). We use the **`hideout_token` POST instead** (better, and it respects our EE2
  integration's hard "never inject keys / passive" rule).
- **DO copy these EE2 patterns** (files in `~/Exiled-Exchange-2/`):
  - **Local proxy in the Electron MAIN process** (`main/src/proxy.ts`): renderer calls
    `/proxy/{host}/...`; main forwards via `net.request({useSessionCookies:true})` which
    auto-attaches `POESESSID` + `cf_clearance`; forces a spoofed UA; **host allow-list**; strips
    `sec-*`/`host`/`origin`; **strips Cloudflare's `Partitioned` cookie attr** so `net.request`
    persists it. Cookies get into the jar because the user logged in via an in-app `<webview>`.
    → This is exactly how our live-search WS + fetch + teleport get past Cloudflare, and it makes
    the feature **desktop-only**.
  - **Header-mirroring rate limiter** (`trade/common.ts` `adjustRateLimits`, `RateLimiter.ts`):
    token-stack + queue per policy (SEARCH/FETCH/EXCHANGE), reconciles client limiters to the
    server's `x-rate-limit-*` headers, `preventQueueCreation()` throws a clean "retry in Ns"
    instead of stalling. Surfaced to users via `RateLimiterState.vue`.
  - **Request-body cache** with TTL derived from rate-limit windows (`Cache.ts`).
  - **Listing state badges** (`TradeListing.vue`/`TradeItem.vue`): `online/afk/offline` dot,
    `in_demand`, `gone`, instant-buyout, `isMine`, `listedTimes` (× N grouping). → maps onto the
    stateful teleport button.
  - **Versioned single-JSON config + migration chain** (`Config.ts` `configVersion`,
    `upgradeConfig`). → pattern for the workspace data model.
  - **Client.txt log tailing** (`client-log/`) recognizes whisper lines but no-ops — the natural
    hook if we ever want in-game confirmation of a completed trade.

## Recommended libraries

- **Filesystem workspace:** `dockview` (VS-Code-style tab groups + split/float panes, native
  React, JSON-serializable layout, ships dark themes) + `react-arborist` (virtualized folder/item
  tree: DnD, rename, keyboard) + `zustand`+`persist` (layout/tree state; add `dexie` when data
  like ping-history grows). DnD comes free from dockview + arborist.
- **Notifications:** `sonner` for the in-app most-recent-ping banner (`toast.custom` renders the
  stateful button); hybrid OS notifications — Web Notifications API (browser) / Electron
  `Notification` via IPC (desktop, survives hidden window); preloaded `Audio` for the ding.
- **Button lifecycle:** `xstate` v5 + `@xstate/react` (timed transitions: auto-stale after N s,
  rate-limit cooldown, token-expiry) — or a typed `useReducer` if it stays one-off.

## Current codebase facts (what exists to build on)

- **Nav:** hardcoded `TABS` array + `useState` in `frontend/src/App.jsx` (no router); ⌘K
  `CommandPalette` reads `TABS`/`onGoTab`; framer-motion sliding underline.
- **`TradeView.jsx`:** desktop-only Electron `<webview>` of the real trade2 site + "Save to
  Watches"; browser build = empty state.
- **`WatchesView.jsx`:** flat `folders[] → searches[]` organizer, autosaved to `GET/PUT
  /api/watches` (kv key `watches`, **USER data — migrate carefully** per the DB split). Searches
  store `{id,title,type,slug,live,done}`; league injected at open time. **No automation/notifs.**
- **Backend:** `orderbook.py` already calls `/api/trade2/exchange` via the `POESESSID` cookie
  (`session.py`) and already parses `whisper` + `account` per offer. `oauth.py` is separate
  (profile only). **SSE precedent:** `GET /api/routes/stream` consumed via `EventSource`. Toast
  bus in `lib/api.js`. Stateful copy-button precedent in `RoutesView.jsx`. **No WebSocket yet.**
  Unwired `Client.txt` watcher in `desktop/src/integrations/exiled-exchange/log-watcher.js`.
- **Desktop contract:** packaged desktop only calls *our* server for updates. Trade WS/fetch/
  teleport go directly to pathofexile.com **from the user's own Electron session** — consistent
  with self-containment (it's the user's account, not our server). Windows = verify via telemetry.
- **DB:** user.sqlite (persist+migrate) vs market.sqlite (disposable). **Workspace/watch data is
  USER data** → lives in user.sqlite, needs a migration when the shape changes.

## Constraints / risks to weigh

- **ToS / ban risk:** unofficial API; auto-firing teleports is what sniper bans target. Design
  must stay **human-triggered** (one click = one teleport), obey rate-limit headers, never
  mass-automate. **Surface this to the user.**
- **Web degradation:** no Cloudflare session in the browser build → org/workspace + saved
  searches work everywhere; **live pings + teleport are desktop-only** and must degrade cleanly.
- Keep ⌘K palette + league selector working; keep the dark theme; follow the dataviz palette for
  any charts.

## Strawman phasing (for /arena to critique / replace)

1. **Nav merge (web-safe):** `Trade`+`Watches` → one `Trading` tab with internal sub-nav; move
   existing views under it; keep ⌘K/underline. No behavior change yet.
2. **Filesystem workspace data model + migration:** nested tree (folders/items) replacing flat
   `folders[]→searches[]`; migrate the `watches` user-kv blob; dockview + react-arborist +
   zustand/persist shell. Works on web.
3. **Live-search engine (desktop-only):** Electron-main proxy (EE2 pattern) + WS live-search
   client + header-mirroring rate limiter + reconnect + 20-search budget; push pings to renderer.
4. **Ping pipeline + alerts:** fetch-on-ping → listing state → **sound** (preloaded, fires even
   when unfocused, deduped) + **VaalPingOrb** on the `Trading` tab (+ OS notification + optional
   dock/taskbar badge) + `sonner` most-recent-ping banner. "One button for all watches" surfaces
   the newest ping at the top.
5. **Global focus hotkey (default `CmdOrCtrl+G`):** Electron `globalShortcut` → raise/show/focus
   window from background → navigate to `Trading → Live` and focus the newest ping's button (click
   stays manual). Re-bindable in Settings; graceful register-failure handling. Web = in-app only.
6. **One-button stateful teleport:** `hideout_token` POST via the proxy; XState lifecycle
   (fresh→sent→pending→stale→sold/gone→rate-limited + online/afk/offline) driving BOTH the button
   and the VaalPingOrb intensity; ToS-safe (manual, one click = one teleport).
7. **Polish:** rate-limit state surfacing, `prefers-reduced-motion`, empty/degraded web states,
   sound mute + hotkey config in Settings, telemetry for Windows verification.
