import React, { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { api, fmt, bus, surface } from './lib/api.js'
import { useStatus, startStatusPolling } from './lib/statusStore.js'
import { useCurrencies } from './lib/icons.js'
import { nav } from './lib/nav.js'
import { useLiveWiring, useLiveSync } from './lib/liveWiring.js'
import VaalPingOrb from './components/VaalPingOrb.jsx'
import DivinePingOrb from './components/DivinePingOrb.jsx'
import HorizonPicker from './components/HorizonPicker.jsx'
import { SyncMetrics, RefreshControls } from './components/SyncControls.jsx'
import { useSignals, startSignalPolling } from './lib/signalStore.js'
import { notify } from './lib/notifications.js'
import Wealth from './components/Wealth.jsx'
import { useAssetModal } from './components/CardDetail.jsx'
import CommandPalette from './components/CommandPalette.jsx'
import { connectBridge, connectSessionWithToast } from './lib/session.js'
import { useWorkspace, HISTORY_SYS } from './lib/workspaceStore.js'
import { addFromClipboard } from './lib/clipboardAdd.js'
import { useEe2History, clearHistoryWithUndo } from './lib/ee2History.js'
import { findWhere } from './lib/tree.js'
import BoardView from './components/BoardView.jsx'
import StrategyView from './components/StrategyView.jsx'
import EconomyView from './components/EconomyView.jsx'
import TradingView from './components/TradingView.jsx'
import Cur from './components/Cur.jsx'
import SettingsView from './components/SettingsView.jsx'
import DownloadApp from './components/DownloadApp.jsx'
import UpdateStatus from './components/UpdateStatus.jsx'
import BrandOrb from './components/BrandOrb.jsx'

const TABS = ['Board', 'Strategy', 'Economy', 'Trading', 'Settings']
// Sub-views inside the consolidated tabs, surfaced in ⌘K so they stay one keystroke away.
const SUB_DESTS = [
  { section: 'Strategy', sub: 'hold', label: 'Hold' },
  { section: 'Strategy', sub: 'arbitrage', label: 'Arbitrage' },
  { section: 'Economy', sub: 'inflation', label: 'Inflation' },
  { section: 'Economy', sub: 'market', label: 'Market' },
  { section: 'Trading', sub: 'workspace', label: 'Workspace' },
  { section: 'Trading', sub: 'live', label: 'Live' },
  { section: 'Trading', sub: 'sales', label: 'Sales' },
]

export default function App() {
  const [tab, setTab] = useState('Board')
  const status = useStatus(s => s.status)
  const capital = useStatus(s => s.capital)
  const rl = useStatus(s => s.rl)              // trade-API rate/queue budget — surfaced in the topbar sync cluster
  const refreshHeader = useStatus(s => s.refresh)
  const { raw: currencies } = useCurrencies()
  const [leagues, setLeagues] = useState([])
  const [toasts, setToasts] = useState([])
  const [connecting, setConnecting] = useState(false)
  const [appVersion, setAppVersion] = useState(null)
  const [cmdOpen, setCmdOpen] = useState(false)
  const [arcCtx, setArcCtx] = useState(null)   // league-level arc anchor for the topbar day chip
  const assetModal = useAssetModal()           // global CardDetail — signals open into it
  const toastId = useRef(0)

  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    if (q.get('oauth')) { setTab('Settings'); window.history.replaceState({}, '', '/') }
    if (window.poe2desktop?.getVersion) window.poe2desktop.getVersion().then(setAppVersion).catch(() => {})
    api.leagues().then(setLeagues).catch(() => setLeagues([]))
    return startStatusPolling()
  }, [])
  // The ONE toast stack. A toast with an `id` replaces an earlier one with the same id (the live
  // ping banner: newest ping on top); `{id, dismiss:true}` removes it; `node` renders custom content.
  useEffect(() => bus.on(t => {
    const id = t.id ?? `t${++toastId.current}`
    if (t.dismiss) { setToasts(x => x.filter(y => y.id !== id)); return }
    const entry = { ...t, id }
    setToasts(x => [...x.filter(y => y.id !== id).slice(-3), entry])
    setTimeout(() => setToasts(x => x.filter(y => y !== entry)), t.ttl ?? (t.ok === false ? 6000 : 2200))
  }), [])
  // Global ⌘K / Ctrl-K opens the command palette (the fast path to anything).
  useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setCmdOpen(o => !o) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  // Phase 4: the market-signal inbox (Divine orb) polls in the background (signalStore); a change
  // in the fired set pings — sound, OS notification, and a banner in the toast stack whose Open
  // action lands on the SAME CardDetail the orb opens. Phase 3: poll the league-arc anchor for the
  // topbar day chip. Both re-key on league change; both degrade silently when the sidecar is idle.
  useEffect(() => startSignalPolling(), [status?.league])
  const lastNew = useSignals(s => s.lastNew)
  useEffect(() => {
    if (!lastNew?.signals?.length) return
    const names = lastNew.signals.map(s => s.name)
    const title = `${names.length} new market signal${names.length === 1 ? '' : 's'}`
    const openFirst = () => assetModal.open(names[0])   // the card is app-global: open it where the user is
    notify('signals', { title, body: names.slice(0, 3).join(', '), tag: `signals-${lastNew.at}`, onOpen: openFirst, ttl: 12000, node: (
      <div className="ping-banner">
        <span className="pb-dot online" />
        <div className="pb-main">
          <div className="pb-name">◆ {title}</div>
          <div className="pb-sub muted">{names.slice(0, 3).join(' · ')}{names.length > 3 ? ` +${names.length - 3}` : ''}</div>
        </div>
        <button className="btn small primary pb-go" onClick={() => { bus.emit({ id: 'signals', dismiss: true }); openFirst() }}>Open</button>
      </div>) })
  }, [lastNew]) // eslint-disable-line
  useEffect(() => {
    let live = true
    const load = () => api.leagueArc().then(d => { if (live) setArcCtx(d) }).catch(() => {})
    load()
    const t = setInterval(load, 300000)
    return () => { live = false; clearInterval(t) }
  }, [status?.league])

  // Jump to Trading → Live (used by the ping banner, the VaalPingOrb, and the hotkey).
  const goLive = React.useCallback(() => { nav.openTrading('live'); setTab('Trading') }, [])
  useLiveWiring(goLive)
  useLiveSync(status?.league ?? '')   // keep the live engine reconciled to the DB's armed searches
  useEe2History()                     // ExiledExchange2 History: main's item intents → the workspace store
  useEffect(() => { useWorkspace.getState().setLeague(status?.league ?? '') }, [status?.league])
  // The global focus hotkey (desktop) raises the window here; jump to Live + focus newest.
  useEffect(() => {
    if (!window.poe2desktop?.trade?.onFocusLive) return
    return window.poe2desktop.trade.onFocusLive(() => goLive())
  }, [goLive])

  // ⌘K workspace commands: each lands on Trading → Workspace and mutates the store directly.
  const goWorkspace = React.useCallback(() => { setTab('Trading'); setTimeout(() => nav.openTrading('workspace'), 0) }, [])
  const ee2Present = useWorkspace(s => s.ee2Present)
  const hasHistoryRows = useWorkspace(s => !!(findWhere(s.tree, n => n.kind === 'folder' && n.sys === HISTORY_SYS)?.children || []).length)
  const wsCommands = React.useMemo(() => [
    { id: 'ws-new-search', label: 'New search', hint: 'Workspace · ⌘N', run: () => { goWorkspace(); const ws = useWorkspace.getState(); ws.setActive(ws.addSearch(null, { type: 'search', slug: '', live: false }, 'New search')) } },
    { id: 'ws-new-group', label: 'New group', hint: 'Workspace · ⌘⇧N', run: () => { goWorkspace(); useWorkspace.getState().addFolder(null) } },
    { id: 'ws-toggle-rail', label: 'Toggle searches rail', hint: 'Workspace', run: () => { goWorkspace(); const ws = useWorkspace.getState(); ws.setLayout({ collapsed: !ws.layout?.collapsed }) } },
    ...(window.poe2desktop?.clipboard ? [{ id: 'ws-clipboard', label: 'Add from clipboard', hint: 'Workspace · ⌘⇧V', run: () => { goWorkspace(); addFromClipboard(null) } }] : []),
    ...(window.poe2desktop?.ee2 && (ee2Present || hasHistoryRows) ? [{ id: 'ws-clear-history', label: 'Clear EE2 history', hint: 'Workspace', run: () => { goWorkspace(); clearHistoryWithUndo() } }] : []),
    { id: 'ws-sort', label: 'Sort searches A–Z', hint: 'Workspace · top level', run: () => { goWorkspace(); useWorkspace.getState().sortChildren(null) } },
  ], [goWorkspace, ee2Present, hasHistoryRows])

  const setLeague = async (league) => {
    if (!league || league === status?.league) return
    try {
      await surface(useStatus.getState().saveSettings({ league }), `League set to ${league}`)
      await refreshHeader()
    } catch {}
  }

  const doConnect = async () => {
    setConnecting(true)
    try { await connectSessionWithToast(refreshHeader) } finally { setConnecting(false) }
  }

  const ref = capital?.reference ?? 'ref'
  const league = status?.league ?? ''
  const bridge = connectBridge()   // 'desktop' | 'extension' | null

  return (
    <div className="app">
      <header className="topbar">
        {/* Row 1 — identity + navigation, Divine signal orb pinned to the far corner */}
        <div className="topbar-row">
          <BrandOrb onDone={refreshHeader} />
          <h1>Arbiter</h1>
          <button className="cmdk-chip" title="Command palette (⌘K)" onClick={() => setCmdOpen(true)}>
            <span className="cmdk-k">⌘K</span> Search
          </button>
          <nav className="tabs" role="tablist">
            {TABS.map(t => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                {t}
                {t === 'Trading' && <VaalPingOrb onClick={goLive} />}
                {tab === t && <motion.span className="tab-underline" layoutId="tab-underline"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
              </button>
            ))}
          </nav>
          <span className="tb-spacer" />
          <RefreshControls connected={!!status?.session?.connected} />
          <DivinePingOrb onOpenSignal={(s) => assetModal.open(s.name)} />
        </div>

        {/* Row 2 — league + app-wide horizon (left); sync/status + capital + version (right) */}
        <div className="topbar-row topbar-row-2">
          <select className="league-select" value={league} title="League — saves on select"
            onChange={e => setLeague(e.target.value)} disabled={!status}>
            {league && !leagues.some(l => l.id === league) && <option value={league}>{league}</option>}
            {leagues.map(l => <option key={l.id} value={l.id}>{l.text}</option>)}
          </select>
          {arcCtx?.day != null && (
            <span className={`arc-chip ${arcCtx.phase || ''}`}
              title={arcCtx.resembles ? `League arc · resembles ${arcCtx.resembles}` : 'Where we are on the league price arc'}>
              day {arcCtx.day}<i className="arc-phase">{arcCtx.phase}</i><span className="arc-lg">league</span>
            </span>
          )}
          <HorizonPicker />
          <span className="tb-spacer" />
          <SyncMetrics status={status} bridge={bridge} connecting={connecting} onConnect={doConnect} rl={rl} />
          <span className="capital-pill">
            capital <b><Wealth v={capital?.total_ref} cur={ref} /></b></span>
          {status?.oauth?.logged_in && <span className="muted oauth-user">{status.oauth.username}</span>}
          <UpdateStatus version={appVersion} />
          <DownloadApp />
        </div>
      </header>

      {tab === 'Board' && <BoardView key={league} status={status} />}
      {tab === 'Strategy' && <StrategyView key={league} league={league} capital={capital} status={status} currencies={currencies} onCapitalSaved={refreshHeader} />}
      {tab === 'Economy' && <EconomyView key={league} league={league} currencies={currencies} />}
      {tab === 'Trading' && <TradingView league={league} />}
      {tab === 'Settings' && <SettingsView currencies={currencies} status={status} onSaved={refreshHeader} />}

      <CommandPalette
        open={cmdOpen} onClose={() => setCmdOpen(false)}
        tabs={TABS} onGoTab={setTab}
        subDests={SUB_DESTS}
        onGoSub={(section, sub) => { setTab(section); setTimeout(() => (section === 'Trading' ? nav.openTrading(sub) : nav.openSub(section, sub)), 0) }}
        leagues={leagues} onSetLeague={setLeague}
        onOpenCurrency={(id) => { setTab('Board'); setTimeout(() => nav.openCurrency(id), 0) }}
        commands={wsCommands} onOpenSearch={(id) => { goWorkspace(); useWorkspace.getState().setActive(id) }}
      />

      {assetModal.node}

      <div className="toasts">
        <AnimatePresence>
          {toasts.map(t => (
            <motion.div key={t.id} className={`toast ${t.ok === false ? 'error' : ''} ${t.node ? 'custom' : ''}`}
              initial={{ opacity: 0, x: 40, scale: 0.96 }} animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.96 }} transition={{ type: 'spring', stiffness: 420, damping: 30 }}>
              {t.node ?? <><span className="toast-ic">{t.ok === false ? '⚠' : '✓'}</span>{t.text}</>}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}
