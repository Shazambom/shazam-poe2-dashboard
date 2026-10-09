// Stash → Strat Calculator: named farming strats, each a session you can leave and resume, and
// each one's profit in divines per hour. Pure: components/StratCalcView.jsx renders it,
// test/stratcalc.test.mjs and backend/tests/test_stratcalc_e2e.py pin it.
//
import { find, flatten, insertAt, locate, mapNode, pathOf, removeNode } from './tree.js'
import { saleValueRef } from './sales.js'

// The document (stored whole as the user kv `strat_calc`, backend/app/stratcalc.py):
//   { v, active: strat id | null, lastCur: the currency costs were last priced in, strats: [strat],
//     tree: the sidebar — [{ id, kind: 'strat' } | { id, kind: 'folder', name, open, children: [...] }],
//     every strat exactly once, in the order (and folders) the user dragged them into }
// A strat:
//   id, name, updatedAt (epoch ms of the last edit)
//   timer    — { startedAt: epoch ms | null, elapsedMs }: wall clock, so a tab switch or a restart
//              resumes from the stamp. Only one strat runs at a time.
//   time     — { on, ms }: when on, the session took this long (typed hours + minutes), not the timer's
//   loot     — [row]: what the session dropped
//   maps     — { count: maps run, price: one map (juice included), cur }
//   tablets  — { lines: [{ id, base, name, slots, price, cur }] }: the tablets slotted in each map
//              (MAX_TABLETS in all). `name` is a unique's, `base` its tablet; both null is any normal
//              tablet. A tablet lasts its full uses (`uses`, the pipeline's kv_ops `tablet_uses`).
//              A line may carry `link`: { query, league, div, at } — a trade search built on the trade
//              site, priced at the average of its cheapest ten listings (div, found at `at`). A typed
//              `price` wins; a null price means "the link's".
//   override — { on, amount, cur }: when on, the maps + tablets cost is this total instead
//   fixed    — [row]: one-off costs
// A row is { cur: a priced id | null, name: a custom item's name | null, qty, price: divines per unit
// typed by the user | null }; a typed price beats the market's. A unique also carries its `base` and
// the `floor` its background trade search found ({ div, at } | null): typed price > floor > market.
// `prices` is divines per unit of every priced id and `uses` the tablets' full uses
// ([{ name, base, uses }]), both from GET /api/strategy/calc.

export const VERSION = 1
// The backend's limits (backend/app/stratcalc.py MAX_ID, MAX_ROWS, MAX_DEPTH): every action stays inside
// them, so the view can never write a document the backend refuses (a refused save would stop all saving).
export const MAX_NAME = 120
export const MAX_ROWS = 200
export const MAX_DEPTH = 8
export const MAX_STRATS = 500
const clip = (s) => String(s ?? '').trim().slice(0, MAX_NAME)
const LOOT_DEFAULT = ['divine', 'exalted', 'chaos']
const DEFAULT_COST_CUR = 'chaos'

const amount = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0 }
const row = (cur) => ({ cur, name: null, qty: 0, price: null })

export const blankDoc = () => ({ v: VERSION, active: null, lastCur: DEFAULT_COST_CUR, strats: [], tree: [] })
const leaf = (id) => ({ id, kind: 'strat' })

function blankStrat(id, name, now, cur) {
  return {
    id, name, updatedAt: now,
    timer: { startedAt: null, elapsedMs: 0 },
    time: { on: false, ms: 0 },
    loot: LOOT_DEFAULT.map(row),
    maps: { count: 0, price: 0, cur },
    tablets: { lines: [] },
    override: { on: false, amount: 0, cur },
    fixed: [],
  }
}

// ---------------------------------------------------------------- strats (the sidebar)
export const activeStrat = (doc) => doc.strats.find(s => s.id === doc.active) ?? null

export const newStrat = (doc, { id, name, now }) => doc.strats.length >= MAX_STRATS ? doc :
  ({ ...doc, active: id, strats: [blankStrat(id, clip(name), now, doc.lastCur), ...doc.strats], tree: [leaf(id), ...(doc.tree || [])] })

export const select = (doc, id) => (doc.active !== id && doc.strats.some(s => s.id === id) ? { ...doc, active: id } : doc)

// Apply `fn` to one strat and stamp it.
export const edit = (doc, id, fn, now) =>
  ({ ...doc, strats: doc.strats.map(s => (s.id === id ? { ...fn(s), updatedAt: now } : s)) })

export function rename(doc, id, name, now) {
  const n = clip(name)
  return n ? edit(doc, id, s => ({ ...s, name: n }), now) : doc
}

