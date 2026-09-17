import { create } from 'zustand'
import { api, cleanErr, toast } from './api.js'
import { uid } from './session.js'
import { find as findNode, findWhere, locate, flatten, mapNode, mapAll, removeNode, insertAt } from './tree.js'
import { diag } from './diag.js'

// The Trading workspace: a nested filesystem-like tree (folders + search items), plus the
// persisted `layout`/`openTabs` fields (kept in the document for forward compatibility).
// Backed by user.sqlite via /api/trading/workspace; the flat `watches` blob was migrated into
// this (migration #2).
//
// The store is the single source of truth for the tree; mutations persist through a
// debounced PUT so drag/rename/nest survive reload + restart. The league is never stored
// on a node — it's injected at open time (tradeUrl), so watches survive league resets.
//
// Save lifecycle: every mutation marks the document `dirty` and schedules the debounced PUT;
// `flush()` cancels the debounce and PUTs now (page hide, app quit). `saveState` is
// idle | dirty | saving | error — the rail head shows it as a dot.

const DEBOUNCE = 700
let saveTimer = null
let armed = false   // don't PUT while hydrating the initial load

// The ExiledExchange2 History folder: found by `sys` at any depth (the user may rename/move it).
export const HISTORY_SYS = 'ee2-history'
export const HISTORY_NAME = 'ExiledExchange2 History'
export const HISTORY_CAP = 200       // default rows kept in the history folder (newest first); Settings can change it
export const HISTORY_RETENTION_DAYS = 14
export const HISTORY_PREFS = Object.freeze({ enabled: true, max: HISTORY_CAP, retentionDays: HISTORY_RETENTION_DAYS })
export const HISTORY_MAX_LIMIT = 1000  // the backend's 5000-node guard leaves room; Settings clamps 20…1000
export const MAX_Q_BYTES = 16 * 1024 // a q larger than this is dropped (degraded row), never PUT
const DAY = 86400000

// Keep every PUT inside the backend's limits (it validates and never truncates, so a rejection
// would mean a bug here): drop oversize q's, trim the history folder to its cap. Pure; untouched
// nodes are returned as-is.
export function sanitize(tree, cap = HISTORY_MAX_LIMIT) {
  return (tree || []).map(n => {
    let out = n
    if (n.kind === 'search' && typeof n.q === 'string' && n.q.length > MAX_Q_BYTES) out = { ...n, q: null, degraded: true }
    if (n.kind === 'folder' && n.children) {
      let kids = sanitize(n.children, cap)
      if (n.sys === HISTORY_SYS && kids.length > cap) kids = kids.slice(0, cap)
      if (kids !== n.children && (kids.length !== n.children.length || kids.some((k, i) => k !== n.children[i]))) out = { ...out, children: kids }
    }
    return out
  })
}

function payload(get) {
  const { version, tree, layout, openTabs, activeId } = get()
  return { version, tree: sanitize(tree), layout, openTabs, activeId }
}

// The history folder's children after the folder rules: `rows` newest-first, capped and expired.
function trimHistory(rows, prefs, now) {
  const cutoff = now - (prefs.retentionDays || HISTORY_RETENTION_DAYS) * DAY
  let out = rows.filter(r => !(typeof r.ts === 'number') || r.ts >= cutoff)
  const expired = rows.length - out.length
  const max = Math.max(1, prefs.max || HISTORY_CAP)
  const pruned = Math.max(0, out.length - max)
  if (pruned) out = out.slice(0, max)
  return { rows: out, expired, pruned }
}

let pendingIntents = []   // intents that arrived before the document hydrated (applied in order after)

// A portable copy of the curated workspace: the history folder (and its `sys` marker) never travels.
export function exportWorkspace(tree) {
  const strip = (ns) => (ns || []).filter(n => !(n.kind === 'folder' && n.sys)).map(n => n.children ? { ...n, children: strip(n.children) } : n)
  return { version: 2, exportedAt: new Date().toISOString(), tree: strip(tree) }
}
const remint = (ns, taken) => (ns || []).map(n => {
  let id = n.id
  if (!id || taken.has(id)) id = 'n_' + uid()
  taken.add(id)
  return n.children ? { ...n, id, children: remint(n.children, taken) } : { ...n, id }
})

async function save(get, set) {
  clearTimeout(saveTimer); saveTimer = null
  if (!armed || get().loadError) return
  set({ saveState: 'saving' })
  try {
    await api.putWorkspace(payload(get))
    // A mutation that landed while the PUT was in flight re-dirtied the document; its own
    // debounce is pending, so leave the state alone.
    if (get().saveState === 'saving') set({ saveState: 'idle' })
  } catch (e) {
    set({ saveState: 'error' })
    toast(cleanErr(e), false)
    diag('ws', `ws-save fail err="${cleanErr(e).slice(0, 120)}"`)
  }
}

