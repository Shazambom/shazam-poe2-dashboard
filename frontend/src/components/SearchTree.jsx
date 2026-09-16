import React, { useEffect, useRef, useState } from 'react'
import { Tree } from 'react-arborist'
import { useWorkspace } from '../lib/workspaceStore.js'
import { matchesFilter } from '../lib/tree.js'

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
    node.willReceiveDrop ? 'drop-target' : '', node.isDragging ? 'dragging' : '', node.isFocused ? 'focused' : ''].join(' ')
  return (
    <div className={cls} style={style} ref={dragHandle} role="treeitem" aria-level={node.level + 1}
      aria-expanded={isFolder ? node.isOpen : undefined} aria-selected={active || undefined}
      onClick={() => isFolder ? node.toggle() : onSelect(d.id, node)}
      onContextMenu={onContext ? (e) => { e.preventDefault(); e.stopPropagation(); node.focus(); onContext(e, d, node) } : undefined}>
      <span className="ws-grip" aria-hidden="true" title="Drag to move">⋮⋮</span>
      <span className="ws-caret">{isFolder ? (node.isOpen ? '▾' : '▸') : ''}</span>
      <span className="ws-icon">{isFolder ? '📁' : (d.slug || d.q ? '🔎' : '✎')}</span>
      {node.isEditing ? (
        <input className="ws-edit" autoFocus defaultValue={d.name} aria-label="Rename"
          onClick={e => e.stopPropagation()}
          onBlur={e => node.submit(e.target.value)}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') node.submit(e.currentTarget.value); if (e.key === 'Escape') node.reset() }} />
      ) : (
        <span className="ws-name">{d.name}</span>
      )}
      {!isFolder && d.live && <span className="live-badge">live</span>}
      <span className="spacer" />
      {renderTrailing(d, node)}
    </div>
  )
}

export default function SearchTree({ onSelect = () => {}, renderTrailing = () => null, onContext = null, onKey = null, onDelete = null, filter = '', treeRef = null }) {
  const tree = useWorkspace(s => s.tree)
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
        <Tree ref={treeRef} data={tree} idAccessor="id" childrenAccessor="children"
          width={dims.w} height={dims.h} rowHeight={30} indent={14}
          searchTerm={filter} searchMatch={(node, term) => matchesFilter(node.data, term)}
          disableMultiSelection
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