// The currency a cost is priced in; remembered for the next strat.
export const setCostCur = (doc, id, part, cur, now) =>
  ({ ...edit(doc, id, s => ({ ...s, [part]: { ...s[part], cur } }), now), lastCur: cur })

// Start the strat, pausing whichever one was running; or pause it if it is the one running.
export function toggle(doc, id, now) {
  const target = doc.strats.find(s => s.id === id)
  if (!target) return doc
  const on = running(target.timer)
  return {
    ...doc,
    strats: doc.strats.map(s => {
      // starting the clock means the clock counts again: the time override goes off
      if (s.id === id) return on ? { ...s, timer: stop(s.timer, now), updatedAt: now } : { ...s, timer: start(s.timer, now), time: { ...s.time, on: false }, updatedAt: now }
      return running(s.timer) ? { ...s, timer: stop(s.timer, now), updatedAt: now } : s
    }),
  }
}

// Run the same strat again: the setup carries over (prices, tablets, override, fixed costs, which
// loot it tracks), the counts and the clock start from zero. Named "<name> N", the next free N.
export function duplicate(doc, srcId, { id, now }) {
  const src = doc.strats.find(s => s.id === srcId)
  if (!src || doc.strats.length >= MAX_STRATS) return doc
  const base = src.name.replace(/ \d+$/, '')
  const taken = new Set(doc.strats.map(s => s.name))
  let n = 2
  const named = (k) => `${base.slice(0, MAX_NAME - ` ${k}`.length)} ${k}`
  while (taken.has(named(n))) n++
  const copy = {
    ...structuredClone(src),
    id, name: named(n), updatedAt: now,
    timer: { startedAt: null, elapsedMs: 0 },
    time: { on: false, ms: 0 },
    loot: src.loot.map(r => ({ ...r, qty: 0 })),
    maps: { ...src.maps, count: 0 },
  }
  const at = locate(doc.tree, srcId)
  const tree = at ? insertAt(doc.tree, leaf(id), at.parentId, at.index + 1) : [leaf(id), ...(doc.tree || [])]
  return { ...doc, active: id, strats: [copy, ...doc.strats], tree }
}

const byRecent = (a, b) => b.updatedAt - a.updatedAt

// Remove a strat; the next most recent opens. `removed` restores it (the Undo toast).
export function removeStrat(doc, id) {
  const strat = doc.strats.find(s => s.id === id)
  const strats = doc.strats.filter(s => s.id !== id)
  const active = doc.active === id ? ([...strats].sort(byRecent)[0]?.id ?? null) : doc.active
  const at = locate(doc.tree, id)
  return {
    doc: { ...doc, strats, active, tree: removeNode(doc.tree, id) },
    removed: strat ? { strat, wasActive: doc.active === id, parentId: at?.parentId ?? null, index: at?.index ?? 0 } : null,
  }
}

// One clock at a time holds through an undo: if another strat started meanwhile, the restored one comes
// back paused, its time banked up to that start.
export function restoreStrat(doc, removed) {
  if (!removed || doc.strats.some(s => s.id === removed.strat.id)) return doc
  let strat = removed.strat
  const other = doc.strats.find(s => running(s.timer))
  if (other && running(strat.timer)) strat = { ...strat, timer: stop(strat.timer, Math.max(strat.timer.startedAt, other.timer.startedAt)) }
  const back = (removed.parentId && !find(doc.tree, removed.parentId)) ? [leaf(strat.id), ...doc.tree]
    : insertAt(doc.tree, leaf(strat.id), removed.parentId, removed.index)
  return { ...doc, strats: [strat, ...doc.strats], tree: back, active: removed.wasActive ? strat.id : doc.active }
}

// ---------------------------------------------------------------- folders (the sidebar tree)
export const newFolder = (doc, { id, name }) =>
  ({ ...doc, tree: [{ id, kind: 'folder', name: clip(name), open: true, children: [] }, ...(doc.tree || [])] })

// Folder levels: how deep `parentId` sits (a top-level folder is 1), and how many a subtree holds.
const levelOf = (tree, id) => (id ? (pathOf(tree, id)?.length ?? 0) + 1 : 0)
const height = (n) => (n.kind === 'folder' ? 1 + Math.max(0, ...(n.children || []).map(height)) : 0)

// Drag a strat or a folder to `index` under `parentId` (null = the top level); never a folder into itself.
export function moveNode(doc, id, parentId, index) {
  const node = find(doc.tree, id)
  if (!node) return doc
  if (parentId && (parentId === id || find(node.children || [], parentId) || find(doc.tree, parentId)?.kind !== 'folder')) return doc
  if (levelOf(doc.tree, parentId) + height(node) > MAX_DEPTH) return doc
  return { ...doc, tree: insertAt(removeNode(doc.tree, id), node, parentId, index) }
}

