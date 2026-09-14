import { create } from 'zustand'
import { api, cleanErr, toast } from './api.js'
import { uid } from './session.js'

// The Trading workspace: a nested filesystem-like tree (folders + search items) plus a
// dockview layout + which items are open as panels. Backed by user.sqlite via
// /api/trading/workspace; the flat `watches` blob was migrated into this (migration #2).
//
// The store is the single source of truth for the tree; mutations persist through a
// debounced PUT so drag/rename/nest survive reload + restart. The league is never stored
// on a node — it's injected at open time (tradeUrl), so watches survive league resets.

const DEBOUNCE = 700
let saveTimer = null
let armed = false   // don't PUT while hydrating the initial load

function persist(get) {
  if (!armed) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    try {
      const { version, tree, layout, openTabs, activeId } = get()
      await api.putWorkspace({ version, tree, layout, openTabs, activeId })
    } catch (e) { toast(cleanErr(e), false) }
  }, DEBOUNCE)
}

// Recursively map a node by id.
function mapNode(nodes, id, fn) {
  return nodes.map(n => {
    if (n.id === id) return fn(n)
    if (n.children) return { ...n, children: mapNode(n.children, id, fn) }
    return n
  })
}
function removeNode(nodes, id) {
  return nodes.filter(n => n.id !== id).map(n =>
    n.children ? { ...n, children: removeNode(n.children, id) } : n)
}
function findNode(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n
    if (n.children) { const f = findNode(n.children, id); if (f) return f }
  }
  return null
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
  activeId: null,   // which search entry is open in the trade window (persisted → restores on relaunch)

  setActive: (id) => { set({ activeId: id }); persist(get) },

  hydrate: (doc) => {
    armed = false
    set({
      version: 2,
      tree: Array.isArray(doc?.tree) ? doc.tree : [],
      layout: doc?.layout ?? null,
      openTabs: Array.isArray(doc?.openTabs) ? doc.openTabs : [],
      activeId: doc?.activeId ?? null,   // reopen the last-open search on relaunch
      loaded: true,
    })
    // arm on the next tick so hydrate itself doesn't trigger a save
    setTimeout(() => { armed = true }, 0)
  },

  addFolder: (parentId = null) => {
    const f = newFolder()
    set(s => parentId
      ? { tree: mapNode(s.tree, parentId, n => ({ ...n, open: true, children: [...(n.children || []), f] })) }
      : { tree: [...s.tree, f] })
    persist(get); return f.id
  },
  addSearch: (parentId, parsed, name) => {
    const node = searchNode(parsed, name)
    set(s => parentId
      ? { tree: mapNode(s.tree, parentId, n => ({ ...n, open: true, children: [...(n.children || []), node] })) }
      : { tree: [...s.tree, node] })
    persist(get); return node.id
  },
  rename: (id, name) => { set(s => ({ tree: mapNode(s.tree, id, n => ({ ...n, name, auto: false })) })); persist(get) },
  autoName: (id, name) => { set(s => ({ tree: mapNode(s.tree, id, n => (n.auto === false ? n : { ...n, name })) })); persist(get) },
  setField: (id, patch) => { set(s => ({ tree: mapNode(s.tree, id, n => ({ ...n, ...patch })) })); persist(get) },
  toggleOpen: (id) => { set(s => ({ tree: mapNode(s.tree, id, n => ({ ...n, open: !n.open })) })); persist(get) },
  remove: (id) => {
    set(s => {
      const tree = removeNode(s.tree, id)
      // If the removed subtree contained the open search, drop the selection so the trade
      // window doesn't point at a node that no longer exists.
      const activeId = findNode(tree, s.activeId) ? s.activeId : null
      return { tree, openTabs: s.openTabs.filter(t => t !== id), activeId }
    })
    persist(get)
  },

  // Move `id` into `parentId` (null = root) at `index`. Used by react-arborist onMove.
  move: (id, parentId, index) => {
    set(s => {
      const node = findNode(s.tree, id)
      if (!node) return {}
      // Refuse to move a node into itself or its own descendant — that would remove the
      // subtree and have nowhere to re-insert it (silent data loss).
      if (parentId && (parentId === id || findNode(node.children || [], parentId))) return {}
      let tree = removeNode(s.tree, id)
      if (parentId) {
        tree = mapNode(tree, parentId, n => {
          const kids = [...(n.children || [])]
          kids.splice(index, 0, node)
          return { ...n, children: kids, open: true }
        })
      } else {
        tree = [...tree]; tree.splice(index, 0, node)
      }
      return { tree }
    })
    persist(get)
  },

  setLayout: (layout) => { set({ layout }); persist(get) },
  openTab: (id) => { set(s => s.openTabs.includes(id) ? {} : { openTabs: [...s.openTabs, id] }); persist(get) },
  closeTab: (id) => { set(s => ({ openTabs: s.openTabs.filter(t => t !== id) })); persist(get) },
  nodeById: (id) => findNode(get().tree, id),
}))

export async function loadWorkspace() {
  try {
    const { workspace } = await api.workspace()
    useWorkspace.getState().hydrate(workspace)
  } catch (e) {
    useWorkspace.getState().hydrate({ version: 2, tree: [], layout: null, openTabs: [] })
  }
}
