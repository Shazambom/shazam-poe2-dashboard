import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspace, loadWorkspace } from '../lib/workspaceStore.js'
import { tradeUrl, tradeHome, parseTradeUrl, openTrade, isDesktop } from '../lib/session.js'
import { findWhere, flatten } from '../lib/tree.js'
import { bus } from '../lib/api.js'
import SearchTree from './SearchTree.jsx'

// The Trading workspace: a file-tree of saved searches on the left, the live trade site
// embedded on the right. Press + → a new entry is created and the trade window opens; you
// build the search on the site and it's CAPTURED automatically (no pasting). Selecting an
// entry reopens its search. Desktop-only for the embedded site (web opens searches in a tab).

// First search node in the tree holding this slug (used to reject stale cross-node captures).
const findBySlug = (nodes, slug) => findWhere(nodes, n => n.kind === 'search' && n.slug === slug)

const RAIL_MIN = 220, RAIL_MAX = 420, RAIL_DEFAULT = 280
const UNDO_TTL = 10000

// Force the trade site's delivery-mode dropdown to "Instant Buyout" (the mode that enables
// travel-to-hideout). vue-multiselect selects on `mousedown`, not click. Retries a few times
// because the search bar renders asynchronously. Runs in the <webview> page context.
async function ensureInstantBuyout(el) {
  const code = `(function(){
    var bars = document.querySelectorAll('.search-bar .multiselect');
    var m = null;
    for (var i=0;i<bars.length;i++){ var s=bars[i].querySelector('.multiselect__single'); if(s && /(In Person|Instant Buyout|Online|^\\s*Any\\s*$)/i.test(s.textContent)){ m=bars[i]; break; } }
    if(!m) return 'no-ms';
    var cur=m.querySelector('.multiselect__single'); if(cur && /instant buyout\\s*$/i.test(cur.textContent.trim())) return 'already';
    var tags=m.querySelector('.multiselect__tags')||m; tags.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
    var opts=m.querySelectorAll('.multiselect__element');
    for (var j=0;j<opts.length;j++){ if(/^\\s*Instant Buyout\\s*$/i.test(opts[j].textContent)){ var t=opts[j].querySelector('.multiselect__option')||opts[j]; t.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return 'set'; } }
    return 'no-option';
  })()`
  for (let i = 0; i < 6; i++) {
    try { const r = await el.executeJavaScript(code); if (r === 'set' || r === 'already') return r } catch {}
    await new Promise(res => setTimeout(res, 900))
  }
  return 'gave-up'
}

// Read the item name the user typed in the embedded trade window's search box, to auto-name
// the entry. Runs in the <webview> page context; returns '' if nothing meaningful is found.
async function readSearchName(el) {
  try {
    const v = await el.executeJavaScript(`(() => {
      const bad = /^search items|^poe2\\b|in person|instant buyout|online in league|^any$/i;
      // 1) Item name — the search box (placeholder "Search Items…"). Selected item can be in
      //    the input value, a tag, or the single label.
      let box = null;
      document.querySelectorAll('.search-bar .multiselect').forEach(m => {
        const inp = m.querySelector('input');
        if (inp && /search items/i.test(inp.getAttribute('placeholder') || '')) box = m;
      });
      if (box) {
        const cands = [box.querySelector('.multiselect__single'), box.querySelector('.multiselect__tag')]
          .map(e => (e && e.textContent || '').trim());
        const bi = box.querySelector('input'); if (bi && bi.value) cands.push(bi.value.trim());
        for (const raw of cands) if (raw && !bad.test(raw)) return raw.slice(0, 60);
      }
      // 2) No item -> derive from the main filters: Item Category (type) + Item Level. The
      //    label sits in a .filter-title; the control is a sibling .filter-body input.
      const rowInput = (label) => {
        const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && (e.textContent || '').trim() === label);
        if (!el) return null;
        let row = el.parentElement;
        for (let k = 0; k < 3 && row; k++) { const inp = row.querySelector('.filter-body input, input'); if (inp) return row; row = row.parentElement; }
        return null;
      };
      const catRow = rowInput('Item Category');
      let cat = catRow ? (catRow.querySelector('input')?.value || '').trim() : '';
      if (bad.test(cat)) cat = '';
      const lvlRow = rowInput('Item Level');
      const ilvl = lvlRow ? (lvlRow.querySelector('input')?.value || '').trim() : '';
      const parts = [];
      if (cat) parts.push(cat);
      if (ilvl) parts.push('i' + ilvl);
      return parts.join(' ').slice(0, 60);
    })()`)
    return (v || '').trim()
  } catch { return '' }
}