export function renameFolder(doc, id, name) {
  const n = clip(name)
  return n ? { ...doc, tree: mapNode(doc.tree, id, f => ({ ...f, name: n })) } : doc
}

export const flattenFolders = (tree) => flatten(tree, n => n.kind === 'folder')
export const treeIds = (tree) => flatten(tree).map(n => n.id)

export const setOpen = (doc, id, open) => ({ ...doc, tree: mapNode(doc.tree, id, f => ({ ...f, open })) })

// Remove a folder but keep its strats: they move up into its place. `removed` restores it (Undo).
export function removeFolder(doc, id) {
  const at = locate(doc.tree, id)
  if (!at || at.node.kind !== 'folder') return { doc, removed: null }
  let tree = removeNode(doc.tree, id)
  at.node.children.forEach((c, i) => { tree = insertAt(tree, c, at.parentId, at.index + i) })
  return { doc: { ...doc, tree }, removed: at }
}

export function restoreFolder(doc, removed) {
  if (!removed) return doc
  let tree = doc.tree
  for (const n of flatten(removed.node.children)) tree = removeNode(tree, n.id)
  return { ...doc, tree: insertAt(tree, removed.node, removed.parentId, removed.index) }
}

// Delete a folder with everything in it (its folders and strats). `removed` restores all of it (Undo).
export function removeFolderDeep(doc, id) {
  const at = locate(doc.tree, id)
  if (!at || at.node.kind !== 'folder') return { doc, removed: null }
  const gone = new Set(flatten(at.node.children).filter(n => n.kind === 'strat').map(n => n.id))
  const strats = doc.strats.filter(s => !gone.has(s.id))
  const active = gone.has(doc.active) ? ([...strats].sort(byRecent)[0]?.id ?? null) : doc.active
  return {
    doc: { ...doc, strats, active, tree: removeNode(doc.tree, id) },
    removed: { ...at, strats: doc.strats.filter(s => gone.has(s.id)), wasActive: gone.has(doc.active) ? doc.active : null },
  }
}

export function restoreFolderDeep(doc, removed) {
  if (!removed) return doc
  const tree = (removed.parentId && !find(doc.tree, removed.parentId)) ? [removed.node, ...doc.tree]
    : insertAt(doc.tree, removed.node, removed.parentId, removed.index)
  const other = doc.strats.find(s => running(s.timer))   // one clock at a time holds through an undo
  const back = removed.strats.map(s => (other && running(s.timer) ? { ...s, timer: stop(s.timer, Math.max(s.timer.startedAt, other.timer.startedAt)) } : s))
  return { ...doc, tree, strats: [...back, ...doc.strats], active: removed.wasActive ?? doc.active }
}

// A stored tree, reconciled with the strats: folders kept, every strat exactly once, a strat the tree
// lost comes back on top, a reference to a strat that is gone drops out.
function reconcile(rawTree, strats) {
  const have = new Set(strats.map(s => s.id)), seen = new Set()
  const walk = (nodes) => {
    const out = []
    for (const n of Array.isArray(nodes) ? nodes : []) {
      if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !n.id || seen.has(n.id)) continue
      if (n.kind === 'folder' && typeof n.name === 'string' && n.name.trim() && !have.has(n.id)) {
        seen.add(n.id)
        out.push({ id: n.id, kind: 'folder', name: clip(n.name), open: n.open !== false, children: walk(n.children) })
      } else if (n.kind === 'strat' && have.has(n.id)) {
        seen.add(n.id)
        out.push(leaf(n.id))
      }
    }
    return out
  }
  const tree = walk(rawTree)
  return [...strats.filter(s => !seen.has(s.id)).map(s => leaf(s.id)), ...tree]
}

// ---------------------------------------------------------------- timer
export const running = (t) => t?.startedAt != null
export const elapsedMs = (t, now) => (t?.elapsedMs || 0) + (running(t) ? Math.max(0, now - t.startedAt) : 0)
export const start = (t, now) => (running(t) ? t : { startedAt: now, elapsedMs: t?.elapsedMs || 0 })
export const stop = (t, now) => (running(t) ? { startedAt: null, elapsedMs: elapsedMs(t, now) } : t)
// The clock corrected by hand (a forgotten pause): a running clock keeps running from the new time.
export const setElapsed = (t, ms, now) => (running(t) ? { startedAt: now, elapsedMs: ms } : { startedAt: null, elapsedMs: ms })

