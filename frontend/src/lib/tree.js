// The ONE set of walkers over the workspace tree (folders with `children`, leaf searches).
// Pure: every mutator returns a new tree and never touches its input. The store, the views
// and liveWiring all go through these — no view carries its own recursive finder.

export function find(nodes, id) {
  for (const n of nodes || []) {
    if (n.id === id) return n
    if (n.children) { const f = find(n.children, id); if (f) return f }
  }
  return null
}

// First node (document order) satisfying `pred`.
export function findWhere(nodes, pred) {
  for (const n of nodes || []) {
    if (pred(n)) return n
    if (n.children) { const f = findWhere(n.children, pred); if (f) return f }
  }
  return null
}

// Where a node lives: { node, parentId (null = root), index } — the shape remove() hands back so
// an undo can re-insert at the exact spot.
export function locate(nodes, id, parentId = null) {
  const list = nodes || []
  for (let i = 0; i < list.length; i++) {
    const n = list[i]
    if (n.id === id) return { node: n, parentId, index: i }
    if (n.children) { const f = locate(n.children, id, n.id); if (f) return f }
  }
  return null
}

// Depth-first list of every node (optionally only those matching `pred`).
export function flatten(nodes, pred = null, out = []) {
  for (const n of nodes || []) {
    if (!pred || pred(n)) out.push(n)
    if (n.children) flatten(n.children, pred, out)
  }
  return out
}

export function mapNode(nodes, id, fn) {
  return (nodes || []).map(n => {
    if (n.id === id) return fn(n)
    if (n.children) return { ...n, children: mapNode(n.children, id, fn) }
    return n
  })
}

export function removeNode(nodes, id) {
  return (nodes || []).filter(n => n.id !== id).map(n =>
    n.children ? { ...n, children: removeNode(n.children, id) } : n)
}

// Insert `node` under `parentId` (null = root) at `index`; a missing parent inserts nothing.
export function insertAt(nodes, node, parentId, index) {
  if (!parentId) { const t = [...(nodes || [])]; t.splice(index, 0, node); return t }
  return mapNode(nodes, parentId, p => {
    const kids = [...(p.children || [])]
    kids.splice(index, 0, node)
    return { ...p, children: kids, open: true }
  })
}