export default function WorkspaceView({ league }) {
  const tree = useWorkspace(s => s.tree)
  const loaded = useWorkspace(s => s.loaded)
  const loadError = useWorkspace(s => s.loadError)
  const saveState = useWorkspace(s => s.saveState)
  const layout = useWorkspace(s => s.layout)
  const activeId = useWorkspace(s => s.activeId)
  const addFolder = useWorkspace(s => s.addFolder)
  const addSearch = useWorkspace(s => s.addSearch)
  const remove = useWorkspace(s => s.remove)
  const restore = useWorkspace(s => s.restore)
  const setField = useWorkspace(s => s.setField)
  const setLayout = useWorkspace(s => s.setLayout)
  const autoName = useWorkspace(s => s.autoName)
  const setActive = useWorkspace(s => s.setActive)
  const nodeById = useWorkspace(s => s.nodeById)

  const wv = useRef(null)
  const activeRef = useRef(activeId)
  const [navState, setNavState] = useState({ url: '', loading: false })
  const [confirmId, setConfirmId] = useState(null)   // folder awaiting its inline delete confirm
  const collapsed = !!layout?.collapsed
  const railWidth = Math.min(RAIL_MAX, Math.max(RAIL_MIN, layout?.railWidth || RAIL_DEFAULT))
  const [dragWidth, setDragWidth] = useState(null)   // live width while the divider is being dragged

  useEffect(() => { if (!loaded) loadWorkspace() }, [loaded])
  useEffect(() => { activeRef.current = activeId }, [activeId])

  // Flush the debounced save when the page goes away (tab hidden, window closing) so the last
  // edit isn't lost to a 700 ms window. Main's before-quit also asks for a flush (batch 1).
  useEffect(() => {
    const flush = () => { if (document.visibilityState === 'hidden') useWorkspace.getState().flush() }
    const hide = () => useWorkspace.getState().flush()
    document.addEventListener('visibilitychange', flush)
    window.addEventListener('pagehide', hide)
    return () => { document.removeEventListener('visibilitychange', flush); window.removeEventListener('pagehide', hide) }
  }, [])

  // Selecting/creating only mutate the DB (activeId + tree). The trade window is a pure
  // function of that state — see `mountUrl` + the keyed <webview> below. No imperative
  // navigation here, so there's no activeRef/navTo race to get wrong.
  const newSearch = useCallback((parentId = null) => setActive(addSearch(parentId, { type: 'search', slug: '', live: false }, 'New search')), [addSearch, setActive])
  const newGroup = useCallback(() => addFolder(null), [addFolder])

  // Delete with undo: the removed subtree + its exact position ride on a 10 s toast whose Undo
  // re-inserts it. Folders with children ask first — an inline two-step on the row, never a
  // native confirm() (it would block the renderer).
  const deleteNode = useCallback((id) => {
    const where = remove(id)
    setConfirmId(null)
    if (!where) return
    const label = where.node.name || (where.node.kind === 'folder' ? 'group' : 'search')
    const n = flatten(where.node.children || [], x => x.kind === 'search').length
    bus.emit({ id: 'ws-undo', ttl: UNDO_TTL, node: (
      <div className="ws-undo">
        <span className="ws-undo-text">Deleted “{label}”{n ? ` (${n} search${n === 1 ? '' : 'es'})` : ''}</span>
        <button className="btn small primary" onClick={() => { restore(where); bus.emit({ id: 'ws-undo', dismiss: true }) }}>Undo</button>
      </div>) })
  }, [remove, restore])
  const requestDelete = useCallback((d) => {
    if (d.kind === 'folder' && (d.children || []).length) setConfirmId(d.id)
    else deleteNode(d.id)
  }, [deleteNode])

  // The divider is both the collapse toggle (click) and the rail's resize handle (drag,
  // 220–420 px, rAF-throttled, persisted on mouseup).
  const onDividerDown = useCallback((e) => {
    if (collapsed) return
    e.preventDefault()
    const x0 = e.clientX, w0 = railWidth
    let moved = false, raf = 0, w = w0
    const onMove = (ev) => {
      const dx = ev.clientX - x0
      if (Math.abs(dx) > 3) moved = true
      w = Math.min(RAIL_MAX, Math.max(RAIL_MIN, w0 + dx))
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; setDragWidth(w) })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp)
      cancelAnimationFrame(raf); setDragWidth(null)
      if (moved) setLayout({ railWidth: w })
      else setLayout({ collapsed: true })
    }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }, [collapsed, railWidth, setLayout])

  // The trade window's URL is DERIVED from the DB: the active node's saved search (or the
  // blank trade home). Computed per activeId/league only — a slug CAPTURED into the active
  // node must not re-navigate the webview it came from (that would reload mid-build). The
  // <webview key={activeId}> remounts on switch, so this doubles as restore-on-launch and
  // restore-on-remount with no imperative navigation.
  const mountUrl = useMemo(() => {
    const n = activeId ? useWorkspace.getState().nodeById(activeId) : null
    return n && n.slug ? tradeUrl(n, league, n.live) : tradeHome(league)
  }, [activeId, league])

  // Default each freshly-mounted trade window to Instant Buyout (the mode travel-to-hideout
  // needs). Re-attaches per webview instance (keyed remount).
  useEffect(() => {
    const el = wv.current
    if (!isDesktop || !el) return
    const onReady = () => ensureInstantBuyout(el)
    el.addEventListener('dom-ready', onReady)
    return () => el.removeEventListener('dom-ready', onReady)
  }, [activeId, league])

  // Capture a run search into the active entry. The trade SPA doesn't fire <webview> DOM
  // navigation events, but the guest webContents DOES — main forwards them here as
  // 'trade:webview-nav'. As soon as the URL becomes a search (has a slug) we save it and
  // auto-name it: "run a search → it's saved."
  useEffect(() => {
    if (!isDesktop || !window.poe2desktop?.trade?.onWebviewNav) return
    return window.poe2desktop.trade.onWebviewNav((url) => {
      setNavState({ url, loading: false })
      const parsed = parseTradeUrl(url)
      const id = activeRef.current
      if (!parsed || !parsed.slug || !id) return
      // Race guard: the nav IPC is global (one channel for whatever webview is live). If this
      // slug already belongs to a DIFFERENT node, it's a stale event from a search we've since
      // switched away from — never let it overwrite the now-active node. Read fresh store state.
      const st = useWorkspace.getState()
      const owner = findBySlug(st.tree, parsed.slug)
      if (owner && owner.id !== id) return
      const n = st.nodeById(id)
      if (!n) return
      if (n.slug !== parsed.slug || n.live !== parsed.live || n.type !== parsed.type) {
        setField(id, { type: parsed.type, slug: parsed.slug, live: parsed.live })
      }
      if (n.auto !== false && wv.current) readSearchName(wv.current).then(name => { if (name) autoName(id, name) })
    })
  }, [nodeById, setField, autoName])

  if (!loaded) return <div className="single hint">Loading workspace…</div>
  // A failed load must block the tree: the store holds an empty document that is NOT the
  // user's, and nothing may be written until a retry succeeds (see workspaceStore.failLoad).
  if (loadError) {
    return (
      <div className="single">
        <div className="notice error ws-load-error" role="alert">
          <b>Couldn't load your searches</b>
          <span className="muted">{loadError}</span>
          <button className="btn small" onClick={() => loadWorkspace()}>Retry</button>
        </div>
      </div>
    )
  }

  const activeNode = activeId ? nodeById(activeId) : null
  const width = dragWidth ?? railWidth
  const saveTitle = { idle: 'Saved', dirty: 'Unsaved changes', saving: 'Saving…', error: 'Save failed — retrying on the next change' }[saveState]

  return (
    <div className={`trade-ws ${dragWidth != null ? 'resizing' : ''}`}>
      {!collapsed && (
        <aside className="ws-rail" style={{ width, flexBasis: width }}>
          <div className="ws-rail-head">
            <b>Searches</b>
            <span className={`ws-save-dot ${saveState}`} title={saveTitle} aria-label={saveTitle} role="status" />
            <span className="spacer" />
            <button className="ws-icon-btn" title="New group" aria-label="New group" onClick={newGroup}>📁</button>
            <button className="ws-icon-btn primary" title="New search" aria-label="New search" onClick={() => newSearch(null)}>+</button>
          </div>
          {tree.length === 0
            ? <div className="ws-tree"><button className="ws-empty-add" onClick={() => newSearch(null)}>+ New search</button></div>
            : (
              <SearchTree onSelect={(id) => setActive(id)} renderTrailing={(d, node) => (
                confirmId === d.id
                  ? <span className="ws-confirm" onClick={e => e.stopPropagation()}>
                      <span>Delete {(d.children || []).length} inside?</span>
                      <button className="ws-mini on" title="Confirm delete" aria-label="Confirm delete" onClick={() => deleteNode(d.id)}>✓</button>
                      <button className="ws-mini on" title="Cancel" aria-label="Cancel" onClick={() => setConfirmId(null)}>✕</button>
                    </span>
                  : <>
                      {d.kind === 'folder' && <button className="ws-mini" title="New search here" aria-label="New search here" onClick={e => { e.stopPropagation(); newSearch(d.id) }}>+</button>}
                      <button className="ws-mini" title="Rename" aria-label="Rename" onClick={e => { e.stopPropagation(); node.edit() }}>✎</button>
                      <button className="ws-mini" title="Delete" aria-label="Delete" onClick={e => { e.stopPropagation(); requestDelete(d) }}>×</button>
                    </>
              )} />
            )}
        </aside>
      )}

      {/* Collapse/expand the searches rail (click) or resize it (drag) — control sits on the boundary. */}
      <button className={`ws-divider ${collapsed ? 'collapsed' : ''}`} title={collapsed ? 'Show searches' : 'Hide searches · drag to resize'}
        aria-label={collapsed ? 'Show searches' : 'Hide searches'} aria-expanded={!collapsed}
        onMouseDown={onDividerDown} onClick={() => { if (collapsed) setLayout({ collapsed: false }) }}>
        <span>{collapsed ? '»' : '«'}</span>
      </button>

      <section className="ws-main">
        {isDesktop ? (
          <>
            <div className={`ws-webhint ${activeNode ? '' : 'hidden'}`}>
              <span className="muted" title={navState.url}>{navState.loading ? 'loading…' : (activeNode ? activeNode.name : '')}</span>
              {activeNode && <span className={`ws-cap ${activeNode.slug ? 'ok' : ''}`}>{activeNode.slug ? `captured · ${activeNode.type}/${String(activeNode.slug).slice(0, 8)}` : 'build your search — it captures automatically'}</span>}
            </div>
            <webview key={activeId || 'home'} ref={wv} src={mountUrl} className="ws-webview" allowpopups="true" />
            {!activeNode && (
              <div className="ws-overlay">
                <p>Press <button className="ws-inline-add" onClick={() => newSearch(null)}>+</button> to start a search — it opens here and saves automatically.</p>
              </div>
            )}
          </>
        ) : (
          <div className="ws-overlay">
            <p className="muted">The embedded trade window is desktop-only. Add searches here and open them in a browser tab.
              {activeNode?.slug && <><br /><button className="btn small primary" onClick={() => openTrade(tradeUrl(activeNode, league, false))}>Open “{activeNode.name}” in a tab</button></>}
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