// The time override: the session took this long, whatever the timer says. Turning it on starts from
// the clock's time (so the rate does not jump) and pauses the timer; a time already typed is kept.
export function timeOverrideOn(s, now) {
  const ms = s.time?.ms > 0 ? s.time.ms : elapsedMs(s.timer, now)
  return { ...s, timer: stop(s.timer, now), time: { on: true, ms } }
}
export const hm = (ms) => { const m = Math.floor(Math.max(0, ms) / 60_000); return { h: Math.floor(m / 60), m: m % 60 } }
export const fromHm = (h, m) => ((Number(h) || 0) * 60 + (Number(m) || 0)) * 60_000

export function clock(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000)
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

// ---------------------------------------------------------------- rows
export const rowKey = (r) => r.cur ?? (r.base ? `unique:${r.name}|${r.base}` : `custom:${r.name}`)
export const setQty = (rows, key, qty) => rows.map(r => (rowKey(r) === key ? { ...r, qty } : r))
// One more (or `k` more, -1 to take one back) of a row, never below zero.
export const bump = (rows, key, k) => rows.map(r => (rowKey(r) === key ? { ...r, qty: Math.max(0, (Number(r.qty) || 0) + k) } : r))
// A typed price (divines per unit) for one row; null goes back to the market's.
export const setPrice = (rows, key, price) => rows.map(r => (rowKey(r) === key ? { ...r, price } : r))
export const removeRow = (rows, key) => rows.filter(r => rowKey(r) !== key)
export const addRow = (rows, cur) => (!cur || rows.length >= MAX_ROWS || rows.some(r => r.cur === cur) ? rows : [...rows, row(cur)])

// Something the market doesn't price (a unique, a jackpot drop): a name and its own price.
export function addCustom(rows, name, price) {
  const n = clip(name)
  if (!n || rows.length >= MAX_ROWS || rows.some(r => r.name != null && r.name.toLowerCase() === n.toLowerCase())) return rows
  return [...rows, { cur: null, name: n, qty: 0, price: price ?? null }]
}

// A unique, priced by a background trade search for its cheapest unidentified Instant Buyout copy.
export function addUnique(rows, { name, type }) {
  const r = { cur: null, name, qty: 0, price: null, base: type, floor: null }   // normalize's field order
  return !name || !type || rows.length >= MAX_ROWS || rows.some(x => rowKey(x) === rowKey(r)) ? rows : [...rows, r]
}

// The price floor: the cheapest listing in divines (a listing in a currency with no price is skipped).
// Listings (the trade site's asking prices) in divines, cheapest first; unpriceable ones left out.
// The listings worth something, each with its value in divines, cheapest first (a listing in a currency
// with no price is skipped). `cheapestListings` — the ten a linked search's price is averaged from (and
// whose currencies its line follows: stratPricing.searchCurrency).
const valued = (listings, prices) => (listings || []).filter(l => l.amount > 0)
  .map(l => ({ div: saleValueRef(l, 'divine', prices), currency: l.currency })).filter(v => v.div != null).sort((a, b) => a.div - b.div)
const listingDivs = (listings, prices) => valued(listings, prices).map(v => v.div)
export const AVG_OF = 10
export const cheapestListings = (listings, prices) => valued(listings, prices).slice(0, AVG_OF)

export const floorDiv = (listings, prices) => listingDivs(listings, prices)[0] ?? null

// Searched for when there is none or it is an hour old; never over a typed price.
export const FLOOR_TTL_MS = 3_600_000
// A search's price is due when it was never found (or ⟳ made it due: at 0) or is an hour old.
const due = (at, now) => !at || now - at >= FLOOR_TTL_MS
export const needsFloor = (r, now) => !!r.base && r.price == null && due(r.floor?.at, now)

// A found floor lands on its row without stamping the strat: a background price is not an edit.
export function recordFloor(doc, stratId, key, div, at) {
  const put = (rows) => rows.map(r => (rowKey(r) === key ? { ...r, floor: { div, at } } : r))
  return okDiv(div) ? quiet(doc, stratId, s => ({ ...s, loot: put(s.loot), fixed: put(s.fixed) })) : doc
}

// ---------------------------------------------------------------- tablet setups
export const MAX_TABLETS = 4    // slots on a map (three, four in a city)
export const lines = (s) => s.tablets?.lines ?? []
export const tabletSlots = (s) => lines(s).reduce((a, l) => a + l.slots, 0)

// A line's slots: at least one, never past the map's four with the other lines'.
const fit = (s, lid, n) => Math.max(1, Math.min(MAX_TABLETS - tabletSlots(s) + (lines(s).find(l => l.id === lid)?.slots ?? 0), Math.round(n) || 0))

