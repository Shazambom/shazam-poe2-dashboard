import React, { useEffect, useRef, useState } from 'react'
import { Tree } from 'react-arborist'
import { useWorkspace } from '../lib/workspaceStore.js'

// The workspace file-tree, extracted so BOTH the Workspace and Live tabs render the exact
// same UI off the DB: react-arborist with drag-reorder, folder collapse, inline rename, and
// active-row highlight. Each host supplies its own row-click behavior and trailing controls
// (Workspace: rename/delete/new-here; Live: the Go-live toggle) via context.
const RowCtx = React.createContext({ onSelect: () => {}, renderTrailing: () => null })

function Node({ node, style, dragHandle }) {
  const d = node.data
  const isFolder = d.kind === 'folder'
  const active = useWorkspace(s => s.activeId) === d.id
  const { onSelect, renderTrailing } = React.useContext(RowCtx)
  return (
    <div className={`ws-node ${isFolder ? 'folder' : 'search'} ${active ? 'active' : ''} ${d.done ? 'done' : ''}`}
      style={style} ref={dragHandle}
      onClick={() => isFolder ? node.toggle() : onSelect(d.id, node)}>
      <span className="ws-caret">{isFolder ? (node.isOpen ? '▾' : '▸') : ''}</span>
      <span className="ws-icon">{isFolder ? '📁' : (d.slug ? '🔎' : '✎')}</span>
      {node.isEditing ? (
        <input className="ws-edit" autoFocus defaultValue={d.name}
          onClick={e => e.stopPropagation()}
          onBlur={e => node.submit(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') node.submit(e.currentTarget.value); if (e.key === 'Escape') node.reset() }} />
      ) : (
        <span className="ws-name">{d.name}</span>
      )}
      {!isFolder && d.live && <span className="live-badge">live</span>}
      <span className="spacer" />
      {renderTrailing(d, node)}
    </div>
  )
}

export default function SearchTree({ onSelect = () => {}, renderTrailing = () => null }) {
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

  return (
    <div className="ws-tree" ref={wrap}>
      <RowCtx.Provider value={{ onSelect, renderTrailing }}>
        <Tree data={tree} idAccessor="id" childrenAccessor="children"
          width={dims.w} height={dims.h} rowHeight={30} indent={14}
          onMove={({ dragIds, parentId, index }) => dragIds.forEach((id, i) => move(id, parentId, index + i))}
          onRename={({ id, name }) => rename(id, name)}>
          {Node}
        </Tree>
      </RowCtx.Provider>
    </div>
  )
}
