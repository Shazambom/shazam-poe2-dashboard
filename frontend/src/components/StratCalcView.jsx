import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Tree } from 'react-arborist'
import { api, bus, fmt, toast, undoToast } from '../lib/api.js'
import { useAutosave, usePoll } from '../lib/hooks.js'
import { uid } from '../lib/session.js'
import { find } from '../lib/tree.js'
import { useSync } from '../lib/syncStore.js'
import * as sc from '../lib/stratcalc.js'
import ContextMenu from './ContextMenu.jsx'
import Cur from './Cur.jsx'
import CurrencyPicker from './CurrencyPicker.jsx'
import RefreshButton from './RefreshButton.jsx'
import Seg from './Seg.jsx'
import Toggle from './Toggle.jsx'
import TradeBuilder from './TradeBuilder.jsx'
import { baseQuery, fullTabletQuery, uniqueQuery, waystonePriceQuery } from '../lib/regex/trade.js'
import { queryUrl } from '../lib/session.js'
import { nav } from '../lib/nav.js'
import { openInTrading } from '../lib/stratTrading.js'
import { useWorkspace } from '../lib/workspaceStore.js'

// Strategy → Strat Calculator: named farming strats in a sidebar tree (folders, drag and drop — the
// trade searches' tree), each a session you can leave and resume, and each one's profit in divines per
// hour. The math, the strats and the input rules are lib/stratcalc.js; the strats autosave to the user
// kv `strat_calc`; prices are divines per unit off the backend's one value table.

const PRICE_POLL_MS = 60_000
const HOLD_DELAY_MS = 400    // +1 held: repeats after this…
const HOLD_EVERY_MS = 90     // …this often
const SLOT_CHOICES = [1, 2, 3, 4].map(n => [n, String(n)])
const OVERLAY = '.cmdk-backdrop, .ctx-menu, .curpick-pop, [role="dialog"]'   // open over the page: keys are theirs
const newId = (kind) => `${kind}_${uid()}`
const shownNum = (v) => (v ? String(Math.round(v * 1e4) / 1e4) : '')

// A number box that takes what people type (lib/stratcalc.js parseNum: 1,5 · 3*12 · 40k): applies
// as soon as it reads as a number, settles on blur or Enter, goes back to the last value on garbage.
// ↑/↓ step by one, Shift by ten. A text box, so a scroll never changes a value.
function NumBox({ value, onChange, whole = false, label, autoFocus = false, placeholder = '0', onEnter, onBlank }) {
  const [draft, setDraft] = useState(null)
  const cancelled = useRef(false)   // Escape: the blur it causes must not settle (it would see the old draft)
  const fix = (n) => (whole ? Math.floor(n) : n)
  const settle = () => {
    if (cancelled.current) { cancelled.current = false; setDraft(null); return }
    if (draft == null) return
    if (onBlank && !String(draft).trim()) { onBlank(); setDraft(null); return }
    const n = sc.parseNum(draft)
    if (n != null) onChange(fix(n))
    setDraft(null)
  }
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); settle(); onEnter ? onEnter() : e.currentTarget.blur() }
    else if (e.key === 'Escape') { cancelled.current = true; setDraft(null); e.currentTarget.blur() }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const base = (draft != null ? sc.parseNum(draft) : null) ?? value ?? 0
      setDraft(null)
      onChange(Math.max(0, fix(base + (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1))))
    }
  }
  return (
    <input className="scalc-in" type="text" inputMode="decimal" aria-label={label} placeholder={placeholder}
      autoFocus={autoFocus} value={draft ?? shownNum(value)}
     
      onChange={e => { setDraft(e.target.value); const n = sc.parseNum(e.target.value); if (n != null) onChange(fix(n)) }}
      onBlur={settle} onKeyDown={onKey} />
  )
}

// An amount in divines: the value and the divine icon, "–" when there is no price.
function Div({ v, size = 13 }) {
  if (v == null || !Number.isFinite(v)) return <span className="muted">–</span>
  return <span className="wealth">{fmt.n(v, sc.divDigits(v))} <Cur id="divine" size={size} /></span>
}

// A total that changes because of an edit tints green or red for a moment (never on a tick or a
// price refresh: `bump` counts edits). Reduced motion: no animation (styles.css).
function Flash({ value, bump, children }) {
  const prev = useRef(value)
  const seen = useRef(bump)
  const [f, setF] = useState({ dir: '', n: 0 })
  useEffect(() => {
    const d = (value ?? 0) - (prev.current ?? 0)
    prev.current = value
    if (seen.current === bump) return
    seen.current = bump
    if (Math.abs(d) > 1e-12) setF(x => ({ dir: d > 0 ? 'up' : 'down', n: x.n + 1 }))
  }, [value, bump])
  return <span key={f.n} className={`scalc-flash ${f.dir}`}>{children}</span>
}

// The one place the clock ticks: re-renders its children (the clock, the hero, the sidebar's rates)
// once a second while a strat runs; the lists and pickers around it never re-render for time.
function Live({ running, children }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])
  return children(now)
}

