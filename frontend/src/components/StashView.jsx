import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, fmt, surface, toast } from '../lib/api.js'
import { wealthDigits, wealthUnit } from '../lib/wealth.js'
import { useAutosave } from '../lib/hooks.js'
import { useStatus, ensureSettings } from '../lib/statusStore.js'
import { useSync } from '../lib/syncStore.js'
import { useWorkspace } from '../lib/workspaceStore.js'
import { flatten } from '../lib/tree.js'
import { salesStats, relativeTime, rarityOf } from '../lib/sales.js'
import { holdingWorth } from '../lib/capital.js'
import { CASH, addAmount, addCredit, cleanQty, parseAmount, stashGroups, netWorth, liquidNetWorth, flipGroup, flipFold, isFolded, groupAccent, isCounted, stashMatches, salesToast, UNGROUPED } from '../lib/stash.js'
import { diag } from '../lib/diag.js'
import { hasTradeEngine as isDesktop } from '../lib/session.js'
import { nav } from '../lib/nav.js'
import { useCurrencies } from '../lib/icons.js'
import ItemCard from './ItemCard.jsx'
import Cur from './Cur.jsx'
import CurrencyPicker from './CurrencyPicker.jsx'
import RefreshButton from './RefreshButton.jsx'
import Toggle from './Toggle.jsx'
import Wealth, { Native } from './Wealth.jsx'

const POLL_MS = 10 * 60 * 1000
// Last sales fetch per league, kept across tab switches: re-opening the tab must NOT spend another request
// (the history endpoint penalises for ~1 h and the budget is shared by every machine on the account).
const lastFetchAt = new Map()
const FOLD_KEY = 'arbiter:stash-folded'
const readFolds = () => { try { return JSON.parse(localStorage.getItem(FOLD_KEY)) || {} } catch { return {} } }
const writeFolds = (f) => { try { localStorage.setItem(FOLD_KEY, JSON.stringify(f)) } catch {} }