export function addTablet(doc, sid, { id, now }) {
  const s = doc.strats.find(x => x.id === sid)
  if (!s || tabletSlots(s) >= MAX_TABLETS) return doc
  return edit(doc, sid, x => ({ ...x, tablets: { lines: [...lines(x), { id, base: null, name: null, slots: 1, price: 0, cur: doc.lastCur }] } }), now)
}

export function editTablet(doc, sid, lid, patch, now) {
  const next = edit(doc, sid, x => ({ ...x, tablets: { lines: lines(x).map(l => (l.id !== lid ? l : {
    ...l, ...patch, ...(patch.slots !== undefined ? { slots: fit(x, lid, patch.slots) } : {}),
  })) } }), now)
  return patch.cur ? { ...next, lastCur: patch.cur } : next
}

export const removeTablet = (doc, sid, lid, now) => edit(doc, sid, x => ({ ...x, tablets: { lines: lines(x).filter(l => l.id !== lid) } }), now)

// A tablet's full uses from the pipeline's table: a unique's own, a normal base's, or for any normal
// tablet the one number every normal base agrees on. null when the data does not say (never a guess).
export function usesOf(l, uses) {
  const table = uses ?? []
  if (l.name) return table.find(u => u.name === l.name)?.uses ?? null
  if (l.base) return table.find(u => u.name == null && u.base === l.base)?.uses ?? null
  const normal = new Set(table.filter(u => u.name == null).map(u => u.uses))
  return normal.size === 1 ? [...normal][0] : null
}
const tabletKey = (l) => `tablet:${l.name ?? l.base ?? 'any'}`

// One of a priced thing (a map, a tablet) in divines: the typed price in its currency, else what its
// linked search found.
const unitDiv = (x, prices) => (x.price != null ? worth(x.price, x.cur, prices) : x.link?.div ?? null)

// ---------------------------------------------------------------- a linked trade search
// Linking hands the price to the search; unlinked, the thing keeps the last price its search found,
// as a typed one. A found price lands without stamping the strat: a background price is not an edit.
export const MAX_QUERY = 20_000   // characters of a linked search (backend/app/stratcalc.py MAX_QUERY)
const fitsQuery = (q) => !!q && typeof q.query === 'object' && JSON.stringify(q).length <= MAX_QUERY
const okLink = (k) => fitsQuery(k?.query) && !!k?.league
const okDiv = (div) => Number.isFinite(div) && div >= 0
const linked = (x, { query, league }) => ({ ...x, price: null, link: { query, league, div: null, at: 0 } })
// Unlinked, the found price becomes a typed one in the line's own currency (the one its search
// followed); in divines when that currency has no price.
const unlinked = (prices) => ({ link, ...x }) => {
  if (x.price != null) return x
  const div = link?.div ?? 0, px = prices?.[x.cur]
  return px > 0 ? { ...x, price: div / px } : { ...x, price: div, cur: 'divine' }
}
// `cur`: the currency the search priced in. The line follows it on the first price after linking
// (stratPricing.searchCurrency) — never over a typed price, nor over a currency picked since.
const found = (div, at, cur) => (x) => (x.link
  ? { ...x, ...(cur && x.price == null && x.link.div == null ? { cur } : {}), link: { ...x.link, div, at } }
  : x)
const putLine = (lid, fn) => (x) => ({ ...x, tablets: { lines: lines(x).map(l => (l.id === lid ? fn(l) : l)) } })
const quiet = (doc, sid, fn) => (doc.strats.some(x => x.id === sid) ? { ...doc, strats: doc.strats.map(x => (x.id === sid ? fn(x) : x)) } : doc)

export const linkTablet = (doc, sid, lid, k, now) => (okLink(k) ? edit(doc, sid, putLine(lid, l => linked(l, k)), now) : doc)
export const unlinkTablet = (doc, sid, lid, now, prices) => edit(doc, sid, putLine(lid, unlinked(prices)), now)
export const recordLinkPrice = (doc, sid, lid, div, at, cur) => (okDiv(div) ? quiet(doc, sid, putLine(lid, found(div, at, cur))) : doc)
export const linkMaps = (doc, sid, k, now) => (okLink(k) ? edit(doc, sid, x => ({ ...x, maps: linked(x.maps, k) }), now) : doc)
export const unlinkMaps = (doc, sid, now, prices) => edit(doc, sid, x => ({ ...x, maps: unlinked(prices)(x.maps) }), now)
export const recordMapsPrice = (doc, sid, div, at, cur) => (okDiv(div) ? quiet(doc, sid, x => ({ ...x, maps: found(div, at, cur)(x.maps) })) : doc)
export const needsLinkPrice = (x, now) => !!x.link && x.price == null && due(x.link.at, now)

