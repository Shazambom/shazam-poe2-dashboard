import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspace, loadWorkspace, HISTORY_SYS } from '../lib/workspaceStore.js'
import { tradeUrl, tradeHome, queryUrl, parseTradeUrl, openTrade, isDesktop } from '../lib/session.js'
import { shouldAcceptNav } from '../lib/webview.js'
import { addFromClipboard } from '../lib/clipboardAdd.js'
import { findWhere, flatten, locate } from '../lib/tree.js'
import { bus, toast } from '../lib/api.js'
import { diag } from '../lib/diag.js'
import SearchTree from './SearchTree.jsx'
import ContextMenu from './ContextMenu.jsx'
import Toggle from './Toggle.jsx'
import { saveHistoryPrefs, clearHistoryWithUndo } from '../lib/ee2History.js'
import { usePings } from '../lib/pingStore.js'
import { useStatus } from '../lib/statusStore.js'

// The Trading workspace: a file-tree of saved searches on the left, the live trade site
// embedded on the right. Press + → a new entry is created and the trade window opens; you
// build the search on the site and it's CAPTURED automatically (no pasting). Selecting an
// entry reopens its search. Desktop-only for the embedded site (web opens searches in a tab).

// First search node in the tree holding this slug (used to reject stale cross-node captures).
const findBySlug = (nodes, slug) => findWhere(nodes, n => n.kind === 'search' && n.slug === slug)

const RAIL_MIN = 220, RAIL_MAX = 420, RAIL_DEFAULT = 280
const UNDO_TTL = 10000

// One empty state, shared by the rail and the pane.
export const EMPTY_HINT = 'Press + to build a search · Paste a trade URL'
export const EMPTY_HINT_EE2 = ' · Copy an item in game and it appears under ExiledExchange2 History.'