// Trading → Stash: what you hold, grouped by the game's own category for each item (lib/stash.js), with
// net worth and liquid net worth, and the trade site's Merchant History beside it (new sales are credited
// to the holdings). Holdings edit here; the Arbitrage rail only shows the part a loop may start from.
export default function StashView({ league }) {
  const status = useStatus(s => s.status)
  const refreshHeader = useStatus(s => s.refresh)
  const { list: currencies, nameOf } = useCurrencies()
  const sel = league || ''

  // ---- holdings (the editor that used to be the "What you hold" card)
  // The store's capital is THE copy: a save puts the server's answer there, and a poll that started
  // before a save never overwrites it (statusStore).
  const data = useStatus(s => s.capital)
  const [qty, setQty] = useState(null)          // { currency: "qty as typed" }
  const qtyRef = useRef(null)
  qtyRef.current = qty
  // The currencies whose total the user typed (or removed) since the last save: the server credits a sale of
  // one only when it was made after that count. The add bar and the credit re-save are not counts.
  const recounted = useRef(new Set())
  const { state: saveState, save, flush, hold, release, arm } = useAutosave(async (rows) => {
    const entries = {}
    Object.entries(rows).forEach(([c, v]) => { const n = Number(v); if (Number.isFinite(n) && n > 0) entries[c] = n })
    const counted = [...recounted.current]
    recounted.current.clear()
    await surface(useStatus.getState().saveCapital(entries, counted))
  })
  // Seeded once from whichever copy arrives first, then owned by the inputs: a poll never overwrites typing.
  const seed = (cap) => {
    const r = Object.fromEntries(CASH.map(p => [p, 0]))
    cap.rows.forEach(x => { r[x.currency] = x.qty })
    setQty(r); arm()
  }
  // Never from a copy older than a save still in flight (an edit made just before leaving the page).
  const capitalSaving = useStatus(s => s.capitalSaving)
  useEffect(() => { if (!qty && data && !capitalSaving) seed(data) }, [data, qty, capitalSaving]) // eslint-disable-line
  const tick = useSync(s => s.tick)
  const tick0 = useRef(tick)
  const setOne = (c, v) => { recounted.current.add(c); setQty(r => { const n = { ...r, [c]: v }; save(n); return n }) }

  // ---- the "count toward liquid net worth" switches (settings `stash_counted`; only choices are stored)
  const stored = useStatus(s => s.settings?.stash_counted)
  const [choices, setChoices] = useState(null)
  useEffect(() => { ensureSettings().catch(() => {}) }, [])
  // Stored choices load under any made before the settings arrived (those are newer).
  useEffect(() => { if (stored) setChoices(c => ({ ...stored, ...(c || {}) })) }, [stored]) // eslint-disable-line
  const choose = (patch) => {
    setChoices(c => ({ ...(c || {}), ...patch }))
    // A switched-off holding also stops being arbitrage capital: re-read the holdings once saved.
    useStatus.getState().saveSettings({ stash_counted: patch }).then(() => refreshHeader()).catch(() => toast('Could not save that choice', false))
  }
  // Removing a holding forgets its switch too: added back later, it starts at the default.
  const remove = (c) => {
    recounted.current.add(c)
    setQty(r => { const n = { ...r }; delete n[c]; save(n); return n })
    if (choices && c in choices) choose({ [c]: null })
  }

  // ---- groups
  const groupOf = useMemo(() => Object.fromEntries(currencies.map(c => [c.id, c.group])), [currencies])
  const rows = useMemo(() => Object.keys(qty || {}).map(c => {
    const v = data?.rows.find(r => r.currency === c)
    return { ...(v || {}), currency: c, name: nameOf(c), typed: qty[c] }
  }), [qty, data, nameOf]) // eslint-disable-line
  const dflt = data?.counted_by_default   // the one default (backend settings.STASH_COUNTED_BY_DEFAULT)
  const groups = useMemo(() => stashGroups(rows, groupOf, choices, dflt), [rows, groupOf, choices, dflt])
  const total = netWorth(rows)
  const syncing = !!data?.syncing
  const liquid = syncing ? null : liquidNetWorth(rows, choices, dflt)
  const icons = data?.group_icons || {}
  const pairUnit = wealthUnit(total, data?.reference ?? 'exalted', status?.wealth_prices)?.unit   // both figures, one scale
  const ref = data?.reference ?? 'exalted'

  // The add bar (pinned at the top): pick a currency, say how many, Add.
  const [pick, setPick] = useState('')
  const pickRef = useRef('')            // the pick as of now: a second press in the same instant finds none
  pickRef.current = pick
  const [amount, setAmount] = useState('1')
  const addPicked = () => {
    const id = pickRef.current, n = parseAmount(amount)
    if (!id || n == null) return
    pickRef.current = ''
    setQty(r => { const next = addAmount(r, id, n); if (next !== r) save(next); return next })
    unfold(id); setPick('')
  }
  // The sales column pins below the pinned header: its real height, measured (it wraps on narrow windows).
  const viewRef = useRef(null), headRef = useRef(null)
  useEffect(() => {
    const head = headRef.current, view = viewRef.current
    if (!head || !view || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => view.style.setProperty('--stash-head-h', `${head.offsetHeight}px`))
    ro.observe(head)
    return () => ro.disconnect()
  }, [qty == null]) // eslint-disable-line
  const [folds, setFolds] = useState(readFolds)
  const [q, setQ] = useState('')
  const searchRef = useRef(null)
  const folded = (g) => isFolded(g, folds, total, q)
  const toggleFold = (g) => setFolds(f => { const n = flipFold(g, f, total, q); if (n !== f) writeFolds(n); return n })
  // An added currency opens its group so the user sees it land.
  const unfold = (id) => setFolds(f => ({ ...f, [groupOf[id] || UNGROUPED]: false }))   // for now; the saved folds stay as the user left them
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.target.closest?.('input, textarea, select, [contenteditable]')) return
      e.preventDefault(); searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---- sales (Merchant History, fetched through the user's own session under the shared rate budget)
  const tree = useWorkspace(s => s.tree)
  const [sales, setSales] = useState({ rows: [], leagues: [] })
  const [open, setOpen] = useState(null)
  const [busy, setBusy] = useState(false)
  const [lastFetch, setLastFetch] = useState(null)
  const loadSales = (lg) => api.sales(lg).then(setSales).catch(() => {})
  useEffect(() => { if (sel) loadSales(sel) }, [sel])
  const refresh = async (auto = false) => {
    if (!isDesktop || !sel || busy) return
    if (auto && Date.now() - (lastFetchAt.get(sel) || 0) < POLL_MS) return   // too soon — serve the ledger
    lastFetchAt.set(sel, Date.now())
    setBusy(true)
    // New sales are credited to the holdings on the server. Send any unsaved edit first and keep later
    // ones pending, so no save of the old quantities can land after the credit and erase it.
    await flush()
    hold()
    try {
      const r = await window.poe2desktop.sales.fetch(sel)
      setLastFetch({ at: Date.now(), ...r })
      if (r.ok) {
        await loadSales(sel)
        if (r.new) {
          const post = await api.capital()
          useStatus.setState(st => ({ capital: post, capitalWrites: st.capitalWrites + 1 }))
          const merged = qtyRef.current && addCredit(qtyRef.current, r.added)
          if (merged && merged !== qtyRef.current) { setQty(merged); release(); save(merged) }
          refreshHeader()
        }
        if (!auto) toast(salesToast(r))
      }
      else if (!auto) toast(r.error === 'rate' ? `Trade site rate limit — try again in ${r.retryAfter || 60}s` : r.error === 'auth' ? 'Connect your PoE session first (Settings → Accounts)' : `Fetch failed: ${r.error}`, false)
    } finally { release(); setBusy(false) }
  }
  // A 10-minute timer while mounted (= while the Stash tab is visible). Desktop only.
  useEffect(() => {
    if (!isDesktop || !sel) return
    refresh(true)
    const t = setInterval(() => { if (document.visibilityState !== 'hidden') refresh(true) }, POLL_MS)
    return () => clearInterval(t)
  }, [sel]) // eslint-disable-line
  // Topbar ⟳ = this tab's own refresh (a manual one).
  useEffect(() => { if (tick !== tick0.current) { tick0.current = tick; refresh(false) } }, [tick]) // eslint-disable-line
  const prices = sales.prices ?? status?.wealth_prices
  const stats = useMemo(() => salesStats(sales.rows, ref, prices), [sales.rows, ref, prices])
  const byName = useMemo(() => { const m = new Map(); for (const n of flatten(tree, x => x.kind === 'search')) if (n.name) m.set(n.name.toLowerCase(), n.id); return m }, [tree])
  const openRow = (r) => { setOpen(o => (o === r ? null : r)); diag('sales', 'sales-open') }

  const hit = useMemo(() => stashMatches(rows, q), [rows, q])
  if (!qty) return <div className="stash-view"><div className="hint">Loading your stash…</div></div>
  const shown = groups.filter(g => g.rows.some(r => hit.has(r)))
  const counted = groups.reduce((a, g) => a + g.counted_ref, 0)   // switched-on holdings at paper

  return (
    <div className="stash-view" ref={viewRef}>
      <div className="stash-head" ref={headRef}>
        <b>Stash</b>
        <span className="ws-chip" title="Follows the top-bar league; the sales ledger keeps every league">{sel || '—'}</span>
        {saveState && <span className="save-state">{saveState === 'saving' ? 'saving…' : 'saved ✓'}</span>}
        <div className="stash-addbar">
          <CurrencyPicker value={pick} placeholder="Add currency…" options={currencies} onChange={id => setPick(id || '')} onClear={() => setPick('')} />
          <input type="text" inputMode="decimal" value={amount} aria-label="Amount to add"
            onChange={e => setAmount(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addPicked() }} />
          <button type="button" className="btn primary small" disabled={!pick || parseAmount(amount) == null} onClick={addPicked}>Add</button>
        </div>
        <span className="spacer" />
        <label className="stash-search">
          <input ref={searchRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Find in stash" aria-label="Find in stash"
            onKeyDown={e => { if (e.key === 'Escape') { setQ(''); e.currentTarget.blur() } }} />
          <span className="cmdk-k" aria-hidden="true">/</span>
        </label>
      </div>

      <div className="stash-worth">
        <div className="stash-stat"><span className="stat-label">Net worth</span><span className="stat-val"><Wealth v={total} cur={ref} size={22} unit={pairUnit} /></span></div>
        <div className="stash-stat liquid"><span className="stat-label">Liquid net worth</span>
          <span className="stat-val">{liquid == null ? <span className="muted" title="valued once market data finishes syncing">…</span> : <Wealth v={liquid} cur={ref} size={22} unit={pairUnit} />}</span></div>
        {total > 0 && (
          <div className="stash-bar" aria-hidden="true">
            <i style={{ flexGrow: counted }} />{total - counted > 0 && <i className="off" style={{ flexGrow: total - counted }} />}
          </div>)}
      </div>

      <div className="stash-body">
        <div className="stash-groups">
          {shown.map(g => {
            const shut = folded(g)
            return (
              <section key={g.name} className={`stash-group ${shut ? 'folded' : ''} ${g.counted === false ? 'dim' : ''}`} style={{ '--grp': groupAccent(g.name) }}>
                <div className="stash-group-head">
                  <button className="stash-fold" onClick={() => toggleFold(g)} aria-expanded={!shut}>
                    <span className="stash-icon">{icons[g.name] && <Cur id={icons[g.name]} size={24} />}</span>
                    <svg className="stash-chev" viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" /></svg>
                    <span className="stash-name">{g.name}</span>
                    <span className="spacer" />
                    {total > 0 && <span className="stash-share" title="share of net worth">{(g.value_ref / total * 100).toFixed(g.value_ref / total < 0.1 ? 1 : 0)}%</span>}
                    <b className="stash-total"><Wealth v={g.value_ref} cur={ref} /></b>
                  </button>
                  <Toggle checked={g.counted} onChange={() => choose(flipGroup(g))} ariaLabel={`Count ${g.name} toward liquid net worth`} title="Count toward liquid net worth" />
                </div>
                {!shut && (
                  <div className="stash-rows">
                    {g.rows.filter(r => hit.has(r)).map(r => {
                      const worth = holdingWorth(r, { syncing })
                      const on = isCounted(r.currency, choices, dflt)
                      return (
                        <div key={r.currency} className={`stash-row ${on ? '' : 'off'}`}>
                          <span className="stash-cur"><Cur id={r.currency} text size={20} />{r.arbitrage && <span className="stash-hub" title="Arbitrage can trade from this">⬢</span>}</span>
                          <input type="number" min="0" step="1" value={r.typed} aria-label={`${r.name} held`} onChange={e => setOne(r.currency, cleanQty(e.target.value))} />
                          <span className="stash-worth-cell">
                            {worth ? <Native v={worth.amount} cur={worth.cur} vRef={worth.ref} size={14} />
                              : (syncing || r.value_ref == null) && Number(r.typed) > 0 ? <span className="muted">…</span> : null}
                          </span>
                          <Toggle size="sm" checked={on} onChange={v => choose({ [r.currency]: v })} ariaLabel={`Count ${r.name} toward liquid net worth`} title="Count toward liquid net worth" />
                          {CASH.includes(r.currency) ? <span /> : <button className="cap-x" title="Remove" aria-label={`Remove ${r.name}`} onClick={() => remove(r.currency)}>×</button>}
                        </div>)
                    })}
                  </div>)}
              </section>)
          })}
          {shown.length === 0 && <div className="empty small">Nothing in your stash matches <b>{q}</b>.</div>}
        </div>

        <aside className="stash-sales">
          <div className="stash-sales-head">
            <h2>Sales</h2>
            <span className="ws-chip" title="Sales in the last 24 h / 7 d">{stats.today} today · {stats.week} this week</span>
            <span className="spacer" />
            {lastFetch && <span className="muted sales-last">{lastFetch.ok ? `fetched ${relativeTime(new Date(lastFetch.at).toISOString())}` : lastFetch.error === 'rate' ? 'rate limited' : lastFetch.error === 'auth' ? 'no session' : 'fetch failed'}</span>}
            {isDesktop && <RefreshButton busy={busy} onClick={() => refresh(false)} title="Fetch the trade site's Merchant History now" />}
          </div>
          {stats.totals.length > 0 && (
            <div className="hint stash-sales-total">total {stats.totals.map((t, i) => (
              <span key={t.currency}>{i ? ' · ' : ''}{fmt.n(t.amount, wealthDigits(t.amount))} <Cur id={t.currency} size={14} /></span>))}</div>)}
          {sales.rows.length === 0
            ? <div className="empty small">No sales recorded for {sel || 'this league'} yet{isDesktop ? ' — press refresh with your PoE session connected.' : '.'}</div>
            : sales.rows.map(r => {
              const it = r.item || {}
              const name = it.name || it.typeLine || 'Item'
              const wsId = byName.get(String(it.name || it.typeLine || '').toLowerCase())
              const isOpen = open === r
              return (
                <div key={`${r.item_id}:${r.time}`} className={`sale-row ${rarityOf(it)} ${isOpen ? 'open' : ''}`}>
                  <button className="sale-main" onClick={() => openRow(r)} aria-expanded={isOpen}>
                    {it.icon ? <img className="sale-icon" src={it.icon} alt="" loading="lazy" /> : <span className="sale-icon" />}
                    <span className="sale-name"><span className={`sale-glyph ${rarityOf(it)}`} aria-hidden="true">◆</span>{name}{it.name && it.typeLine ? <span className="muted sale-base"> {it.typeLine}</span> : null}</span>
                    <span className="spacer" />
                    <span className="sale-price">{r.price ? <><b>{r.price.amount}</b> <Cur id={r.price.currency} size={14} /></> : <span className="muted">unpriced</span>}</span>
                    <span className="muted sale-time" title={r.time}>{relativeTime(r.time)}</span>
                  </button>
                  {wsId && <button className="ws-mini on" title="Open this search in the workspace" aria-label="Open in workspace" onClick={() => { useWorkspace.getState().setActive(wsId); nav.openTrading('workspace') }}>🔎</button>}
                  {isOpen && <div className="sale-card"><ItemCard item={it} /></div>}
                </div>)
            })}
        </aside>
      </div>
    </div>
  )
}