// Every price a strat holds from a search — unique floors, linked maps and tablet lines — through
// `row` and `link`: one walk for ⟳ (due now) and for sharing (no market data leaves the app).
const searched = (s, row, link) => {
  const rows = (list) => list.map(r => (r.base ? row(r) : r))
  const linked = (x) => (x.link ? link(x) : x)
  return { ...s, loot: rows(s.loot), fixed: rows(s.fixed), maps: linked(s.maps), tablets: { lines: lines(s).map(linked) } }
}

// ⟳ on a strat: its unique floors and linked searches are due now (an `at` of 0); the last prices stay
// on screen until the new ones land, and it is not an edit.
export const restale = (doc, sid) => quiet(doc, sid, s => searched(s,
  r => (r.floor ? { ...r, floor: { ...r.floor, at: 0 } } : r),
  x => ({ ...x, link: { ...x.link, at: 0 } })))
// The average of the cheapest ten listings, in divines (owner, 2026-10-01: "avg the cheapest 10").
export function avgDiv(listings, prices) {
  const vals = cheapestListings(listings, prices).map(v => v.div)
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
}

// How many tablets the maps run used up, line by line (a line whose uses are unknown counts none).
export const tabletsUsed = (s, uses) => lines(s).reduce((a, l) => { const n = usesOf(l, uses); return a + (n ? amount(s.maps?.count) * l.slots / n : 0) }, 0)

// ---------------------------------------------------------------- tally
// Below a minute on the clock a rate is noise (one drop in three seconds reads thousands an hour).
export const MIN_RATE_MS = 60_000

// `qty` of a row in divines; null when it has no price (and there is some of it).
export function rowValue(r, prices) {
  const q = amount(r.qty)
  if (q === 0) return 0
  const px = r.price != null ? r.price : r.floor ? r.floor.div : prices?.[r.cur]
  return Number.isFinite(px) && px >= 0 ? q * px : null
}

// `n` of `cur` in divines; null when it has no price (and there is some of it).
const worth = (n, cur, prices) => rowValue({ cur, qty: n, price: null }, prices)

// What the maps and the tablets cost, item by item (the override aside). `missing` collects what
// could not be priced: a currency without a price, or a tablet whose full uses are unknown.
function itemised(s, prices, uses, missing = new Set()) {
  const m = s.maps ?? {}
  const each = amount(m.count) ? unitDiv(m, prices) : 0
  const maps = each == null ? null : amount(m.count) * each
  if (maps == null) missing.add(m.price != null ? m.cur : 'maps')
  let tablets = 0
  for (const l of lines(s)) {
    const n = usesOf(l, uses)
    const each = unitDiv(l, prices)
    const v = n && each != null ? amount(s.maps?.count) * l.slots / n * each : null
    if (n == null) missing.add(tabletKey(l))
    else if (v == null) missing.add(l.price != null ? l.cur : tabletKey(l))
    tablets += v ?? 0
  }
  return { maps, tablets }
}

// Turn the override on, starting from the total already counted so the number does not jump. An
// amount already typed is kept; the itemised inputs stay for when it goes off again.
export function overrideOn(s, prices, uses) {
  const o = s.override
  if (o.amount > 0) return { ...s, override: { ...o, on: true } }
  const { maps, tablets } = itemised(s, prices, uses)
  const px = prices?.[o.cur]
  const amt = px > 0 ? ((maps ?? 0) + (tablets ?? 0)) / px : 0
  return { ...s, override: { ...o, on: true, amount: amt } }
}

export function tally(s, prices, now, uses) {
  const unpriced = new Set()
  const add = (v, key) => { if (v == null) { unpriced.add(key); return 0 } return v }
  const sum = (rows) => (rows || []).reduce((a, r) => a + add(rowValue(r, prices), rowKey(r)), 0)
  const loot = sum(s.loot)
  let maps = 0, tablets = 0, override = 0
  if (s.override?.on) {
    override = worth(amount(s.override.amount), s.override.cur, prices)
    add(override, s.override.cur)
  } else {
    ({ maps, tablets } = itemised(s, prices, uses, unpriced))
  }
  const fixed = sum(s.fixed)
  const costs = (maps ?? 0) + (tablets ?? 0) + (override ?? 0) + fixed
  const net = loot - costs
  const ms = s.time?.on ? (s.time.ms || 0) : elapsedMs(s.timer, now)
  const hours = ms / 3_600_000
  return {
    loot, maps, tablets, override, fixed, costs, net, hours,
    perHour: ms >= MIN_RATE_MS ? net / hours : null, unpriced: [...unpriced],
  }
}

// ---------------------------------------------------------------- input
// A number as people type it (1,5 · 3*12 · 40k): the shared number-box rule, lib/numInput.js.
export { parseNum } from './numInput.js'