const copyText = (text, what = 'Link') => navigator.clipboard?.writeText(text).then(() => toast(`${what} copied`)).catch(() => toast('Copy failed', false))

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
  for (let i = 0; i < 10; i++) {
    try { const r = await el.executeJavaScript(code); if (r === 'set' || r === 'already') return r } catch {}
    await new Promise(res => setTimeout(res, 900))
  }
  // Gave up: report what the dropdown actually says so the caller only hints when it is truly
  // NOT Instant Buyout (a slow load that lands there anyway must not raise a false hint).
  try {
    const cur = await el.executeJavaScript(`(function(){var s=[...document.querySelectorAll('.search-bar .multiselect .multiselect__single')].map(function(e){return e.textContent.trim()}); return s.find(function(t){return /instant buyout|in person|online|^any$/i.test(t)})||''})()`)
    return /instant buyout/i.test(cur || '') ? 'already' : (cur ? 'other' : 'gave-up')
  } catch { return 'gave-up' }
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
  const [navState, setNavState] = useState({ url: '', loading: false, hint: '' })
  const [confirmId, setConfirmId] = useState(null)   // folder awaiting its inline delete confirm
  const [filter, setFilter] = useState('')
  const [menu, setMenu] = useState(null)             // { at:{x,y}, node } while the context menu is open
  const [wvNonce, setWvNonce] = useState(0)           // bump to remount (reload) the trade window
  const treeApi = useRef(null)
  const duplicate = useWorkspace(s => s.duplicate)
  const move = useWorkspace(s => s.move)
  const historyOn = useWorkspace(s => s.historyPrefs.enabled)
  const rerunFromItem = useWorkspace(s => s.rerunFromItem)
  const sortChildren = useWorkspace(s => s.sortChildren)
  const removeMany = useWorkspace(s => s.removeMany)
  const restoreMany = useWorkspace(s => s.restoreMany)
  const armFolder = useWorkspace(s => s.armFolder)
  const disarmFolder = useWorkspace(s => s.disarmFolder)
  const sessionOk = useStatus(s => !!s.status?.session?.connected)
  // Is this node inside the history folder? (its rows are never captured into, and open by q)
  const inHistory = useCallback((id) => { const p = locate(useWorkspace.getState().tree, id)?.parentId; const f = p ? useWorkspace.getState().nodeById(p) : null; return !!(f && f.sys === HISTORY_SYS) }, [])
  const selectNode = useCallback((id) => {
    setActive(id)
    const n = useWorkspace.getState().nodeById(id)
    if (n && n.ts && inHistory(id)) diag('ee2', `history-open age=${Math.round((Date.now() - n.ts) / 60000)}m`)
  }, [setActive, inHistory])
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
    const offQuit = window.poe2desktop?.ws?.onFlush?.(() => {
      const t0 = Date.now()
      useWorkspace.getState().flush().then(() => diag('ws', `ws-flush-on-quit ok ms=${Date.now() - t0}`)).catch(() => {}).finally(() => window.poe2desktop.ws.flushed())
    })
    return () => { document.removeEventListener('visibilitychange', flush); window.removeEventListener('pagehide', hide); offQuit?.() }
  }, [])

  // Clipboard-add target: the selected folder, else the selected node's parent, else root.
  const clipboardTarget = useCallback(() => {
    const api = treeApi.current
    const focused = api?.focusedNode?.data || null
    if (focused?.kind === 'folder') return focused.id
    const id = focused?.id || activeRef.current
    return id ? (locate(useWorkspace.getState().tree, id)?.parentId ?? null) : null
  }, [])
  const clipboardAdd = useCallback((targetId) => addFromClipboard(targetId === undefined ? clipboardTarget() : targetId), [clipboardTarget])

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
    diag('ws', `ws-undo n=${n || 1}`)
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
  // Several selected rows (shift/⌘-click) → one batch, one undo slot.
  const deleteMany = useCallback((ids) => {
    const recs = removeMany(ids)
    if (!recs.length) return
    diag('ws', `ws-undo n=${recs.length}`)
    bus.emit({ id: 'ws-undo', ttl: UNDO_TTL, node: (
      <div className="ws-undo">
        <span className="ws-undo-text">Deleted {recs.length} items</span>
        <button className="btn small primary" onClick={() => { restoreMany(recs); bus.emit({ id: 'ws-undo', dismiss: true }) }}>Undo</button>
      </div>) })
  }, [removeMany, restoreMany])
  const goLiveAll = useCallback((folderId) => {
    const eng = usePings.getState().engine
    const r = armFolder(folderId, Math.max(0, (eng.budgetMax || 20) - (eng.active || 0)))
    toast(r.armed ? `Armed ${r.armed} search${r.armed === 1 ? '' : 'es'}${r.skipped ? ` · ${r.skipped} skipped (no search yet or over the ${eng.budgetMax || 20}-socket cap)` : ''}` : 'Nothing to arm — run each search once first', !!r.armed)
  }, [armFolder])

  // Keyboard, scoped to the row container (react-arborist owns ↑↓ →← Home/End on its own):
  // Enter open · F2 rename · ⌫ delete (with undo) · ⌘N new search · ⌘⇧N new group · Esc clears the filter.
  const onTreeKey = useCallback((e, node) => {
    const mod = e.metaKey || e.ctrlKey
    if (mod && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) newGroup(); else newSearch(node?.data.kind === 'folder' ? node.data.id : null); return }
    if (mod && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); e.stopPropagation(); clipboardAdd(); return }
    if (!node) return
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (node.data.kind === 'folder') node.toggle(); else selectNode(node.data.id); return }
    if (e.key === 'F2') { e.preventDefault(); e.stopPropagation(); node.edit(); return }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault(); e.stopPropagation()
      const sel = [...(treeApi.current?.selectedIds || [])]
      if (sel.length > 1) deleteMany(sel); else requestDelete(node.data)
      return
    }
    if (e.key === 'Escape' && filter) { e.preventDefault(); setFilter('') }
  }, [newGroup, newSearch, selectNode, requestDelete, deleteMany, filter, clipboardAdd])

  // ⌘⇧V anywhere in the app (not inside an input) = add from clipboard.
  useEffect(() => {
    if (!isDesktop) return
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'v' || e.key === 'V') && !e.target.closest('input, textarea, [contenteditable]')) { e.preventDefault(); clipboardAdd() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [clipboardAdd])

  const openMenu = useCallback((e, d, node) => setMenu({ at: { x: e.clientX, y: e.clientY }, d, node }), [])
  const menuItems = useMemo(() => {
    if (!menu) return []
    const { d, node } = menu
    const isSearch = d.kind === 'search'
    const url = isSearch && d.slug ? tradeUrl(d, league, d.live) : null
    const folders = flatten(useWorkspace.getState().tree, n => n.kind === 'folder' && n.id !== d.id && !flatten(d.children || []).some(c => c.id === n.id))
    return [
      { label: 'Open', key: '↵', disabled: !isSearch, run: () => selectNode(d.id) },
      { label: isDesktop ? 'Open in window' : 'Open in browser', disabled: !url, run: () => openTrade(url) },
      { label: 'Copy link', disabled: !url, run: () => copyText(url) },
      { sep: true },
      ...(isDesktop && d.kind === 'folder' && d.sys !== HISTORY_SYS ? [{ label: 'Add from clipboard here', key: '⌘V', run: () => clipboardAdd(d.id) }] : []),
      ...(d.kind === 'folder' && d.sys === HISTORY_SYS ? [{ label: 'Clear history', danger: true, run: () => clearHistoryWithUndo() }] : []),
      { label: 'Rename', key: 'F2', disabled: d.kind === 'folder' && !!d.sys, run: () => setTimeout(() => node.edit(), 0) },
      { label: 'Duplicate', disabled: !isSearch, run: () => duplicate(d.id) },
      ...(isSearch && d.q && d.slug && !inHistory(d.id) ? [{ label: 'Re-run from item', run: () => rerunFromItem(d.id) }] : []),
      ...(d.kind === 'folder' ? [{ label: 'Sort A–Z', run: () => sortChildren(d.id) }] : []),
      ...(isDesktop && d.kind === 'folder' && d.sys !== HISTORY_SYS ? [{ label: 'Go live: all searches', run: () => goLiveAll(d.id) }, { label: 'Stop all live searches', run: () => { const n = disarmFolder(d.id); toast(n ? `Stopped ${n}` : 'None were live', !!n) } }] : []),
      { label: d.done ? 'Mark not done' : 'Mark done', disabled: !isSearch, run: () => setField(d.id, { done: !d.done }) },
      { label: 'Move to', children: [{ label: 'Top level', run: () => move(d.id, null, 0) }, ...folders.map(f => ({ label: f.name, run: () => move(d.id, f.id, 0) }))] },
      { sep: true },
      { label: 'Delete', key: '⌫', danger: true, run: () => requestDelete(d) },
    ]
  }, [menu, league, selectNode, duplicate, setField, move, requestDelete, clipboardAdd, rerunFromItem, sortChildren, goLiveAll, disarmFolder, inHistory])

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
    return n?.slug ? tradeUrl(n, league, n.live) : (n?.q && !n.degraded) ? queryUrl(n, league) : tradeHome(league)
  }, [activeId, league])

  // Default each freshly-mounted trade window to Instant Buyout (the mode travel-to-hideout
  // needs). Re-attaches per webview instance (keyed remount).
  useEffect(() => {
    const el = wv.current
    if (!isDesktop || !el) return
    // A q-mounted node already carries status.option — forcing the dropdown would rewrite EE2's query.
    const n = activeId ? useWorkspace.getState().nodeById(activeId) : null
    if (n?.q && !n.slug) return
    const onReady = () => ensureInstantBuyout(el).then(r => { if (r === 'other') setNavState(s => ({ ...s, hint: 'Set delivery to Instant Buyout for travel-to-hideout' })) })
    el.addEventListener('dom-ready', onReady)
    return () => el.removeEventListener('dom-ready', onReady)
  }, [activeId, league, wvNonce])

  // Capture a run search into the active entry. The trade SPA doesn't fire <webview> DOM
  // navigation events, but the guest webContents DOES — main forwards them here as
  // 'trade:webview-nav'. As soon as the URL becomes a search (has a slug) we save it and
  // auto-name it: "run a search → it's saved."
  useEffect(() => {
    if (!isDesktop || !window.poe2desktop?.trade?.onWebviewNav) return
    return window.poe2desktop.trade.onWebviewNav((p) => {
      // Only the embedded webview drives the workspace — never the open-trade pop-out.
      let myId = null
      try { myId = wv.current?.getWebContentsId() } catch {}
      if (!shouldAcceptNav(p, myId)) return
      const { url, phase } = p
      if (phase === 'start') { setNavState(s => ({ ...s, url, loading: true })); return }
      if (phase === 'stop') { setNavState(s => ({ ...s, url, loading: false })); return }
      setNavState(s => ({ ...s, url, hint: '' }))
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
      // A history row is the query EE2 built; the site's search id is never written into it (promote by dragging it out).
      if (inHistory(id)) return
      if (n.slug !== parsed.slug || n.live !== parsed.live || n.type !== parsed.type) {
        setField(id, { type: parsed.type, slug: parsed.slug, live: parsed.live })
      }
      if (n.auto !== false && wv.current) readSearchName(wv.current).then(name => { if (name) autoName(id, name) })
    })
  }, [nodeById, setField, autoName, inHistory])

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
  const activeUrl = activeNode?.slug ? tradeUrl(activeNode, league, activeNode.live) : activeNode?.q ? queryUrl(activeNode, league) : null
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
            {isDesktop && <Toggle checked={historyOn} onChange={v => saveHistoryPrefs({ enabled: v })} label="EE2" title="EE2 history — record every item copied in game under ExiledExchange2 History" />}
            {isDesktop && <button className="ws-icon-btn" title="Add from clipboard (⌘⇧V)" aria-label="Add from clipboard" onClick={() => clipboardAdd()}>⎘</button>}
            <button className="ws-icon-btn" title="New group" aria-label="New group" onClick={newGroup}>📁</button>
            <button className="ws-icon-btn primary" title="New search" aria-label="New search" onClick={() => newSearch(null)}>+</button>
          </div>
          {tree.length > 0 && (
            <div className="ws-filter">
              <input className="ws-filter-input" placeholder="Filter searches…" aria-label="Filter searches" value={filter}
                onChange={e => setFilter(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { setFilter(''); e.currentTarget.blur() } }} />
              {filter && <button className="ws-mini on" title="Clear filter" aria-label="Clear filter" onClick={() => setFilter('')}>✕</button>}
            </div>)}
          {tree.length === 0
            ? <div className="ws-tree ws-empty">
                <button className="ws-empty-add" onClick={() => newSearch(null)}>+ New search</button>
                <p className="ws-empty-hint">{EMPTY_HINT}{isDesktop && historyOn ? EMPTY_HINT_EE2 : '.'}</p>
              </div>
            : (
              <SearchTree treeRef={treeApi} filter={filter} onSelect={selectNode} onContext={openMenu} onKey={onTreeKey} onDelete={(id) => { const n = nodeById(id); if (n) requestDelete(n) }} renderTrailing={(d, node) => (
                confirmId === d.id
                  ? <span className="ws-confirm" onClick={e => e.stopPropagation()}>
                      <span>Delete {(d.children || []).length} inside?</span>
                      <button className="ws-mini on" title="Confirm delete" aria-label="Confirm delete" onClick={() => deleteNode(d.id)}>✓</button>
                      <button className="ws-mini on" title="Cancel" aria-label="Cancel" onClick={() => setConfirmId(null)}>✕</button>
                    </span>
                  : <>
                      {d.kind === 'folder' && d.sys === HISTORY_SYS && <button className="ws-mini" title="Clear history" aria-label="Clear history" onClick={e => { e.stopPropagation(); clearHistoryWithUndo() }}>🗑</button>}
                      {d.kind === 'folder' && d.sys !== HISTORY_SYS && <button className="ws-mini" title="New search here" aria-label="New search here" onClick={e => { e.stopPropagation(); newSearch(d.id) }}>+</button>}
                      {d.kind === 'search' && <button className={`ws-mini ${d.done ? 'on' : ''}`} title={d.done ? 'Mark not done' : 'Mark done'} aria-label={d.done ? 'Mark not done' : 'Mark done'} aria-pressed={!!d.done} onClick={e => { e.stopPropagation(); setField(d.id, { done: !d.done }) }}>✓</button>}
                      {!(d.kind === 'folder' && d.sys) && <button className="ws-mini" title="Rename" aria-label="Rename" onClick={e => { e.stopPropagation(); node.edit() }}>✎</button>}
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
            <div className="ws-webhint">
              {activeNode
                ? <span className="ws-webhint-name" title={navState.url || mountUrl}>{activeNode.name}</span>
                : <span className="ws-webhint-name ws-webhint-empty">Press <button className="ws-inline-add" onClick={() => newSearch(null)} aria-label="New search">+</button> to build a search · Paste a trade URL{isDesktop && historyOn ? EMPTY_HINT_EE2 : '.'}</span>}
              {navState.hint && <span className="ws-chip" title="The site's delivery dropdown could not be set automatically">{navState.hint}</span>}
              {!sessionOk && <span className="ws-chip warn" title="No PoE trade session is connected — the site may show a login page and captures can silently fail. Connect it in Settings → Accounts.">no session</span>}
              {activeNode && (activeNode.slug || activeNode.q
                ? <>
                    <span className="ws-chip ok">{activeNode.q ? 'from item' : 'captured'}</span>
                    {activeNode.live && <span className="ws-chip live">live</span>}
                  </>
                : <span className="ws-chip">build your search — it captures automatically</span>)}
              <span className="spacer" />
              {activeUrl && <button className="ws-mini on" title="Copy link" aria-label="Copy link" onClick={() => copyText(activeUrl)}>⧉</button>}
              {activeUrl && <button className="ws-mini on" title="Open in window" aria-label="Open in window" onClick={() => openTrade(activeUrl)}>↗</button>}
              <button className="ws-mini on" title="Reload" aria-label="Reload" onClick={() => setWvNonce(n => n + 1)}>↻</button>
            </div>
            <div className={`ws-progress ${navState.loading ? 'on' : ''}`} aria-hidden="true" />
            <webview key={`${activeId || 'home'}:${wvNonce}`} ref={wv} src={mountUrl} className="ws-webview" allowpopups="true" />
          </>
        ) : (
          <div className="ws-overlay">
            <p className="muted">The embedded trade window is desktop-only. Add searches here and open them in a browser tab.
              {activeNode?.slug && <><br /><button className="btn small primary" onClick={() => openTrade(tradeUrl(activeNode, league, false))}>Open “{activeNode.name}” in a tab</button></>}
            </p>
          </div>
        )}
      </section>
      {menu && <ContextMenu at={menu.at} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  )
}
