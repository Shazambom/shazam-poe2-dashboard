# Reprice in the cheapest currency — design (arena synthesis, 2026-10-02)

> Status: **built (2026-10-03)**, with the rate-limit headers (§7.4) and the safety in docs/dev-notes.md → "Rate-limit
> safety" (headroom-only fetches, a 5-minute cache, cancel on moving on). The refactor (§5) is next. Owner decisions: never automatic; the repriced search **replaces** the saved
> search; built on Electron's debugger (CDP **Network domain only**) listening to the embedded trade window;
> Trading tab only; afterwards, a refactor moves the other trade-site reads onto the same path with byte-for-byte
> before/after tests. Synthesized from three Opus candidates + an Opus judge; record at the end.

## The problem

The trade site sorts "cheapest first" by its own exalted-equivalent rates, which can disagree with the real
market. The owner's example: Revelatory Wombgifts listed at 105–120 Vaal Orbs on the default sort, and from 17
Chaos Orbs when filtered to chaos — "I had to do some math for a bit" to see which was cheaper. Arbiter has the
real rates. When the listing a search shows first is not the cheapest one the page has loaded, one button
re-runs the search priced in the cheapest currency, so the site shows only that currency, in exact order
(within one currency the site's sort is exact).

Measured (probe, 5 runs on the real app): a Network-only debugger caused no Cloudflare trouble; the site sends
**no exchange rates**; the page's search body and every listing's `price {amount, currency}` are readable.

## 1. Detection

**Inputs (all passive, from the tap, §2):**
- **S**, the page's last `POST /api/trade2/search/poe2/<league>`: body `{query, sort}` (`requestWillBeSent.postData`),
  response `{id, result[≤100], total}`. Rank = index in `result`.
- **F**, each `GET /api/trade2/fetch/<ids>?query=<S.id>`; rows `{id, amount, currency}` placed by rank, not by arrival;
  fetches for another `query=` id are dropped.
- **O**, the price-filter options `{id, text}` from `GET /api/trade2/data/filters` (`trade_filters → price → option`).
  Cached in main for the session and replayed after each attach (a remounted page may serve it from cache).
- **P**, divines per unit by trade currency id — `api.stratPrices()` (`api.js:74` → `/api/strategy/calc?prices=1`,
  `_strat_prices`), the same table `saleValueRef` / `floorDiv` use. **Snapshotted once per search** (when its first
  page arrives), so the minute poll can't make the button flicker.

**Which rows count:** `amount > 0`, `P[currency] > 0`, and `currency ∈ O` (the site can filter it). Nothing is named
in code. The gold `fee` is ignored. For each currency `c`, `m_c` = its smallest loaded amount (normally its first row,
since the site's order inside a currency is exact); `v_c = m_c · P[c]`.

**Rule.** `H` = currency of the highest-ranked counted row (what the user sees first). `C* = argmin_c v_c`.
**Offer iff `C* ≠ H` and `v_H ≥ v_C* · (1 + τ)`**, `τ = 0.05` (one constant; beta telemetry logs each offer's gap to
tune it). Only "is the first thing I see the cheapest?" — an inversion deeper down while the top is cheapest offers
nothing, because filtering to one currency would then hide other-currency listings that beat C*'s later rows.

**The site's rate is never estimated.** The misplacement is the evidence; inferred bounds go to beta telemetry only.

**Sibling evidence (sparse/absent currencies, filtered pages).** The renderer keeps an in-memory map, 10-minute
entries, keyed by `league + canon(query without trade_filters.filters.price)` (`canon` moves out of
`stratTrading.js:10` into a shared helper). Every observed page of that search, whatever its price filter, merges
its `m_c`. A page filtered to currency F has `H = F`; its candidates are F's rows plus the siblings. Not persisted.

**As pages load** (10 rows per scroll): re-run per fetch. Later rows rank lower, so `v_H` and each `v_c` only fall;
once shown, the chip stays, and its label can only move to an even cheaper currency.

**Does not apply (no chip, silently):** live (`node.live` / `/live`) · exchange pages · `S.sort` ≠ `{price:'asc'}` ·
History rows (`inHistory`, `WorkspaceView.jsx:150`) · no active node, or the page isn't the row's saved search (the
webview's current slug ≠ the node's slug — covers the Instant Buyout home landing and an edited, uncaptured search) ·
P empty · `H ∉ P` · fewer than two currencies in the evidence · O never seen · `C* ∉ O`.

**The owner's example at today's rates** (vaal 0.012812, chaos 0.091509 div): 105 vaal = 1.345, 120 vaal = 1.537,
17 chaos = 1.556.
- *Default sort, vaal on top:* `C* = vaal = H` → **no chip.** The page is already right; "buy the 105 vaal" is the
  answer the owner worked out by hand.
- *Chaos-filtered page after the default run:* `H = chaos`, sibling `m_vaal = 105`, gap 15.7% → **"Reprice in Vaal Orb"**.
- *Chaos on top of a default page with vaal 105 below:* → **"Reprice in Vaal Orb"**.
- *A filtered page with no earlier run / a currency never loaded:* no evidence → no chip.

**Search once, click once** (owner, 2026-10-02: "it should simply work by searching once … then I should just click
the button"). The page loads only ranks 0–9 of up to 100 ids, and the cheap currency can sit deeper: in the real
Wombgift search ranks 0–25 were vaal 139–150 and chaos started at rank 26 (15, 16, 17…). So after a search on the row's
own saved search, the app fetches **ids the search already returned** — never a new search — through the user's session
under the rate budget (`trade:listings` → `desktop/src/trade/listings.js`, policy `trade-fetch`):
1. `samplePlan`: one fetch of every 10th rank past the first page and the last (≤10 ids). A currency first seen at a
   sampled rank has its true minimum within the ≤9 unloaded ids just before it; the sampled row is an upper bound.
2. `gapPlan`: only when that bound cannot decide the offer, one fetch of those ids for the most promising currency.
So a search costs the app 1–2 listing fetches, no searches; searches filtered to one currency or not sorted by price
cost none. This replaces "zero app requests" (§ owner decision 3), which could not deliver one-search behaviour.

## 2. Architecture

**Main — `desktop/src/trade/tap.js`** (pure core + thin Electron adapter, dependencies injected):
- Called from `app.on('web-contents-created')` (`main.js:684`) for webview guests, next to the nav forwarding;
  attaching before the first load means the first search is seen. Attaches to every poe webview (main can't tell
  them apart); consumers filter by `wcId`, as `shouldAcceptNav` already does.
- `debugger.attach('1.3')`, `Network.enable({maxResourceBufferSize: 4e6, maxTotalBufferSize: 2e7})`. The adapter can
  only send **`Network.enable` and `Network.getResponseBody`**; a test fails on anything else (the probe showed
  `Page.reload` on a webview reloads the whole app).
- Filters `requestWillBeSent` to `/api/trade2/(search|fetch|data/filters)`; on `loadingFinished` reads the body and
  **projects at the source**: `{kind:'search', wcId, id, body, ids, total}`, `{kind:'fetch', wcId, searchId, rows}`,
  `{kind:'options', wcId, price:[{id,text}]}`. Accounts, stash, `hideout_token`, whispers and item JSON never cross
  IPC; a test pins the payload keys. The listing projection is shared with `uniqueprice.js:68-71` as
  `desktop/src/trade/listings.js` (extracted unchanged).
- IPC `trade:tap` to the window (debounced ~150 ms), preload `trade.onTap: sub('trade:tap')`.
- Lifecycle: `detach` `target closed` (keyed remount) → drop state; the new guest is attached by
  `web-contents-created`. Any other reason (DevTools took the single slot) → re-attach on `devtools-closed`.
  Every call in try/catch; **failure = no events = no chip.** Beta-gated `installLog('tap', …)` for attach/detach.

**Renderer — `frontend/src/lib/reprice.js`** (pure): `observe(state, evt)`, `verdict(state, P, ctx) → null |
{currency, text}`, `repriceQuery(body, currency, P)`. WorkspaceView holds per-webview state in a ref (reset on
remount; the sibling map survives) and the offer in state.

## 3. The reprice action

**`repriceQuery`** (pure, idempotent): deep-copy `S.body`; `query.status = INSTANT_BUYOUT` (`regex/trade.js:8`);
`query.filters.trade_filters = {...tf, disabled:false, filters:{...tf.filters, price:{option:C*, ...bounds}}}`
(`disabled:false`, or a switched-off group ignores the option); `sort = {price:'asc'}`. `bounds`: an existing
min/max is converted from its old unit (no option = exalted equivalent) with `P[old]/P[C*]`, rounded **outward**, so
nothing the user allowed is excluded; none added otherwise. Every other key keeps its bytes and order.

**Store — `repriceSearch(id, { slug, q })`** in `workspaceStore.js` (the only writer). *Revised after QA, 2026-10-03:*
the first build wrote `q` and waited for the site's capture, so switching rows right after the click left a half-done
row. A run search's slug **is** its query, gzipped and base64url'd (byte-equal, measured), so the view builds it
(`reprice.encodeSlug`) and the store saves `{slug, live:false}` at once (plus the new `q` on a row that already had
one, so the two agree), bumps `rerunTick` and returns the previous fields. The window remounts on the slug and the
site runs the one search because the user clicked; the ordinary capture may then write the site's own slug.
- Armed rows stay armed and are live-searchable on the new slug at once.
- `ensureInstantBuyout` runs for slug mounts, but the query already carries `securable`.
- **Verification (beta telemetry):** the next `search` event for this row must filter on the chosen currency with
  Instant Buyout (`ranRepriced`; the site re-serializes filters, so decisions are compared, never bytes).
- ↻ recomputes the window's address from the saved row (`mountUrl` depends on `wvNonce`; QA found it reloading the
  trade home after a fresh search).

**Undo:** `undoToast('ws-reprice', 'Repriced “<row>” in Vaal Orb', restore)` — its **own** id (the delete toast uses
`'ws-undo'`, `:205`; sharing it would wipe a pending delete undo). `restore` writes the previous fields and bumps
`rerunTick`. The toast closure is the only memory; nothing is kept in the tree.

## 4. UI

- **Where:** the `.ws-webhint` strip above the trade window (`WorkspaceView.jsx:447-463`), right after the
  `captured`/`from item`/`live` chips, before the spacer — next to the search it changes.
- **What:** `<button className="ws-chip act">` = the currency icon (`<Cur>`) + **"Reprice in Vaal Orb"**, the name
  being the site's own option `text` from O. Tooltip: "Re-run this search priced in Vaal Orb and save it".
  `.ws-chip.act`: `var(--gold)` text, `rgba(var(--accent-rgb), .45)` border, hover state; no new colour.
- **States:** absent (default, and every no-apply case or failure) → shown (can appear while scrolling; label only
  moves to a cheaper currency) → click: chip goes, the window reloads (existing progress hairline), undo toast →
  after: the page leads with C*, so it doesn't return.
- **Restraint:** appears only when clicking changes what the user sees first. No rates, no "% cheaper", no "site is
  off", no "in order ✓" — its absence is the answer. Gap and decision go to beta telemetry
  (`diag('ws', 'reprice-offer lead=chaos best=vaal gap=16%')`, `reprice-click`; `ws` is already allow-listed in
  `diag-bridge.js:7`).
- **No setting** (owner, 2026-10-02: "don't add settings to disable features like this"; CLAUDE.md → Configuration).
  τ is a code constant.

## 5. Refactor plan (after the feature)

**Moves onto the tap — each only when the recorded fixtures prove byte-identical output:**

| Read today | New source |
|---|---|
| `readSearchName` (`WorkspaceView.jsx:72-110`, English-label DOM scrape) | `S.body.query.name/type/term`; else the category option `text` from `data/filters` + `i<ilvl>` |
| `ensureInstantBuyout`'s read-back verdict (`:64-67`) | `S.body.query.status.option` — the **click** stays (a write; the tap is read-only) |
| TradeBuilder's address following (`TradeBuilder.jsx:29-41`) | the dialog webview's own tap `search` body, if canon-equal to `searchOfLink(slug)` on every fixture; otherwise it stays, and the test records why |

**Cannot move** (the page never makes these requests): `makeQueryPricer` (`uniqueprice.js:42`, background pricing
with no page open), Sales (Merchant History), the live engine's WebSocket and teleport, the backend's boot-time
`data/static`. Slug capture from `did-navigate` stays: the URL is already the exact truth.

**Harness.**
- **Recorder** (`ARBITER_TAP_RECORD=<dir>`, refused when packaged, like `dev:ee2-item`): writes the raw CDP stream and,
  at the same moment, the **old code's live outputs** (`readSearchName` result, IB verdict, TradeBuilder `found`, nav
  URLs) while the owner's real searches are driven over CDP.
- **Scrubber** (tested; fails if any `account`/`token` key survives): stable hashes for ids, constants for account
  and stash, tokens/whispers/item JSON deleted; prices, currencies, queries, options and order kept.
- **Fixtures** `desktop/test/fixtures/tap/*.json`: unique, rare, waystone, tablet, Wombgift-like stackable (mixed
  currencies), filtered page, `?q=` mount, a DevTools detach.
- **Pinned byte-for-byte** (`JSON.stringify` goldens): tap event stream; capture patches + auto-names through a pure
  `captureStep()` extracted from `WorkspaceView.jsx:339-370` with no behaviour change; IB hint decision; TradeBuilder
  `onUse` payloads and the `fullTabletQuery`/`waystonePriceQuery` built from them; `makeQueryPricer` request log and
  results (fake `request`); `floorDiv`/`avgDiv` on a frozen P.

**Sequencing:** (0) one probe: confirm O's ids equal listing currency ids, and whether the decoded slug is
canon-equal to the POST body · (1) extract `captureStep` and `listings.js`, goldens on the old code, green ·
(2) the tap + feature, beta, read telemetry · (3) record + scrub fixtures, commit the harness green on unchanged code ·
(4) one read per commit, goldens untouched; `stratcalc*`, `tablet-price-query`, `strat-trading`, `uniqueprice` green ·
(5) drive the app over CDP before every commit.

## 6. Tests (TDD order)

- `desktop/test/tap.test.mjs`: command allow-list (fake debugger records commands); URL filter; postData parsed;
  fetches joined by `?query=`; out-of-order fetches placed by rank; payload keys free of account/token/stash;
  malformed body or `getResponseBody` rejection → silence; `target closed` vs DevTools detach → re-attach on
  `devtools-closed`; options cache replayed after attach; non-poe guests ignored.
- `frontend/test/reprice.test.mjs`: Wombgift cases above with exact numbers; τ boundary 4.9% / 5.1%; three-currency
  argmin; `H ∉ P` → null; currency ∉ O ignored; unpriced rows ignored; verdict monotone as fetches append; P snapshot
  per search; sibling key ignores price filter and key order, expires at 10 min; each no-apply guard → null;
  **property test** over random pairs from the real price table: offer ⇔ `v_H ≥ v_C*·(1+τ)` and `C* ≠ H`.
- `repriceQuery`: option, `disabled:false`, status, sort set; `trade_filters` created when missing; min/max outward
  including from the exalted-equivalent default; untouched keys byte-identical (delete touched paths, compare);
  idempotent.
- `workspace-reprice.test.mjs` (+ the store fuzz): the slug saved at once; switching rows right after leaves it complete; q-rows keep q and slug in agreement; History and
  `loadError` refused; undo restores exact fields and bumps `rerunTick`; undo id ≠ `'ws-undo'`; armed node leaves and
  re-enters the armed set.
- CDP drive: a mixed-currency search → filter to the dearer currency → chip → click → the row's slug changed, the
  page leads with C*, persists across reload; undo restores.

## 7. Owner decisions on the open questions (2026-10-02)

1. **Min/max on a repriced search: convert** through Arbiter's rates, rounded outward (§3).
2. **Filtering to one currency hides other-currency listings** that beat C*'s later rows: accepted, inherent.
3. **Page-first pricer: no** (scope creep). Dropped from §5; `makeQueryPricer` keeps its own requests.
4. **Rate-limit headers → the budget:** a separate small change after this feature. The tap forwards the page's
   `X-Rate-Limit-*` headers to `POST /api/ratelimits/observe`, so the budget sees the requests the user's own browsing
   spends (the probe saw the site's 3-hour counter climb 16 → 27 across a few page loads, invisible to the budget).
   Own test; not part of the reprice feature.

Still open: a filtered page with no earlier default run shows nothing (v1 accepts this); τ = 5% until beta
telemetry says otherwise.

## Synthesis record (arena)

- **Base: candidate 1** — the judge scored C1 29/30, C2 23, C3 22; my criterion scoring agreed on C1 after
  re-reading C3's trigger (below). Chosen for the lead-vs-best rule, the proven `?q=` + `rerunTick` path with a
  `qOnce` flag that keeps rows' labels right, sibling evidence (the only design giving the owner's filtered-page case
  a button), and a refactor that moves a read only when a byte-equal test proves it.
- **Grafted:** from C2 — the P snapshot per search (no flicker), the property test over the real price table, Network
  buffer limits, `live:false` on reprice, (the optional page-first pricer was offered and declined by the owner).
  From C3 — the options cache in main replayed after attach, labels from the site's own option `text`, the
  "page is the row's saved search" slug guard, beta verification that the repriced search ran as built, the
  rate-limit-header bonus question.
- **Rejected:** C3's "any buried inversion" trigger (with the top already cheapest, repricing hides cheaper
  other-currency rows — e.g. vaal 100, chaos 15, vaal 110 → filtering to vaal hides the chaos 15). C3's client-built
  gzip slug (unverified that the site accepts it; the `?q=` path is proven). C3's undo reusing `'ws-undo'` (would wipe
  a pending delete undo). C2's plain `{q, slug:''}` write (leaves "from item"/"Re-run from item" on repriced rows,
  confirmed at `WorkspaceView.jsx:268,455`). C2's claim that moving `readSearchName` needs Runtime (it reads the body).
  C1's `var(--accent)` (no such token; `--gold` + `--accent-rgb`). Estimating the site's rates (all three rejected it:
  loose bounds, decisions on guesses). Detection in main (all three: the store, names and tests live in the renderer).
- **Convergence noted, not taken as proof:** all three independently chose Network-only CDP in main, source-side
  scrubbing, a pure renderer `reprice.js`, the `.ws-webhint` chip naming the currency, and a 10 s undo.
- **Dropouts:** none.
- **Verified:** file:line pointers re-checked against `main` (`main.js:684`, `WorkspaceView.jsx:150,205,268,313-316,
  329,455`, `workspaceStore.js:347-351`, `liveWiring.js:72`, `diag-bridge.js:7`, `stratTrading.js:10`, `api.js:74`,
  `--gold`/`--accent-rgb`); Wombgift numbers recomputed from the live price table. **Unverified until step 0 / build:**
  O's ids = listing currency ids; slug vs POST body equality; τ.