// The session clock; click it to correct the time (a forgotten pause): 1:04:12, 1h 20m, 90m.
function ClockBox({ ms, on, onSet }) {
  const [draft, setDraft] = useState(null)
  if (draft == null) {
    return <button type="button" className={`scalc-clock ${on ? 'on' : ''}`} title="Edit time" onClick={() => setDraft(sc.clock(ms))}>{sc.clock(ms)}</button>
  }
  const done = () => { const v = sc.parseDuration(draft); if (v != null) onSet(v); setDraft(null) }
  return (
    <input className="scalc-clock scalc-clock-in" type="text" aria-label="Session time" autoFocus value={draft}
      onChange={e => setDraft(e.target.value)} onBlur={done}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setDraft(null) }} />
  )
}

// A row's worth in divines; click it to type the price of one (blank goes back to the market's).
function PriceCell({ r, prices, onPrice, pending }) {
  const [editing, setEditing] = useState(false)
  const v = sc.rowValue(r, prices)
  if (editing) {
    return (
      <span className="scalc-val" onBlur={() => setEditing(false)}>
        <NumBox value={r.price ?? 0} label="Price each, in divines" autoFocus placeholder={shownNum(prices[r.cur]) || 'each'}
          onChange={p => onPrice(p)} onBlank={() => onPrice(null)} onEnter={() => setEditing(false)} />
      </span>
    )
  }
  return (
    <button type="button" className="scalc-val scalc-val-btn" title="Price each" onClick={() => setEditing(true)}>
      {pending ? <span className="muted">…</span> : r.qty > 0 || v == null ? <Div v={v} /> : null}
    </button>
  )
}

// A currency × count list (loot, fixed costs), with "Add currency or item…" under it.
function Rows({ rows, prices, options, names, added, onAdd, onCreate, onQty, onPrice, onRemove, what, addRef, onEnter, pending, renderIcon, known }) {
  const avail = useMemo(() => { const taken = new Set(rows.map(sc.rowKey)); return options.filter(o => !taken.has(o.id)) }, [options, rows])
  return (
    <>
      {rows.map(r => {
        const key = sc.rowKey(r)
        const label = r.cur ? names[r.cur] ?? r.cur : r.name
        return (
          <div className="scalc-row" key={key}>
            <span className="scalc-name">
              {r.cur ? <Cur id={r.cur} name={names[r.cur]} text size={16} /> : <span className="cur cur-text">{r.name}</span>}
            </span>
            <NumBox whole value={r.qty} label={`${label} ${what}`} autoFocus={key === added}
              onChange={n => onQty(key, n)} onEnter={onEnter} />
            <PriceCell r={r} prices={prices} onPrice={p => onPrice(key, p)} pending={pending === key} />
            <button type="button" className="cap-x" title="Remove" aria-label={`Remove ${label}`} onClick={() => onRemove(key)}>×</button>
          </div>
        )
      })}
      <div className="scalc-add" ref={addRef}>
        <CurrencyPicker value="" placeholder="Add currency or item…" options={avail}
          onChange={id => onAdd(id)} onCreate={onCreate} renderIcon={renderIcon} known={known} />
      </div>
    </>
  )
}

// The sidebar: the strats in folders, dragged like trade searches (react-arborist, the trade-search
// tree's row style). The open strat's name is a text box right in its row; a folder renames on
// double-click. Rates come from `rateOf` (inside Live, so only they tick).
const TreeCtx = React.createContext(null)

function StratRow({ node, style, dragHandle }) {
  const d = node.data
  const { activeId, rateOf, runningId, onSelect, onMenu, onRename, onDelete, onRefresh, refreshing, nameBox } = React.useContext(TreeCtx)
  const folder = d.kind === 'folder'
  const active = d.id === activeId
  const cls = [folder ? 'folder' : 'search', active ? 'active' : '', node.willReceiveDrop ? 'drop-target' : '', node.isDragging ? 'dragging' : ''].join(' ')
  return (
    <div className={`ws-node ${cls}`} style={style} ref={dragHandle} role="treeitem" aria-level={node.level + 1}
      aria-expanded={folder ? node.isOpen : undefined} aria-selected={active || undefined}
      onClick={() => (folder ? node.toggle() : onSelect(d.id))}
      onDoubleClick={() => (folder ? node.edit() : setTimeout(() => nameBox.current?.focus(), 0))}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onMenu(e, d, node) }}>
      <span className="ws-grip" aria-hidden="true" title="Drag to move">⋮⋮</span>
      <span className="ws-caret">{folder ? (node.isOpen ? '▾' : '▸') : ''}</span>
      <span className="ws-icon">{folder ? '📁' : '📈'}</span>
      {folder && node.isEditing
        ? <input className="ws-edit" autoFocus defaultValue={d.name} aria-label="Folder name" onClick={e => e.stopPropagation()}
            onBlur={e => node.submit(e.target.value)}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') node.submit(e.currentTarget.value); if (e.key === 'Escape') node.reset() }} />
        : active
          ? <input ref={nameBox} key={`${d.id}:${d.name}`} className="scalc-strat-input" type="text" aria-label="Strat name" defaultValue={d.name}
              onClick={e => e.stopPropagation()}
              onBlur={e => onRename(d.id, e.target.value, d.name)}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = d.name; e.currentTarget.blur() } }} />
          : <span className="ws-name">{d.name}</span>}
      {!folder && d.id === runningId && <span className="dot ok" title="Running" />}
      {!folder && <span className="scalc-rate"><Div v={rateOf(d.id)} size={12} /></span>}
      {!folder && <span onClick={e => e.stopPropagation()}><RefreshButton className="scalc-refresh" title="Refresh its prices"
        busy={refreshing === d.id} onClick={() => onRefresh(d.id)} /></span>}
      <button type="button" className="scalc-x" title={folder ? 'Delete the folder and its strats' : 'Delete'} aria-label={`Delete ${d.name}`}
        onClick={e => { e.stopPropagation(); onDelete(d) }}>×</button>
    </div>
  )
}

