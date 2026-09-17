import React, { useEffect, useMemo, useState } from 'react'
import { api, toast } from '../lib/api.js'
import { useStatus } from '../lib/statusStore.js'
import { useWorkspace } from '../lib/workspaceStore.js'
import { flatten } from '../lib/tree.js'
import { salesStats, relativeTime, rarityOf } from '../lib/sales.js'
import { diag } from '../lib/diag.js'
import { hasTradeEngine as isDesktop } from '../lib/session.js'
import { nav } from '../lib/nav.js'
import ItemCard from './ItemCard.jsx'
import Wealth from './Wealth.jsx'
import Cur from './Cur.jsx'
import RefreshButton from './RefreshButton.jsx'
import CapitalCard from './CapitalCard.jsx'
import { useCurrencies } from '../lib/icons.js'

const POLL_MS = 10 * 60 * 1000
// Last fetch per league, kept across tab switches: re-opening the tab must NOT spend another request
// (the history endpoint penalises for ~1 h and the budget is shared by every machine on the account).
const lastFetchAt = new Map()

// Trading → Sales: the trade site's Merchant History in Arbiter's UI (roadmap batch 6). Main fetches
// through the user's own session under the shared rate budget and the backend keeps the ledger forever;
// this view only reads /api/sales and asks for a refresh (manual, or every 10 min while it is mounted —
// TradingView mounts it only while the Sales sub-tab is selected).
export default function SalesView({ league }) {
  const status = useStatus(s => s.status)
  const refreshHeader = useStatus(s => s.refresh)
  const { raw: currencies } = useCurrencies()
  const tree = useWorkspace(s => s.tree)
  const [capKey, setCapKey] = useState(0)   // remount the capital card after a fetch credited new sales
  const sel = league || ''   // the app's top-bar league — the ledger keeps every league, this shows the current one
  const [data, setData] = useState({ rows: [], leagues: [] })
  const [open, setOpen] = useState(null)
  const [busy, setBusy] = useState(false)
  const [lastFetch, setLastFetch] = useState(null)
  const load = (lg) => api.sales(lg).then(setData).catch(() => {})
  useEffect(() => { if (sel) load(sel) }, [sel])

  const refresh = async (auto = false) => {
    if (!isDesktop || !sel || busy) return
    if (auto && Date.now() - (lastFetchAt.get(sel) || 0) < POLL_MS) return   // too soon — serve the ledger
    lastFetchAt.set(sel, Date.now())
    setBusy(true)
    try {
      const r = await window.poe2desktop.sales.fetch(sel)
      setLastFetch({ at: Date.now(), ...r })
      if (r.ok) {
        await load(sel)
        if (r.new) { refreshHeader(); setCapKey(k => k + 1) }   // new sales were credited to the holdings
        if (!auto) toast(r.new ? `${r.new} new sale${r.new === 1 ? '' : 's'} · added to your holdings` : 'Up to date')
      }
      else if (!auto) toast(r.error === 'rate' ? `Trade site rate limit — try again in ${r.retryAfter || 60}s` : r.error === 'auth' ? 'Connect your PoE session first (Settings → Accounts)' : `Fetch failed: ${r.error}`, false)
    } finally { setBusy(false) }
  }
  // Manual refresh + a 10-minute timer while mounted (= while the Sales tab is visible). Desktop only.
  useEffect(() => {
    if (!isDesktop || !sel) return
    refresh(true)
    const t = setInterval(() => { if (document.visibilityState !== 'hidden') refresh(true) }, POLL_MS)
    return () => clearInterval(t)
  }, [sel]) // eslint-disable-line

  const ref = status?.reference || 'exalted'
  const stats = useMemo(() => salesStats(data.rows, ref, status?.wealth_prices), [data.rows, ref, status?.wealth_prices])
  const byName = useMemo(() => { const m = new Map(); for (const n of flatten(tree, x => x.kind === 'search')) if (n.name) m.set(n.name.toLowerCase(), n.id); return m }, [tree])
  const openRow = (r) => { setOpen(o => (o === r ? null : r)); diag('sales', 'sales-open') }

  return (
    <div className="sales-view">
      <div className="sales-head">
        <b>Sales</b>
        <span className="ws-chip" title="Follows the top-bar league; the ledger keeps every league">{sel || '—'}</span>
        <span className="ws-chip" title="Sales in the last 24 h / 7 d">{stats.today} today · {stats.week} this week</span>
        <span className="ws-chip" title={stats.unpriced ? `${stats.unpriced} sale${stats.unpriced === 1 ? '' : 's'} in a currency with no known price` : 'Total of every priced sale, in the reference currency'}>total <Wealth v={stats.totalRef} /></span>
        <span className="spacer" />
        {lastFetch && <span className="muted sales-last">{lastFetch.ok ? `fetched ${relativeTime(new Date(lastFetch.at).toISOString())}` : lastFetch.error === 'rate' ? 'rate limited' : lastFetch.error === 'auth' ? 'no session' : 'fetch failed'}</span>}
        {isDesktop ? <RefreshButton busy={busy} onClick={() => refresh(false)} title="Fetch the trade site's Merchant History now" /> : <span className="muted" style={{ fontSize: 12 }}>Fetching runs in the desktop app</span>}
      </div>
      <div className="sales-body">
      {/* The same holdings editor as the Arbitrage rail — new sales are credited here automatically. */}
      <div className="sales-capital"><CapitalCard key={capKey} currencies={currencies} status={status} onSaved={() => refreshHeader()} /></div>
      {data.rows.length === 0
        ? <div className="empty small">No sales recorded for {sel || 'this league'} yet{isDesktop ? ' — press refresh with your PoE session connected.' : '.'}</div>
        : (
          <div className="sales-list">
            {data.rows.map(r => {
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
          </div>)}
      </div>
    </div>
  )
}
