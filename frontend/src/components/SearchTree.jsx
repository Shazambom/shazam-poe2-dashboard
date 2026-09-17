import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Tree } from 'react-arborist'
import { useWorkspace, HISTORY_SYS } from '../lib/workspaceStore.js'
import { matchesFilter } from '../lib/tree.js'

const relative = (ts) => {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`
}
const rowIcon = (d) => d.kind === 'folder' ? (d.sys === HISTORY_SYS ? '🕘' : '📁') : d.degraded ? '⚠' : d.slug ? '🔎' : d.q ? '🧾' : '✎'
const rowTitle = (d) => {
  if (d.kind === 'folder' || !d.ts) return undefined
  const parts = [d.item?.rarity, d.item?.itemClass].filter(Boolean)
  const when = `checked ${relative(d.ts)}`
  return d.degraded ? `${parts.join(' · ')}${parts.length ? ' · ' : ''}${when} · newer than Arbiter's item data — opens the blank trade page` : `${parts.join(' · ')}${parts.length ? ' · ' : ''}${when}`
}

// The workspace file-tree, extracted so BOTH the Workspace and Live tabs render the exact
// same UI off the DB: react-arborist with drag-reorder, folder collapse, inline rename, and
// active-row highlight. Each host supplies its own row-click behavior and trailing controls
// (Workspace: rename/delete/new-here; Live: the Go-live toggle) via context, plus optional
// right-click + keyboard handlers. `filter` narrows rows by name/item name (folders holding a
// match auto-expand); `onKey(e, node)` runs first for host shortcuts (F2, ⌫, ⌘N…).
const RowCtx = React.createContext({ onSelect: () => {}, renderTrailing: () => null, onContext: null })

function Node({ node, style, dragHandle }) {
  const d = node.data
  const isFolder = d.kind === 'folder'
  const active = useWorkspace(s => s.activeId) === d.id
  const { onSelect, renderTrailing, onContext } = React.useContext(RowCtx)
  const cls = ['ws-node', isFolder ? 'folder' : 'search', active ? 'active' : '', d.done ? 'done' : '',
    node.willReceiveDrop ? 'drop-target' : '', node.isDragging ? 'dragging' : '', node.isFocused ? 'focused' : '', node.isSelected ? 'selected' : ''].join(' ')
  return (
    <div className={cls} style={style} ref={dragHandle} role="treeitem" aria-level={node.level + 1} data-id={d.id}
      aria-expanded={isFolder ? node.isOpen : undefined} aria-selected={active || undefined}
      onClick={() => isFolder ? node.toggle() : onSelect(d.id, node)}
      onContextMenu={onContext ? (e) => { e.preventDefault(); e.stopPropagation(); node.focus(); onContext(e, d, node) } : undefined}>
      <span className="ws-grip" aria-hidden="true" title="Drag to move">⋮⋮</span>
      <span className="ws-caret">{isFolder ? (node.isOpen ? '▾' : '▸') : ''}</span>
      <span className="ws-icon" title={rowTitle(d)}>{rowIcon(d)}</span>
      {node.isEditing ? (
        <input className="ws-edit" autoFocus defaultValue={d.name} aria-label="Rename"
          onClick={e => e.stopPropagation()}
          onBlur={e => node.submit(e.target.value)}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') node.submit(e.currentTarget.value); if (e.key === 'Escape') node.reset() }} />
      ) : (
        <span className="ws-name" title={rowTitle(d)}>{d.name}</span>
      )}
      {!isFolder && d.live && <span className="live-badge">live</span>}
      {!isFolder && d.origin === 'ee2' && <span className="ws-chip ee2" title="Captured from an ExiledExchange2 price check">EE2</span>}
      {!isFolder && d.ts && d.q != null && <span className="ws-age" title={rowTitle(d)}>{relative(d.ts).replace(' ago', '')}</span>}
      {isFolder && d.sys === HISTORY_SYS && <span className="ws-count" title="Entries for the current league">{(d.children || []).length}</span>}
      <span className="spacer" />
      {renderTrailing(d, node)}
    </div>
  )
}

export default function SearchTree({ onSelect = () => {}, renderTrailing = () => null, onContext = null, onKey = null, onDelete = null, filter = '', treeRef = null }) {
  const tree = useWorkspace(s => s.tree)
  const league = useWorkspace(s => s.league)
  // The history folder shows only the rows captured under the top-bar league (other leagues stay
  // stored, counted against the cap, and reappear when the league switches back).
  const data = useMemo(() => tree.map(n => (n.kind === 'folder' && n.sys === HISTORY_SYS)
    ? { ...n, children: (n.children || []).filter(c => !c.league || !league || c.league === league) } : n), [tree, league])
  const move = useWorkspace(s => s.move)
  const rename = useWorkspace(s => s.rename)
  const wrap = useRef(null)
  const [dims, setDims] = useState({ w: 260, h: 480 })

  useEffect(() => {
    const el = wrap.current; if (!el) return
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el); return () => ro.disconnect()
  }, [])

  // Host shortcuts run in the capture phase so they win over react-arborist's own bindings
  // (its Enter starts a rename; ours opens the search). Inputs (the inline rename) are skipped.
  const keyCapture = (e) => {
    if (!onKey || e.target.closest('input, textarea')) return
    const api = treeRef?.current
    onKey(e, api?.focusedNode || null, api)
  }

  return (
    <div className="ws-tree" ref={wrap} onKeyDownCapture={keyCapture}>
      <RowCtx.Provider value={{ onSelect, renderTrailing, onContext }}>
        <Tree ref={treeRef} data={data} idAccessor="id" childrenAccessor="children"
          width={dims.w} height={dims.h} rowHeight={30} indent={14}
          searchTerm={filter} searchMatch={(node, term) => matchesFilter(node.data, term)}
          onMove={({ dragIds, parentId, index }) => dragIds.forEach((id, i) => move(id, parentId, index + i))}
          onRename={({ id, name }) => rename(id, name)}
          onDelete={onDelete ? ({ ids }) => ids.forEach(onDelete) : undefined}
          onActivate={(node) => { if (node.data.kind !== 'folder') onSelect(node.data.id, node) }}>
          {Node}
        </Tree>
      </RowCtx.Provider>
    </div>
  )
}