function StratTree({ doc, ctx, change, treeRef }) {
  const names = useMemo(() => Object.fromEntries(doc.strats.map(s => [s.id, s.name])), [doc.strats])
  const data = useMemo(() => {
    const map = (nodes) => nodes.map(n => (n.kind === 'folder'
      ? { id: n.id, kind: 'folder', name: n.name, children: map(n.children) }
      : { id: n.id, kind: 'strat', name: names[n.id] ?? '' }))
    return map(doc.tree)
  }, [doc.tree, names])
  const initialOpen = useMemo(() => Object.fromEntries(sc.flattenFolders(doc.tree).map(f => [f.id, f.open])), []) // eslint-disable-line
  const wrap = useRef(null)
  const [dims, setDims] = useState({ w: 240, h: 300 })
  useEffect(() => {
    const el = wrap.current; if (!el) return
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el); return () => ro.disconnect()
  }, [])
  return (
    <div className="ws-tree scalc-tree" ref={wrap}>
      <TreeCtx.Provider value={ctx}>
        <Tree ref={treeRef} data={data} idAccessor="id" childrenAccessor={n => (n.kind === 'folder' ? n.children : null)}
          width={dims.w} height={dims.h} rowHeight={30} indent={14} rowClassName="ws-row"
          openByDefault={true} initialOpenState={initialOpen}
          onToggle={id => setTimeout(() => change(d => sc.setOpen(d, id, !!treeRef.current?.get(id)?.isOpen)), 0)}
          onMove={({ dragIds, parentId, index }) => change(d => dragIds.reduce((x, id, i) => sc.moveNode(x, id, parentId, index + i), d))}
          onRename={({ id, name }) => change(d => sc.renameFolder(d, id, name))}
          disableEdit={n => n.kind !== 'folder'}>
          {StratRow}
        </Tree>
      </TreeCtx.Provider>
    </div>
  )
}

// The tablets the picker offers: what the pipeline's table knows the full uses of (kv_ops tablet_uses),
// so every line's cost can be worked out. "Any tablet" when every normal base agrees.
const tabletId = (l) => (l.name ? `unique:${l.name}` : l.base ? `base:${l.base}` : 'any')
function tabletOptions(uses) {
  const any = sc.usesOf({ name: null, base: null }, uses) != null ? [{ id: 'any', name: 'Any tablet', pick: { name: null, base: null } }] : []
  const bases = uses.filter(u => u.name == null).map(u => ({ id: `base:${u.base}`, name: u.base, pick: { name: null, base: u.base } }))
  const uniq = uses.filter(u => u.name != null).map(u => ({ id: `unique:${u.name}`, name: u.name, keywords: [u.base], pick: { name: u.name, base: u.base } }))
  const byName = (a, b) => a.name.localeCompare(b.name)
  return [...any, ...bases.sort(byName), ...uniq.sort(byName)]
}

// What a linked search found, in the thing's own currency: an empty price box shows it.
const foundIn = (x, prices) => (x.link?.div != null && prices[x.cur] > 0 ? shownNum(x.link.div / prices[x.cur]) : '')

// 🔗 on a priced cost (Per map, a tablet line): builds its trade search, gold once linked.
const LinkBtn = ({ linked, label, onClick }) => (
  <button type="button" className={`ws-icon-btn scalc-link ${linked ? 'on' : ''}`} onClick={onClick}
    title={linked ? 'Edit its trade search' : 'Price it from a trade search'} aria-label={`Trade search for ${label}`}>🔗</button>
)

// One line of the tablet setup: which tablet, how many go in each map, the price of one. 🔗 builds
// the line's trade search; linked, an empty price box shows what the search found (in the line's
// currency) and a typed number wins over it.
function TabletLine({ l, free, options, costOptions, prices, pending, onEdit, onRemove, onLink }) {
  const label = options.find(o => o.id === tabletId(l))?.name ?? l.name ?? l.base ?? 'Any tablet'
  return (
    <div className="scalc-tablet">
      <CurrencyPicker value={tabletId(l)} options={options} renderIcon={null} placeholder="Tablet…"
        onChange={id => { const o = options.find(x => x.id === id); if (o) onEdit(o.pick) }} />
      <LinkBtn linked={!!l.link} label={label} onClick={onLink} />
      <button type="button" className="cap-x" title="Remove" aria-label={`Remove ${label}`} onClick={onRemove}>×</button>
      <Seg value={l.slots} options={SLOT_CHOICES.slice(0, l.slots + free)} title="In each map" onChange={n => onEdit({ slots: n })} />
      <NumBox value={l.price} label={`Price of one ${label}`} placeholder={pending ? '…' : foundIn(l, prices) || '0'}
        onChange={p => onEdit({ price: p })} onBlank={l.link ? () => onEdit({ price: null }) : undefined} />
      <CurrencyPicker value={l.cur} options={costOptions} onChange={c => onEdit({ cur: c })} />
    </div>
  )
}

