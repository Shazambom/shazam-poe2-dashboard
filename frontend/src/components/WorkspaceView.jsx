import React, { useEffect, useRef, useState } from 'react'
import { Tree } from 'react-arborist'
import { DockviewReact, themeDark } from 'dockview-react'
import { useWorkspace, loadWorkspace } from '../lib/workspaceStore.js'
import { tradeUrl, openTrade, parseTradeUrl } from '../lib/session.js'
import { toast } from '../lib/api.js'
import Cur from './Cur.jsx'

// The Trading workspace: a filesystem-like tree (folders + saved searches) on the left,
// a dockview tab/panel work area on the right. Opening a search opens it as a panel;
// the layout + tree persist to user.sqlite (migrated from the old flat watches).
// Fully web-safe — organisation + saved searches, no live engine here.

let dockApi = null   // dockview api, set onReady; used by the tree to open panels
// Imperative bridges set by the component (avoids monkey-patching zustand state, which
// gets wiped on the next set()). The Node renderer + SearchPanel call through these.
const ui = { beginAdd: () => {}, openTabFor: () => {}, openExternal: () => {} }

function SearchPanel(props) {
  const nodeId = props.params?.nodeId
  const node = useWorkspace(s => {
    const find = (ns) => { for (const n of ns) { if (n.id === nodeId) return n; if (n.children) { const f = find(n.children); if (f) return f } } return null }
    return find(s.tree)
  })
  const setField = useWorkspace(s => s.setField)
  if (!node) return <div className="wsp-empty">This search was removed.</div>
  return (
    <div className="wsp">
      <div className="wsp-row">
        <input className="wsp-name" value={node.name} onChange={e => setField(node.id, { name: e.target.value })} />
      </div>
      <div className="wsp-meta muted">
        {node.type}/{String(node.slug).slice(0, 10)} · opens in the current league
        {node.live && <span className="live-badge"> live</span>}
      </div>
      <div className="wsp-actions">
        <button className="btn" onClick={() => ui.openExternal(node, false)}>Open search</button>
        <button className="btn primary" onClick={() => ui.openExternal(node, true)} title="GGG native live search">Open live</button>
      </div>
      <p className="hint">
        Opening rebuilds the search for your current league{typeof window !== 'undefined' && window.poe2desktop ? ' in a logged-in window' : ' in a new tab'}.
        Live-search pings with a one-click travel-to-hideout button arrive in the <b>Live</b> sub-tab.
      </p>
    </div>
  )
}