function persist(get, set) {
  if (!armed || get().loadError) return
  set({ saveState: 'dirty' })
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => save(get, set), DEBOUNCE)
}

export const newFolder = (name = 'New group') => ({
  id: 'n_' + uid(), kind: 'folder', name, open: true, children: [],
})
export const searchNode = (parsed, name) => ({
  id: 'n_' + uid(), kind: 'search',
  name: name || `Search ${String(parsed.slug || '').slice(0, 6)}`,
  auto: true,   // auto-named; cleared once the user renames so we stop overwriting it
  type: parsed.type || 'search', slug: parsed.slug, live: !!parsed.live, done: false,
  armed: false,   // "go live" — PERSISTED in the DB; the engine is reconciled to match it
  notify: { sound: true, orb: true, os: true },
})

export const useWorkspace = create((set, get) => ({
  version: 2,
  tree: [],
  layout: null,
  openTabs: [],
  loaded: false,
  loadError: null,  // set when the GET failed: the tree is NOT the user's and must never be written back
  saveState: 'idle',   // idle | dirty | saving | error
  league: '',          // the app's top-bar league (App keeps it current): stamped on history rows, filters the folder
  historyPrefs: { ...HISTORY_PREFS },   // mirrors settings.ee2History (enabled / max / retentionDays)
  lastHistoryEvent: null,   // { type:'add'|'bump'|'cap'|'expire'|'clear', … } — the renderer's telemetry hook reads this
  activeId: null,   // which search entry is open in the trade window (persisted → restores on relaunch)

  setActive: (id) => { if (get().loadError) return; set({ activeId: id }); persist(get, set) },

  hydrate: (doc) => {
    armed = false
    set({
      version: 2,
      loadError: null,
      saveState: 'idle',
      tree: Array.isArray(doc?.tree) ? doc.tree : [],
      layout: doc?.layout ?? null,
      openTabs: Array.isArray(doc?.openTabs) ? doc.openTabs : [],
      activeId: doc?.activeId ?? null,   // reopen the last-open search on relaunch
      loaded: true,
    })
    // arm on the next tick so hydrate itself doesn't trigger a save
    setTimeout(() => {
      armed = true
      // Producers that fired before the document loaded: apply in arrival order, then expire once.
      const queued = pendingIntents; pendingIntents = []
      for (const i of queued) get().ingest(i)
      get().expireHistory(Date.now())
    }, 0)
  },

  setLeague: (league) => { if (league !== get().league) set({ league: league || '' }) },
  setHistoryPrefs: (patch) => set(s => ({ historyPrefs: { ...s.historyPrefs, ...patch } })),

  // A load failure leaves an EMPTY tree that is not the user's. Every mutation is refused (and
  // persist stays disarmed) until a retry hydrates the real document — otherwise the first
  // edit would PUT that empty tree over the saved one.
  failLoad: (message) => { armed = false; clearTimeout(saveTimer); set({ loaded: true, loadError: message || 'load failed', tree: [], activeId: null, saveState: 'idle' }) },

  // PUT now (cancelling the debounce). Resolves when the request settled either way.
  flush: () => (saveTimer || get().saveState !== 'idle' ? save(get, set) : Promise.resolve()),

  setLayout: (patch) => { if (get().loadError) return; set(s => ({ layout: { ...(s.layout || {}), ...patch } })); persist(get, set) },

  addFolder: (parentId = null) => {
    if (get().loadError) return null
    const f = newFolder()
    set(s => parentId
      ? { tree: mapNode(s.tree, parentId, n => ({ ...n, open: true, children: [...(n.children || []), f] })) }
      : { tree: [...s.tree, f] })
    persist(get, set); return f.id
  },
  addSearch: (parentId, parsed, name) => {
    if (get().loadError) return null
    const node = searchNode(parsed, name)
    set(s => parentId
      ? { tree: mapNode(s.tree, parentId, n => ({ ...n, open: true, children: [...(n.children || []), node] })) }
      : { tree: [...s.tree, node] })
    persist(get, set); return node.id
  },
  // System folders (the history folder) keep their name; everything else renames and stops auto-naming.
  rename: (id, name) => { if (get().loadError) return; set(s => ({ tree: mapNode(s.tree, id, n => (n.kind === 'folder' && n.sys ? n : { ...n, name, auto: false })) })); persist(get, set) },
  // The DOM scraper's name: only for SEARCH rows still marked auto (never a folder, never a renamed/ingested row).
  autoName: (id, name) => { if (get().loadError) return; set(s => ({ tree: mapNode(s.tree, id, n => (n.kind !== 'search' || n.auto === false ? n : { ...n, name })) })); persist(get, set) },
  setField: (id, patch) => { if (get().loadError) return; set(s => ({ tree: mapNode(s.tree, id, n => ({ ...n, ...patch })) })); persist(get, set) },
  toggleOpen: (id) => { if (get().loadError) return; set(s => ({ tree: mapNode(s.tree, id, n => ({ ...n, open: !n.open })) })); persist(get, set) },
  // A copy of a search right after its source: same query, fresh id, never live/done.
  duplicate: (id) => {
    if (get().loadError) return null
    const where = locate(get().tree, id)
    if (!where || where.node.kind !== 'search') return null
    const copy = { ...where.node, id: 'n_' + uid(), name: `${where.node.name} copy`, auto: false, armed: false, done: false }
    set(s => ({ tree: insertAt(s.tree, copy, where.parentId, where.index + 1) }))
    persist(get, set); return copy.id
  },
  // Returns { node, parentId, index } — exactly what restore() needs to undo the delete.
  remove: (id) => {
    if (get().loadError) return null
    const where = locate(get().tree, id)
    if (!where) return null
    set(s => {
      const tree = removeNode(s.tree, id)
      // If the removed subtree contained the open search, drop the selection so the trade
      // window doesn't point at a node that no longer exists.
      const activeId = findNode(tree, s.activeId) ? s.activeId : null
      return { tree, openTabs: s.openTabs.filter(t => t !== id), activeId }
    })
    persist(get, set)
    return where
  },
  // Undo a remove(): re-insert the subtree at its old spot (root if the parent is gone too).
  restore: ({ node, parentId, index }) => {
    if (get().loadError || !node || findNode(get().tree, node.id)) return
    set(s => {
      const parentOk = !parentId || findNode(s.tree, parentId)
      const p = parentOk ? parentId : null
      const list = p ? (findNode(s.tree, p).children || []) : s.tree
      return { tree: insertAt(s.tree, node, p, Math.min(index, list.length)) }
    })
    persist(get, set)
  },

  // Move `id` into `parentId` (null = root) at `index`. Used by react-arborist onMove.
  move: (id, parentId, index) => {
    if (get().loadError) return
    set(s => {
      const node = findNode(s.tree, id)
      if (!node) return {}
      // Refuse to move a node into itself or its own descendant — that would remove the
      // subtree and have nowhere to re-insert it (silent data loss).
      if (parentId && (parentId === id || findNode(node.children || [], parentId))) return {}
      return { tree: insertAt(removeNode(s.tree, id), node, parentId, index) }
    })
    persist(get, set)
  },

  // Find a system folder (by `sys`, anywhere) or create it at root index 0.
  ensureFolder: (sysKey, name) => {
    const hit = findWhere(get().tree, n => n.kind === 'folder' && n.sys === sysKey)
    if (hit) return hit.id
    const f = { ...newFolder(name), sys: sysKey }
    set(s => ({ tree: [f, ...s.tree] }))
    persist(get, set); return f.id
  },
  prependSearch: (parentId, node) => {
    set(s => ({ tree: parentId ? insertAt(s.tree, node, parentId, 0) : [node, ...s.tree] }))
    persist(get, set)
  },

  // THE one entry point for every producer (roadmap §4.1): the clipboard rungs today, the EE2
  // item stream in batch 3. `intent` = { source, origin?, q?|slug?, type?, live?, name, item?,
  // folder (sys key | null), targetId? (clipboard: the user's chosen folder) }. Returns
  // { result: 'added'|'dup'|'dropped', id?, reason? }.
  ingest: (intent) => {
    if (get().loadError) return { result: 'dropped', reason: 'load-error' }
    if (!get().loaded) { pendingIntents.push(intent); return { result: 'buffered' } }
    if (intent.q && intent.q.length > MAX_Q_BYTES) return { result: 'dropped', reason: 'oversize' }
    if (intent.folder === HISTORY_SYS) return get()._ingestHistory(intent)
    const st = get()
    const same = intent.q
      ? findWhere(st.tree, n => n.kind === 'search' && n.q === intent.q)
      : intent.slug ? findWhere(st.tree, n => n.kind === 'search' && n.slug === intent.slug) : null
    if (same) { set({ activeId: same.id }); persist(get, set); return { result: 'dup', id: same.id } }
    const node = {
      ...searchNode({ type: intent.type || 'search', slug: intent.slug || '', live: !!intent.live }, intent.name),
      auto: intent.q ? false : true,          // rows born from a query keep their parsed name
      q: intent.q || null, origin: intent.origin || intent.source, ts: Date.now(),
      ...(intent.item ? { item: intent.item } : {}), ...(intent.degraded ? { degraded: true } : {}),
    }
    // Clipboard target: the chosen folder unless it is the history folder (never a clipboard target).
    let target = intent.targetId ? findNode(get().tree, intent.targetId) : null
    if (!target || target.kind !== 'folder' || target.sys === HISTORY_SYS) target = null
    set(s => ({ tree: target
      ? mapNode(s.tree, target.id, n => ({ ...n, open: true, children: [...(n.children || []), node] }))
      : [...s.tree, node], activeId: node.id }))
    persist(get, set)
    return { result: 'added', id: node.id }
  },

  // The item stream (roadmap §9): one atomic set() — dedupe per league (bump), newest first, cap,
  // expiry — never selects, never touches rows outside the folder.
  _ingestHistory: (intent) => {
    const { historyPrefs: prefs, league } = get()
    if (!prefs.enabled) return { result: 'dropped', reason: 'disabled' }
    const fid = get().ensureFolder(HISTORY_SYS, HISTORY_NAME)
    const now = Date.now()
    let result = intent.degraded || !intent.q ? 'degraded' : 'added', bumpedAge = 0, inherited = null
    const node = {
      ...searchNode({ type: 'search', slug: '', live: false }, intent.name),
      auto: false, q: intent.q || null, origin: intent.origin || intent.source, ts: now, league,
      ...(intent.item ? { item: intent.item } : {}), ...(intent.degraded || !intent.q ? { degraded: true } : {}),
    }
    let stats = { expired: 0, pruned: 0 }
    set(s => ({ tree: mapNode(s.tree, fid, f => {
      let kids = f.children || []
      if (node.q) {
        const twin = kids.find(k => k.q === node.q && k.league === league)
        if (twin) { result = 'bumped'; bumpedAge = now - (twin.ts || now); inherited = twin.name; kids = kids.filter(k => k !== twin) }
      }
      const fresh = inherited ? { ...node, name: inherited } : node
      const t = trimHistory([fresh, ...kids], prefs, now)
      stats = t
      return { ...f, children: t.rows }
    }) }))
    set({ lastHistoryEvent: { type: result, name: node.name, total: findNode(get().tree, fid).children.length, age: bumpedAge, cfgLeague: intent.cfgLeague, league, ...stats, at: now } })
    persist(get, set)
    return { result, id: node.id, pruned: stats.pruned, expired: stats.expired }
  },

  // Batch 5 QOL — all store-level, all undo-friendly where they destroy anything.
  // A clipboard/promoted row with both q and slug: forget the site's search id and re-run the query.
  rerunFromItem: (id) => {
    const n = findNode(get().tree, id)
    if (get().loadError || !n || n.kind !== 'search' || !n.q) return false
    set(s => ({ tree: mapNode(s.tree, id, x => ({ ...x, slug: '' })), activeId: id }))
    persist(get, set); return true
  },
  // Folders first, then A–Z (case-insensitive); `null` sorts the root.
  sortChildren: (folderId) => {
    if (get().loadError) return
    const by = (a, b) => (a.kind === 'folder') === (b.kind === 'folder') ? String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }) : (a.kind === 'folder' ? -1 : 1)
    set(s => ({ tree: folderId ? mapNode(s.tree, folderId, f => ({ ...f, children: [...(f.children || [])].sort(by) })) : [...s.tree].sort(by) }))
    persist(get, set)
  },
  // Several nodes, one undo slot: returns the remove() records in document order (deepest-first
  // restore order is handled by restoreMany).
  removeMany: (ids) => {
    if (get().loadError) return []
    const recs = []
    for (const id of ids) { const w = locate(get().tree, id); if (!w) continue; recs.push({ ...w, order: recs.length }) }
    if (!recs.length) return []
    set(s => {
      let tree = s.tree
      for (const r of recs) tree = removeNode(tree, r.node.id)
      const activeId = findNode(tree, s.activeId) ? s.activeId : null
      return { tree, activeId, openTabs: s.openTabs.filter(t => !ids.includes(t)) }
    })
    persist(get, set)
    return recs
  },
  restoreMany: (recs) => { for (const r of [...(recs || [])].sort((a, b) => a.index - b.index)) get().restore(r) },
  // Arm every search with a slug under a folder (recursively) up to `budget` sockets.
  armFolder: (folderId, budget) => {
    const f = findNode(get().tree, folderId)
    if (get().loadError || !f) return { armed: 0, skipped: 0 }
    let left = Math.max(0, budget | 0), armed = 0, skipped = 0
    const ids = new Set()
    for (const n of flatten(f.children || [], x => x.kind === 'search')) {
      if (n.armed) continue
      if (!n.slug) { skipped++; continue }
      if (left <= 0) { skipped++; continue }
      ids.add(n.id); left--; armed++
    }
    if (ids.size) { set(s => ({ tree: mapAll(s.tree, n => (ids.has(n.id) ? { ...n, armed: true } : n)) })); persist(get, set) }
    return { armed, skipped }
  },
  disarmFolder: (folderId) => {
    const f = findNode(get().tree, folderId)
    if (get().loadError || !f) return 0
    const ids = new Set(flatten(f.children || [], x => x.kind === 'search' && x.armed).map(x => x.id))
    if (ids.size) { set(s => ({ tree: mapAll(s.tree, n => (ids.has(n.id) ? { ...n, armed: false } : n)) })); persist(get, set) }
    return ids.size
  },
  // Import an exported document: 'merge' appends (ids re-minted on collision), 'replace' swaps the
  // curated tree and keeps the history folder. Never touches the history rows.
  importWorkspace: (doc, mode = 'merge') => {
    if (get().loadError) return { error: 'load-error' }
    if (!doc || doc.version !== 2 || !Array.isArray(doc.tree)) return { error: 'not a workspace export' }
    const incoming = exportWorkspace(doc.tree).tree   // a stray sys folder in the file is dropped too
    const count = flatten(incoming).length
    set(s => {
      const history = s.tree.filter(n => n.kind === 'folder' && n.sys)
      const base = mode === 'replace' ? history : s.tree
      const taken = new Set(flatten(base).map(n => n.id))
      return { tree: [...base, ...remint(incoming, taken)], activeId: mode === 'replace' ? null : s.activeId }
    })
    persist(get, set)
    return { added: count }
  },

  // Remove history rows older than the retention window (runs after hydrate and hourly).
  expireHistory: (now = Date.now()) => {
    const f = findWhere(get().tree, n => n.kind === 'folder' && n.sys === HISTORY_SYS)
    if (!f || !(f.children || []).length) return 0
    const t = trimHistory(f.children, get().historyPrefs, now)
    if (!t.expired && !t.pruned) return 0
    const oldest = f.children.reduce((m, r) => Math.min(m, typeof r.ts === 'number' ? r.ts : m), now)
    set(s => ({ tree: mapNode(s.tree, f.id, x => ({ ...x, children: t.rows })), lastHistoryEvent: { type: 'expire', n: t.expired + t.pruned, oldestDays: Math.round((now - oldest) / DAY), at: now } }))
    persist(get, set)
    return t.expired + t.pruned
  },

  // Empty the folder; returns the undo slot { folderId, rows, n } (null when there was nothing).
  clearHistory: () => {
    const f = findWhere(get().tree, n => n.kind === 'folder' && n.sys === HISTORY_SYS)
    if (!f || !(f.children || []).length) return null
    const rows = f.children
    set(s => ({ tree: mapNode(s.tree, f.id, x => ({ ...x, children: [] })), activeId: rows.some(r => r.id === s.activeId) ? null : s.activeId, lastHistoryEvent: { type: 'clear', n: rows.length, at: Date.now() } }))
    persist(get, set)
    return { folderId: f.id, rows, n: rows.length }
  },
  restoreHistory: (undo) => {
    if (!undo || get().loadError) return
    const fid = findNode(get().tree, undo.folderId) ? undo.folderId : get().ensureFolder(HISTORY_SYS, HISTORY_NAME)
    set(s => ({ tree: mapNode(s.tree, fid, f => ({ ...f, children: [...undo.rows, ...(f.children || []).filter(k => !undo.rows.some(r => r.id === k.id))] })) }))
    persist(get, set)
  },

  nodeById: (id) => findNode(get().tree, id),
}))

export async function loadWorkspace() {
  try {
    const { workspace } = await api.workspace()
    useWorkspace.getState().hydrate(workspace)
  } catch (e) {
    useWorkspace.getState().failLoad(cleanErr(e))
    diag('ws', `ws-load fail err="${cleanErr(e).slice(0, 120)}"`)
  }
}