// A unique's picker entry: the trade site's name, with its base when one name sits on two bases.
const uniqueId = (u) => `unique:${u.name}|${u.type}`
const pickIcon = (o, size) => (o.unique ? null : <Cur id={o.id} name={o.name} size={size} />)

export default function StratCalcView({ league, currencies }) {
  const [doc, setDoc] = useState(null)
  const [prices, setPrices] = useState({})
  const [uses, setUses] = useState([])          // the tablets' full uses (the pipeline's table, via the seed)
  const [bump, setBump] = useState(0)          // counts edits, so only an edit flashes a total
  const [menu, setMenu] = useState(null)        // { at, id } — the sidebar's right-click menu
  const [added, setAdded] = useState(null)      // the row just added: its count takes the focus
  const [uniques, setUniques] = useState([])    // the trade site's uniques (desktop only)
  const [pending, setPending] = useState(null)  // the unique or linked line whose price search is running (one at a time)
  const [building, setBuilding] = useState(null) // the tablet line whose trade search is open (Build on trade)
  const [refreshing, setRefreshing] = useState(null) // the strat whose ⟳ was pressed: it spins while its searches run
  const nameBox = useRef(null)                  // the open strat's name in the sidebar
  const treeRef = useRef(null)
  const lootAdd = useRef(null)
  const fileBox = useRef(null)                  // the hidden file picker behind ⤓ Import
  const { state, save, arm } = useAutosave(api.putStratCalc)

  // The strats are read once, then owned by the inputs (a poll never overwrites typing); a first visit
  // opens on a blank strat. Prices follow the market every minute and on the app-wide ⟳.
  useEffect(() => {
    api.stratCalc().then(d => {
      setPrices(d.prices || {})
      setUses(d.uses || [])
      let n = sc.normalize(d.calc)
      if (!n.strats.length) n = sc.newStrat(n, { id: newId('s'), name: sc.nextName(n), now: Date.now() })
      setDoc(n)
      arm()
    }).catch(() => {})
  }, []) // eslint-disable-line
  const tick = useSync(s => s.tick)
  usePoll(() => api.stratPrices().then(d => setPrices(d.prices || {})).catch(() => {}), PRICE_POLL_MS, [tick])

  const change = useCallback((fn) => setDoc(d => { const n = fn(d); if (n !== d) save(n); return n }), [save])
  // An Undo needs this view mounted (it runs through `change`): leaving it takes the toast along.
  useEffect(() => () => bus.emit({ id: 'sc-undo', dismiss: true }), [])
  // An edit (it flashes the totals): `editDoc` for the whole calculator, `editActive` for the open strat.
  const editDoc = useCallback((fn) => { setBump(b => b + 1); change(fn) }, [change])
  const editActive = useCallback((fn) => editDoc(d => (d.active ? sc.edit(d, d.active, fn, Date.now()) : d)), [editDoc])
  const toggleRun = useCallback(() => change(d => (d.active ? sc.toggle(d, d.active, Date.now()) : d)), [change])
  const addMaps = useCallback((k) => editActive(s => ({ ...s, maps: { ...s.maps, count: Math.max(0, s.maps.count + k) } })), [editActive])
  const anyRunning = !!doc?.strats.some(s => sc.running(s.timer))

  // Space starts/pauses, M counts a map — only while this view is mounted, and never while a box
  // has the focus or the palette / a menu is open (lib/stratcalc.js shortcut).
  const keys = useRef(null)
  keys.current = (a) => (a === 'toggle' ? toggleRun() : addMaps(1))
  useEffect(() => {
    const onKey = (e) => {
      const a = sc.shortcut(e, { typing: sc.isTyping(document.activeElement), overlay: !!document.querySelector(OVERLAY) })
      if (!a) return
      e.preventDefault()
      keys.current(a)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Uniques: the trade site's own list, from the desktop shell (the web build has no trade session).
  useEffect(() => {
    window.poe2desktop?.trade?.uniques?.().then(l => setUniques(Array.isArray(l) ? l : [])).catch(() => {})
  }, [])

  // A unique's price floor: one background trade search at a time (the shared budget paces them) for
  // each unique in the open strat with no floor, or a floor over an hour old, and no typed price.
  // Not logged in to trade: stop for this visit; the row stays open for a typed price.
  const retryAt = useRef(new Map())             // key → not before this time (this visit), so a miss never loops
  const pauseUntil = useRef(0)                  // the trade site said wait: no search before this
  const [wake, setWake] = useState(0)           // bumped when a wait ends, so the queue runs again
  const wakeTimer = useRef(null)
  useEffect(() => () => clearTimeout(wakeTimer.current), [])
  const blocked = useRef(false)
  const pricesRef = useRef(prices)
  pricesRef.current = prices
  const open = doc && sc.activeStrat(doc)
  // A linked tablet search is priced the same way, held to the tablet's full uses: the average of its
  // cheapest ten listings.
  useEffect(() => {
    const trade = window.poe2desktop?.trade
    if (!trade?.priceQuery || !open || !league || pending || blocked.current) return
    const t = Date.now()
    if (t < pauseUntil.current) return
    const waiting = (key) => t < (retryAt.current.get(key) ?? 0)
    const r = [...open.loot, ...open.fixed].find(x => sc.needsFloor(x, t) && !waiting(sc.rowKey(x)))
    const l = r ? null : open.tablets.lines.find(x => sc.needsLinkPrice(x, t) && !waiting(`link:${x.id}`) && sc.usesOf(x, uses) != null)
    const m = !r && !l && sc.needsLinkPrice(open.maps, t) && !waiting('link:maps') ? open.maps : null
    if (!r && !l && !m) return
    const key = r ? sc.rowKey(r) : l ? `link:${l.id}` : 'link:maps', stratId = open.id
    retryAt.current.set(key, t + sc.FLOOR_TTL_MS)
    setPending(key)
    const query = r ? uniqueQuery(r.name, r.base) : l ? fullTabletQuery(l.link.query, sc.usesOf(l, uses)) : waystonePriceQuery(m.link.query)
    trade.priceQuery({ query, league }).then(res => {
      if (res?.ok) {
        const div = r ? sc.floorDiv(res.listings, pricesRef.current) : sc.avgDiv(res.listings, pricesRef.current)
        const now = Date.now()
        if (div != null) change(d => (r ? sc.recordFloor(d, stratId, key, div, now) : l ? sc.recordLinkPrice(d, stratId, l.id, div, now) : sc.recordMapsPrice(d, stratId, div, now)))
        else if (res.listings.length) retryAt.current.set(key, Date.now() + 60_000)   // no prices yet: again in a minute
      } else if (res?.error === 'auth') blocked.current = true
      else if (res?.error === 'rate') {
        // every search waits, not just this one; this one is due again when the wait ends (not an hour
        // later), and nothing else would re-run the queue then
        const until = Date.now() + (res.retryAfter || 60) * 1000
        pauseUntil.current = until
        retryAt.current.set(key, until)
        clearTimeout(wakeTimer.current)
        wakeTimer.current = setTimeout(() => setWake(w => w + 1), until - Date.now() + 250)
      }
    }).catch(() => {}).finally(() => setPending(null))
  }, [open, league, pending, change, uses, wake])

  // +1 held repeats; released, left or cancelled, it stops.
  const hold = useRef(null)
  const stopHold = () => { clearTimeout(hold.current?.t); clearInterval(hold.current?.i); hold.current = null }
  useEffect(() => stopHold, [])
  const startHold = (e) => {
    if (e.button !== 0) return
    addMaps(1)
    stopHold()
    hold.current = { t: setTimeout(() => { hold.current = { i: setInterval(() => addMaps(1), HOLD_EVERY_MS) } }, HOLD_DELAY_MS) }
  }

  const costOptions = currencies?.currencies ?? []
  const names = useMemo(() => Object.fromEntries(costOptions.map(c => [c.id, c.name])), [costOptions])
  const options = useMemo(() => {
    const twice = new Set(), seen = new Set()
    for (const u of uniques) { if (seen.has(u.name)) twice.add(u.name); seen.add(u.name) }
    return [...costOptions, ...uniques.map(u => ({ id: uniqueId(u), name: twice.has(u.name) ? `${u.name} (${u.type})` : u.name, keywords: [u.type], unique: u }))]
  }, [costOptions, uniques])
  const tablets = useMemo(() => tabletOptions(uses), [uses])
  // A stopped strat's rate does not move with the clock: worked out once per edit or price change, so
  // the sidebar's once-a-second tick only redoes the running strat's.
  const stoppedRates = useMemo(() => new Map((doc?.strats ?? []).filter(x => !sc.running(x.timer))
    .map(x => [x.id, sc.tally(x, prices, 0, uses).perHour])), [doc?.strats, prices, uses])
  const known = useMemo(() => new Set(options.map(o => o.name.toLowerCase())), [options])

  if (!doc) return <div className="single"><p className="hint">Loading…</p></div>

  const s = sc.activeStrat(doc)
  const newStrat = () => change(d => sc.newStrat(d, { id: newId('s'), name: sc.nextName(d), now: Date.now() }))
  const newFolder = () => {
    const id = newId('f')
    change(d => sc.newFolder(d, { id, name: 'New folder' }))
    setTimeout(() => treeRef.current?.get(id)?.edit(), 0)
  }
  const deleteStrat = (id) => {
    const { doc: next, removed } = sc.removeStrat(doc, id)
    change(() => next)
    if (removed) undoToast('sc-undo', `Deleted “${removed.strat.name}”`, () => change(d => sc.restoreStrat(d, removed)))
  }
  const deleteFolder = (id) => {
    const { doc: next, removed } = sc.removeFolder(doc, id)
    change(() => next)
    if (removed) undoToast('sc-undo', `Removed the folder “${removed.node.name}”`, () => change(d => sc.restoreFolder(d, removed)))
  }
  // A folder with everything in it: its folders and strats go too, and one Undo brings all of it back.
  const deleteFolderDeep = (id) => {
    const { doc: next, removed } = sc.removeFolderDeep(doc, id)
    change(() => next)
    const n = removed?.strats.length ?? 0
    if (removed) undoToast('sc-undo', `Deleted “${removed.node.name}”${n ? ` and ${n} strat${n === 1 ? '' : 's'}` : ''}`, () => change(d => sc.restoreFolderDeep(d, removed)))
  }
  // Sharing: a strat or folder to Downloads as a .arbiterstrat file; a file back in as copies.
  const exportNode = (id) => {
    const text = sc.exportStrats(doc, id, Date.now())
    const name = find(doc.tree, id)?.name ?? doc.strats.find(x => x.id === id)?.name ?? 'strat'
    window.poe2desktop?.ws?.exportFile(`${name}.arbiterstrat`, text).then(() => toast('Saved to Downloads')).catch(() => toast('Could not save the file', false))
  }
  const importFile = (file) => file?.text().then(text => {
    const r = sc.importStrats(doc, text, { newId, now: Date.now() })
    if (r) change(() => r.doc)
    toast(r ? `Imported ${r.count} strat${r.count === 1 ? '' : 's'}` : "Couldn't read this strat file", !!r)
  }).catch(() => toast("Couldn't read this strat file", false))
  const menuItems = !menu ? [] : menu.kind === 'folder' ? [
    { label: 'Rename', run: () => menu.node.edit() },
    ...(window.poe2desktop?.ws ? [{ label: 'Export…', run: () => exportNode(menu.id) }] : []),
    { sep: true },
    { label: 'Delete folder, keep strats', run: () => deleteFolder(menu.id) },
    { label: 'Delete folder and its strats', run: () => deleteFolderDeep(menu.id) },
  ] : [
    { label: 'Duplicate', run: () => change(d => sc.duplicate(d, menu.id, { id: newId('s'), now: Date.now() })) },
    { label: 'Rename', run: () => { change(d => sc.select(d, menu.id)); setTimeout(() => nameBox.current?.focus(), 0) } },
    ...(window.poe2desktop?.ws ? [{ label: 'Export…', run: () => exportNode(menu.id) }] : []),
    { sep: true },
    { label: 'Delete', run: () => deleteStrat(menu.id) },
  ]
  const treeCtx = (now) => ({
    activeId: doc.active, nameBox, runningId: doc.strats.find(z => sc.running(z.timer))?.id ?? null,
    rateOf: (id) => { if (stoppedRates.has(id)) return stoppedRates.get(id); const x = doc.strats.find(z => z.id === id); return x ? sc.tally(x, prices, now, uses).perHour : null },
    onSelect: (id) => change(d => sc.select(d, id)),
    onMenu: (e, d, node) => setMenu({ at: { x: e.clientX, y: e.clientY }, id: d.id, kind: d.kind, node }),
    onDelete: (d) => (d.kind === 'folder' ? deleteFolderDeep(d.id) : deleteStrat(d.id)),
    // ⟳: open the strat and price it now — its searches due, this visit's back-off forgotten, the market again.
    onRefresh: (id) => {
      retryAt.current.clear()
      blocked.current = false
      change(d => sc.restale(sc.select(d, id), id))
      setRefreshing(id)
      api.stratPrices().then(r => setPrices(r.prices || {})).catch(() => {})
    },
    refreshing: refreshing && pending ? refreshing : null,
    // A rename counts only when the name changed, so clicking in and out never reorders anything.
    onRename: (id, name, was) => { if (String(name).trim() && String(name).trim() !== was) change(x => sc.rename(x, id, name, Date.now())) },
  })

  const sidebar = (
    <aside className="rail scalc-rail">
      <section className="capcard scalc-stratcard" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
        onDrop={e => { const f = e.dataTransfer.files?.[0]; if (f) { e.preventDefault(); importFile(f) } }}>
        <h2>Strats
          <span className="spacer" />
          <input ref={fileBox} type="file" accept=".arbiterstrat,application/json" hidden
            onChange={e => { importFile(e.target.files?.[0]); e.target.value = '' }} />
          <button type="button" className="ws-icon-btn" title="Import a strat file" aria-label="Import a strat file" onClick={() => fileBox.current?.click()}>⤓</button>
          <button type="button" className="ws-icon-btn" title="New folder" aria-label="New folder" onClick={newFolder}>📁</button>
          <button type="button" className="ws-icon-btn primary" title="New strat" aria-label="New strat" onClick={newStrat}>+</button>
        </h2>
        <Live running={anyRunning}>{now => <StratTree doc={doc} ctx={treeCtx(now)} change={change} treeRef={treeRef} />}</Live>
      </section>
      {menu && <ContextMenu at={menu.at} items={menuItems} onClose={() => setMenu(null)} />}
    </aside>
  )

  if (!s) {
    return (
      <div className="workspace scalc">
        {sidebar}
        <main className="main"><div className="empty"><button type="button" className="btn primary" onClick={newStrat}>New strat</button></div></main>
      </div>
    )
  }

  const t = sc.tally(s, prices, Date.now(), uses)   // the cost lines (they don't change with time)
  const on = sc.running(s.timer)
  const sign = (v) => (v == null ? '' : v < 0 ? 'loss' : v > 0 ? 'gain' : '')
  // A cost line's value, once it costs something (or can't be priced): no "0 ◆" on an empty line.
  const lineVal = (v) => <span className="scalc-val">{v == null || v > 0 ? <Div v={v} /> : null}</span>

  const rowsEdit = (part) => ({
    onQty: (key, n) => editActive(x => ({ ...x, [part]: sc.setQty(x[part], key, n) })),
    onPrice: (key, p) => editActive(x => ({ ...x, [part]: sc.setPrice(x[part], key, p > 0 ? p : null) })),
    onAdd: (id) => {
      const u = options.find(o => o.id === id)?.unique
      setAdded(id)
      editActive(x => ({ ...x, [part]: u ? sc.addUnique(x[part], u) : sc.addRow(x[part], id) }))
    },
    onCreate: (name) => {
      const hit = options.find(o => o.name.toLowerCase() === name.toLowerCase())
      if (hit) return rowsEdit(part).onAdd(hit.id)   // already listed or pickable: that row, not a priceless copy
      setAdded(`custom:${name}`)
      editActive(x => ({ ...x, [part]: sc.addCustom(x[part], name) }))
    },
    onRemove: (key) => {
      const i = s[part].findIndex(r => sc.rowKey(r) === key)
      const gone = s[part][i]
      editActive(x => ({ ...x, [part]: sc.removeRow(x[part], key) }))
      if (gone) undoToast('sc-undo', `Removed ${gone.cur ? names[gone.cur] ?? gone.cur : gone.name}`, () => editActive(x => (
        x[part].some(r => sc.rowKey(r) === key) ? x : { ...x, [part]: [...x[part].slice(0, i), gone, ...x[part].slice(i)] })))
    },
  })
  const costCur = (part) => (cur) => editDoc(d => sc.setCostCur(d, d.active, part, cur, Date.now()))
  const free = sc.MAX_TABLETS - sc.tabletSlots(s)
  const editTablet = (lid) => (patch) => editDoc(d => sc.editTablet(d, d.active, lid, patch, Date.now()))
  // What a linked search found, in the thing's own currency (the empty price box shows it).
  // The trade window's job (Build on trade): the map price or a tablet line. A linked one reopens its own
  // search; a new one starts on waystones, or on its tablet. `priced` is the search as it is priced (a
  // tablet held to full uses): what the window opens on and what Open in Trading shows.
  const tabletName = (l) => tablets.find(o => o.id === tabletId(l))?.name ?? 'Any tablet'
  const built = s.tablets.lines.find(l => l.id === building)
  const n = built && sc.usesOf(built, uses)
  const target = building === 'maps' ? {
    title: 'Waystones', x: s.maps, base: baseQuery({ category: { option: 'map.waystone' } }, []),
    priced: waystonePriceQuery, link: (d, f) => sc.linkMaps(d, d.active, f, Date.now()), unlink: (d) => sc.unlinkMaps(d, d.active, Date.now()),
  } : built ? {
    title: tabletName(built), x: built,
    base: { query: { ...baseQuery({ category: { option: 'map.tablet' } }, []).query, ...(built.base ? { type: built.base } : {}), ...(built.name ? { name: built.name } : {}) } },
    priced: (q) => fullTabletQuery(q, n ?? 10), link: (d, f) => sc.linkTablet(d, d.active, built.id, f, Date.now()), unlink: (d) => sc.unlinkTablet(d, d.active, built.id, Date.now()),
  } : null
  const toTrading = (query, name) => { setBuilding(null); openInTrading({ query, name, league, store: useWorkspace.getState, go: () => nav.goTrading() }) }
  const backToAdd = () => lootAdd.current?.querySelector('.curpick-input')?.focus()

  return (
    <div className="workspace scalc">
      {sidebar}
      <main className="main">
        <Live running={on}>{now => {
          const ms = sc.elapsedMs(s.timer, now)
          const live = sc.tally(s, prices, now, uses)
          return (
            <div className="scalc-top">
              <div className="scalc-timer">
                {s.time.on ? (
                  <span className="scalc-hm">
                    <NumBox whole value={sc.hm(s.time.ms).h} label="Hours" onChange={h => editActive(x => ({ ...x, time: { ...x.time, ms: sc.fromHm(h, sc.hm(x.time.ms).m) } }))} />
                    <span className="muted">h</span>
                    <NumBox whole value={sc.hm(s.time.ms).m} label="Minutes" onChange={m => editActive(x => ({ ...x, time: { ...x.time, ms: sc.fromHm(sc.hm(x.time.ms).h, m) } }))} />
                    <span className="muted">m</span>
                  </span>
                ) : <>
                  <ClockBox ms={ms} on={on} onSet={v => editActive(x => ({ ...x, timer: sc.setElapsed(x.timer, v, Date.now()) }))} />
                  <button type="button" className={`btn ${on ? '' : 'primary'}`} title="Space" onClick={toggleRun}>{on ? 'Pause' : ms > 0 ? 'Resume' : 'Start'}</button>
                </>}
                <Toggle checked={s.time.on} label="Override" ariaLabel="Override the session time"
                  onChange={v => editActive(x => (v ? sc.timeOverrideOn(x, Date.now()) : { ...x, time: { ...x.time, on: false } }))} />
                <span className="save-state">{state === 'saving' ? 'saving…' : state === 'saved' ? 'saved ✓' : ''}</span>
              </div>
              <div className="scalc-result">
                <div className="stat-label">Profit / hour</div>
                <div className={`stat-val ${sign(live.perHour)}`}><Div v={live.perHour} size={22} /></div>
                <div className="scalc-sums">
                  <span>Net <Flash value={t.net} bump={bump}><Div v={t.net} size={12} /></Flash></span>
                  <span>Loot <Flash value={t.loot} bump={bump}><Div v={t.loot} size={12} /></Flash></span>
                  <span>Costs <Flash value={-t.costs} bump={bump}><Div v={t.costs} size={12} /></Flash></span>
                </div>
              </div>
            </div>
          )
        }}</Live>

        <div className="scalc-cols">
          <section className="capcard">
            <h2>Loot</h2>
            <Rows rows={s.loot} prices={prices} options={options} names={names} added={added} what="looted"
              addRef={lootAdd} onEnter={backToAdd} pending={pending} renderIcon={pickIcon} known={known} {...rowsEdit('loot')} />
          </section>

          <section className="capcard scalc-costs">
            <h2>Costs</h2>
            <div className="scalc-line">
              <span className="scalc-label">Maps run</span>
              <NumBox whole value={s.maps.count} label="Maps run" onChange={n => editActive(x => ({ ...x, maps: { ...x.maps, count: n } }))} />
              <button type="button" className="btn scalc-plus" title="M"
                onPointerDown={startHold} onPointerUp={stopHold} onPointerLeave={stopHold} onPointerCancel={stopHold}
                onClick={e => { if (e.detail === 0) addMaps(1) }}
                onContextMenu={e => { e.preventDefault(); addMaps(-1) }}>+1</button>
            </div>
            {!s.override.on && <>
              <div className="scalc-line scalc-mapline">
                <span className="scalc-label">Per map</span>
                <NumBox value={s.maps.price} label="Price per map" placeholder={pending === 'link:maps' ? '…' : foundIn(s.maps, prices) || '0'}
                  onChange={p => editActive(x => ({ ...x, maps: { ...x.maps, price: p } }))}
                  onBlank={s.maps.link ? () => editActive(x => ({ ...x, maps: { ...x.maps, price: null } })) : undefined} />
                <CurrencyPicker value={s.maps.cur} options={costOptions} onChange={costCur('maps')} />
                <LinkBtn linked={!!s.maps.link} label="maps" onClick={() => setBuilding('maps')} />
                {lineVal(t.maps)}
              </div>
              <div className="scalc-line">
                <span className="scalc-label">Tablets</span>
                <span className="scalc-addtab-cell">
                  {free > 0 && <button type="button" className="btn scalc-addtab" onClick={() => editDoc(d => sc.addTablet(d, d.active, { id: newId('t'), now: Date.now() }))}>+ Add tablet</button>}
                </span>
                {lineVal(t.tablets)}
              </div>
              {s.tablets.lines.map(l => (
                <TabletLine key={l.id} l={l} free={free} options={tablets} costOptions={costOptions} prices={prices}
                  pending={pending === `link:${l.id}`} onLink={() => setBuilding(l.id)}
                  onEdit={editTablet(l.id)} onRemove={() => editDoc(d => sc.removeTablet(d, d.active, l.id, Date.now()))} />
              ))}
            </>}
            <div className="scalc-line">
              <span className="scalc-label">Override</span>
              <Toggle checked={s.override.on} ariaLabel="Override the maps and tablets cost"
                onChange={v => editActive(x => (v ? sc.overrideOn(x, prices, uses) : { ...x, override: { ...x.override, on: false } }))} />
            </div>
            {s.override.on && (
              <div className="scalc-line">
                <span className="scalc-label">Total</span>
                <NumBox value={s.override.amount} label="Maps and tablets, total" autoFocus
                  onChange={a => editActive(x => ({ ...x, override: { ...x.override, amount: a } }))} />
                <CurrencyPicker value={s.override.cur} options={costOptions} onChange={costCur('override')} />
                {lineVal(t.override)}
              </div>
            )}
            <div className="pulse-group-label scalc-micro">Fixed</div>
            <Rows rows={s.fixed} prices={prices} options={options} names={names} added={added} what="spent" pending={pending} renderIcon={pickIcon} known={known} {...rowsEdit('fixed')} />
          </section>
        </div>
      </main>
      {target && (
        <TradeBuilder league={league} title={`Trade search · ${target.title}`} url={queryUrl({ q: JSON.stringify(target.priced(target.x.link?.query ?? target.base)) }, league)}
          onClose={() => setBuilding(null)}
          onUnlink={target.x.link ? () => { editDoc(target.unlink); setBuilding(null) } : null}
          onOpenTrading={target.x.link && (building === 'maps' || n != null)
            ? () => toTrading(target.priced(target.x.link.query), target.x.link.query.query?.type ?? target.title) : null}
          onUse={(f) => { editDoc(d => target.link(d, f)); setBuilding(null) }} />
      )}
    </div>
  )
}