function Node({ node, style, dragHandle }) {
  const store = useWorkspace.getState()
  const d = node.data
  const isFolder = d.kind === 'folder'
  return (
    <div className={`ws-node ${isFolder ? 'folder' : 'search'} ${d.done ? 'done' : ''}`} style={style} ref={dragHandle}>
      <span className="ws-caret" onClick={() => isFolder && node.toggle()}>
        {isFolder ? (node.isOpen ? '▾' : '▸') : ''}
      </span>
      <span className="ws-icon">{isFolder ? '📁' : '🔎'}</span>
      {node.isEditing ? (
        <input className="ws-edit" autoFocus defaultValue={d.name}
          onBlur={e => node.submit(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') node.submit(e.currentTarget.value); if (e.key === 'Escape') node.reset() }} />
      ) : (
        <span className="ws-name" onDoubleClick={() => !isFolder && ui.openTabFor(d.id)}>{d.name}</span>
      )}
      {!isFolder && d.live && <span className="live-badge">live</span>}
      <span className="spacer" />
      <button className="ws-mini" title="Rename" onClick={() => node.edit()}>✎</button>
      {isFolder && <button className="ws-mini" title="Add search here" onClick={() => ui.beginAdd(d.id)}>＋</button>}
      <button className="ws-mini" title="Delete" onClick={() => store.remove(d.id)}>×</button>
    </div>
  )
}

export default function WorkspaceView({ league }) {
  // Select fields individually — a selector returning a NEW object each call breaks
  // zustand v5's useSyncExternalStore (infinite re-render / React #185).
  const tree = useWorkspace(s => s.tree)
  const loaded = useWorkspace(s => s.loaded)
  const layout = useWorkspace(s => s.layout)
  const addFolder = useWorkspace(s => s.addFolder)
  const addSearch = useWorkspace(s => s.addSearch)
  const rename = useWorkspace(s => s.rename)
  const move = useWorkspace(s => s.move)
  const setLayout = useWorkspace(s => s.setLayout)
  const [addTo, setAddTo] = useState(null)   // folder id we're adding into (null = root)
  const [addUrl, setAddUrl] = useState('')
  const treeWrap = useRef(null)
  const [dims, setDims] = useState({ w: 300, h: 480 })

  useEffect(() => { if (!loaded) loadWorkspace() }, [loaded])

  // Wire the imperative bridges the Node renderer + panel reach through.
  useEffect(() => {
    ui.beginAdd = (fid) => { setAddTo(fid); setTimeout(() => document.getElementById('ws-add-input')?.focus(), 0) }
    ui.openTabFor = (id) => openInPanel(id)
    ui.openExternal = (node, live) => {
      if (!league) { toast('No league set — pick one in the top bar', false); return }
      openTrade(tradeUrl(node, league, live))
    }
  }, [league])

  useEffect(() => {
    const el = treeWrap.current; if (!el) return
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el); return () => ro.disconnect()
  }, [])

  function openInPanel(id) {
    const node = useWorkspace.getState().nodeById(id)
    if (!node || node.kind !== 'search' || !dockApi) return
    const existing = dockApi.getPanel(id)
    if (existing) { existing.api.setActive(); return }
    dockApi.addPanel({ id, component: 'search', title: node.name, params: { nodeId: id } })
    useWorkspace.getState().openTab(id)
  }

  const onReady = (event) => {
    dockApi = event.api
    try { if (layout && layout.grid) event.api.fromJSON(layout) } catch { /* stale layout */ }
    event.api.onDidLayoutChange(() => { try { setLayout(event.api.toJSON()) } catch {} })
  }

  const submitAdd = () => {
    const parsed = parseTradeUrl(addUrl.trim())
    if (!parsed) { toast('Paste a pathofexile.com/trade2 search link', false); return }
    const id = addSearch(addTo, parsed)
    setAddUrl(''); setAddTo(null)
    setTimeout(() => openInPanel(id), 0)
  }

  if (!loaded) return <div className="single hint">Loading workspace…</div>

  return (
    <div className="workspace">
      <aside className="ws-rail">
        <div className="ws-rail-head">
          <b>Workspace</b>
          <span className="spacer" />
          <button className="btn small" onClick={() => addFolder(null)}>+ Group</button>
          <button className="btn small" onClick={() => { setAddTo(null); setTimeout(() => document.getElementById('ws-add-input')?.focus(), 0) }}>+ Search</button>
        </div>
        <div className="ws-add">
          <input id="ws-add-input" className="btn" placeholder={`Paste a trade link${addTo ? ' (into group)' : ''}…`}
            value={addUrl} onChange={e => setAddUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitAdd(); if (e.key === 'Escape') { setAddUrl(''); setAddTo(null) } }} />
          <button className="btn small" onClick={submitAdd}>Add</button>
        </div>
        <div className="ws-tree" ref={treeWrap}>
          {tree.length === 0
            ? <div className="empty small">No searches yet. Paste a trade-search link above.</div>
            : (
              <Tree data={tree} idAccessor="id" childrenAccessor="children"
                width={dims.w} height={dims.h} rowHeight={30} indent={16}
                onMove={({ dragIds, parentId, index }) => dragIds.forEach((id, i) => move(id, parentId, index + i))}
                onRename={({ id, name }) => rename(id, name)}>
                {Node}
              </Tree>
            )}
        </div>
      </aside>
      <section className="ws-panels">
        <DockviewReact components={{ search: SearchPanel }} onReady={onReady} theme={themeDark} />
      </section>
    </div>
  )
}
