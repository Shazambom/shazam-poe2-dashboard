import { create } from 'zustand'
import { api, cleanErr, toast } from './api.js'
import { uid } from './session.js'
import { find as findNode, findWhere, locate, mapNode, removeNode, insertAt } from './tree.js'
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
export const HISTORY_CAP = 200       // rows kept in the history folder (newest first)
export const MAX_Q_BYTES = 16 * 1024 // a q larger than this is dropped (degraded row), never PUT

// Keep every PUT inside the backend's limits (it validates and never truncates, so a rejection
// would mean a bug here): drop oversize q's, trim the history folder to its cap. Pure; untouched
// nodes are returned as-is.
export function sanitize(tree) {
  return (tree || []).map(n => {
    let out = n
    if (n.kind === 'search' && typeof n.q === 'string' && n.q.length > MAX_Q_BYTES) out = { ...n, q: null, degraded: true }
    if (n.kind === 'folder' && n.children) {
      let kids = sanitize(n.children)
      if (n.sys === HISTORY_SYS && kids.length > HISTORY_CAP) kids = kids.slice(0, HISTORY_CAP)
      if (kids !== n.children && (kids.length !== n.children.length || kids.some((k, i) => k !== n.children[i]))) out = { ...out, children: kids }
    }
    return out
  })
}

function payload(get) {
  const { version, tree, layout, openTabs, activeId } = get()
  return { version, tree: sanitize(tree), layout, openTabs, activeId }
}

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
    setTimeout(() => { armed = true }, 0)
  },

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
  rename: (id, name) => { if (get().loadError) return; set(s => ({ tree: mapNode(s.tree, id, n => ({ ...n, name, auto: false })) })); persist(get, set) },
  autoName: (id, name) => { if (get().loadError) return; set(s => ({ tree: mapNode(s.tree, id, n => (n.auto === false ? n : { ...n, name })) })); persist(get, set) },
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
    const st = get()
    const same = intent.q
      ? findWhere(st.tree, n => n.kind === 'search' && n.q === intent.q)
      : intent.slug ? findWhere(st.tree, n => n.kind === 'search' && n.slug === intent.slug) : null
    const fromClipboard = intent.source === 'clipboard'
    if (same && fromClipboard) { set({ activeId: same.id }); persist(get, set); return { result: 'dup', id: same.id } }
    const node = {
      ...searchNode({ type: intent.type || 'search', slug: intent.slug || '', live: !!intent.live }, intent.name),
      auto: intent.q ? false : true,          // rows born from a query keep their parsed name
      q: intent.q || null, origin: intent.origin || intent.source, ts: Date.now(),
      ...(intent.item ? { item: intent.item } : {}), ...(intent.degraded ? { degraded: true } : {}),
    }
    if (intent.folder) {
      const fid = get().ensureFolder(intent.folder, intent.folder === HISTORY_SYS ? HISTORY_NAME : intent.folder)
      get().prependSearch(fid, node)          // newest first; the item stream never steals the pane
      return { result: 'added', id: node.id }
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