// A typed session length, in ms: `1:04:12`, `1:30` (h:mm), `1h 20m`, `90m`, `1.5h`, or bare minutes.
export function parseDuration(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  if (!s) return null
  let m = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(s)
  if (m) return ((+m[1] * 60 + +m[2]) * 60 + +(m[3] ?? 0)) * 1000
  m = /^(?:(\d*\.?\d+)\s*h)?\s*(?:(\d*\.?\d+)\s*m)?\s*(?:(\d*\.?\d+)\s*s)?$/.exec(s)
  if (m && (m[1] || m[2] || m[3])) return Math.round(((+(m[1] ?? 0) * 60 + +(m[2] ?? 0)) * 60 + +(m[3] ?? 0)) * 1000)
  if (/^\d*\.?\d+$/.test(s)) return Math.round(Number(s) * 60_000)
  return null
}

// Where the keyboard is being used to type, so a shortcut must stay out of the way.
export function isTyping(el) {
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = String(el.tagName || '').toUpperCase()
  return tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !['button', 'checkbox', 'radio', 'range', 'submit'].includes(el.type))
}

// The calculator's keys, only while it is on screen (the view adds the listener on mount) and
// nothing is being typed or open over it: Space starts/pauses, M counts a map.
export function shortcut(e, { typing, overlay }) {
  if (typing || overlay || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return null
  if (e.code === 'Space' || e.key === ' ') return 'toggle'
  if (String(e.key).toLowerCase() === 'm') return 'map'
  return null
}

// ---------------------------------------------------------------- what is stored
// Whatever came back from storage, repaired into a valid calculator.
export function normalize(raw) {
  const d = blankDoc()
  if (!raw || typeof raw !== 'object' || raw.v !== VERSION || !Array.isArray(raw.strats)) return d
  const str = (v) => (typeof v === 'string' && v.trim() ? clip(v) : null)
  const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0)
  const whole = (v) => Math.floor(num(v))
  const lastCur = str(raw.lastCur) ?? DEFAULT_COST_CUR
  const rows = (list) => {
    const out = []
    for (const r of Array.isArray(list) ? list : []) {
      if (!r || typeof r !== 'object') continue
      const cur = str(r.cur), name = cur ? null : str(r.name)
      if (!cur && !name) continue
      const x = { cur, name, qty: whole(r.qty), price: Number.isFinite(r.price) && r.price >= 0 ? r.price : null }
      const base = name ? str(r.base) : null
      if (base) {
        const f = r.floor
        x.base = base
        x.floor = f && Number.isFinite(f.div) && f.div >= 0 && Number.isFinite(f.at) && f.at >= 0 ? { div: f.div, at: f.at } : null
      }
      if (!out.some(o => rowKey(o) === rowKey(x))) out.push(x)
    }
    return out.slice(0, MAX_ROWS)
  }
  const part = (p) => (p && typeof p === 'object' ? p : {})
  // A linked trade search, repaired; null when it is not one.
  const link = (k) => (k && typeof k === 'object' && fitsQuery(k.query) && str(k.league)
    ? { query: k.query, league: str(k.league), div: okDiv(k.div) ? k.div : null, at: Number.isFinite(k.at) && k.at >= 0 ? k.at : 0 } : null)
  // Tablet lines, four slots in all. A strat saved before setups (`perMap`) is one plain line.
  const tabletLines = (tb) => {
    const src = Array.isArray(tb.lines) ? tb.lines : whole(tb.perMap) > 0 ? [{ id: 'tablets', slots: tb.perMap, price: tb.price, cur: tb.cur }] : []
    const out = []
    let left = MAX_TABLETS
    for (const l of src) {
      const id = str(l?.id)
      if (!id || left < 1 || out.some(o => o.id === id)) continue
      const slots = Math.min(left, Math.max(1, whole(l.slots)))
      left -= slots
      const name = str(l.name)
      const x = { id, base: str(l.base), name, slots, price: l.price === null ? null : num(l.price), cur: str(l.cur) ?? lastCur }
      if (link(l.link)) x.link = link(l.link)
      out.push(x)
    }
    return out
  }
  const strats = []
  for (const s of raw.strats) {
    const id = str(s?.id)
    if (!id || strats.some(x => x.id === id)) continue
    const t = part(s.timer), m = part(s.maps), tb = part(s.tablets), o = part(s.override)
    strats.push({
      id, name: str(s.name) ?? 'Strat', updatedAt: num(s.updatedAt),
      timer: { startedAt: Number.isFinite(t.startedAt) ? t.startedAt : null, elapsedMs: num(t.elapsedMs) },
      time: { on: part(s.time).on === true, ms: num(part(s.time).ms) },
      loot: rows(s.loot),
      maps: { count: whole(m.count), price: m.price === null ? null : num(m.price), cur: str(m.cur) ?? lastCur, ...(link(m.link) ? { link: link(m.link) } : {}) },
      tablets: { lines: tabletLines(tb) },
      override: { on: o.on === true, amount: num(o.amount), cur: str(o.cur) ?? lastCur },
      fixed: rows(s.fixed),
    })
  }
  // One strat runs at a time: the latest start keeps running; any other banks up to that start.
  const live = strats.filter(s => running(s.timer)).sort((a, b) => b.timer.startedAt - a.timer.startedAt)
  for (const s of live.slice(1)) s.timer = stop(s.timer, Math.max(s.timer.startedAt, live[0].timer.startedAt))
  const active = strats.some(s => s.id === raw.active) ? raw.active : ([...strats].sort(byRecent)[0]?.id ?? null)
  return { v: VERSION, active, lastCur, strats, tree: reconcile(raw.tree, strats) }
}

// ---------------------------------------------------------------- display
// "Strat N", the first number no strat is using.
export function nextName(doc) {
  const taken = new Set(doc.strats.map(s => s.name))
  let n = 1
  while (taken.has(`Strat ${n}`)) n++
  return `Strat ${n}`
}

// Decimals for an amount of divines: a session's numbers run from a few exalted to hundreds of divines.
export const divDigits = (v) => { const a = Math.abs(v); return a >= 100 ? 0 : a >= 10 ? 1 : a >= 0.1 || a === 0 ? 2 : 3 }

// ---------------------------------------------------------------- sharing (.arbiterstrat files)
// A strat or a folder of them, written to a file someone else imports (owner, 2026-10-01). It carries
// everything about the strats — setup and results, linked searches included — but never market data
// (a unique's floor, what a linked search found: the importer looks them up again) and never a
// running clock. Importing gives copies in an "Imported" folder, repaired like saved data; a file that
// cannot be read whole imports nothing.
export const SHARE_KIND = 'arbiter-strat'
export const SHARE_VERSION = 1
export const IMPORTED = 'Imported'

const unpriced = (s) => searched(s, r => ({ ...r, floor: null }), x => ({ ...x, link: { ...x.link, div: null, at: 0 } }))

export function exportStrats(doc, nodeId, now) {
  const node = find(doc.tree, nodeId)
  if (!node) return null
  const ids = new Set(node.kind === 'folder' ? flatten([node]).filter(n => n.kind === 'strat').map(n => n.id) : [node.id])
  const strats = doc.strats.filter(s => ids.has(s.id))
    .map(s => unpriced({ ...s, timer: { startedAt: null, elapsedMs: elapsedMs(s.timer, now) } }))
  return JSON.stringify({ kind: SHARE_KIND, v: SHARE_VERSION, tree: [node], strats }, null, 2)
}

export function importStrats(doc, text, { newId, now }) {
  let file
  try { file = JSON.parse(text) } catch { return null }
  if (!file || file.kind !== SHARE_KIND || file.v !== SHARE_VERSION || !Array.isArray(file.strats) || !file.strats.length) return null
  const got = normalize({ v: VERSION, active: null, lastCur: doc.lastCur, strats: file.strats, tree: Array.isArray(file.tree) ? file.tree : [] })
  if (!got.strats.length || doc.strats.length + got.strats.length > MAX_STRATS) return null
  if (1 + Math.max(0, ...got.tree.map(height)) > MAX_DEPTH) return null
  const ids = new Map()
  const fresh = (id, kind) => { if (!ids.has(id)) ids.set(id, newId(kind)); return ids.get(id) }
  const renamed = (n) => (n.kind === 'folder' ? { ...n, id: fresh(n.id, 'f'), children: (n.children || []).map(renamed) } : { ...n, id: fresh(n.id, 's') })
  const tree = got.tree.map(renamed)
  const strats = got.strats.map(s => unpriced({ ...s, id: fresh(s.id, 's'), updatedAt: now, timer: { startedAt: null, elapsedMs: s.timer.elapsedMs } }))
  let base = doc
  let folder = doc.tree.find(n => n.kind === 'folder' && n.name === IMPORTED)
  if (!folder) { base = newFolder(doc, { id: newId('f'), name: IMPORTED }); folder = base.tree[0] }
  const into = (t) => t.map(n => (n.id === folder.id ? { ...n, open: true, children: [...(n.children || []), ...tree] } : n))
  return { doc: { ...base, strats: [...base.strats, ...strats], tree: into(base.tree) }, count: strats.length }
}
