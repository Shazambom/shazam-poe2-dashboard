import React, { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Toaster } from 'sonner'
import { api, fmt, bus, surface } from './lib/api.js'
import { nav } from './lib/nav.js'
import { useLiveWiring, useLiveSync } from './lib/liveWiring.js'
import VaalPingOrb from './components/VaalPingOrb.jsx'
import DivinePingOrb from './components/DivinePingOrb.jsx'
import HorizonPicker from './components/HorizonPicker.jsx'
import { SyncMetrics, RefreshControls } from './components/SyncControls.jsx'
import { useSignals } from './lib/signalStore.js'
import { useAssetModal } from './components/CardDetail.jsx'
import CommandPalette from './components/CommandPalette.jsx'
import { connectBridge, connectSessionWithToast } from './lib/session.js'
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
]

export default function App() {
  const [tab, setTab] = useState('Board')
  const [status, setStatus] = useState(null)
  const [capital, setCapital] = useState(null)
  const [currencies, setCurrencies] = useState(null)
  const [leagues, setLeagues] = useState([])
  const [toasts, setToasts] = useState([])
  const [connecting, setConnecting] = useState(false)
  const [appVersion, setAppVersion] = useState(null)
  const [cmdOpen, setCmdOpen] = useState(false)
  const [arcCtx, setArcCtx] = useState(null)   // league-level arc anchor for the topbar day chip
  const assetModal = useAssetModal()           // global CardDetail — signals open into it
  const toastId = useRef(0)

  const [rl, setRl] = useState(null)   // trade-API rate/queue budget — surfaced in the topbar sync cluster
  const refreshHeader = async () => {
    try {
      const [s, c] = await Promise.all([api.status(), api.capital()])
      setStatus(s); setCapital(c)
    } catch (e) { console.error(e) }
    api.rateLimits().then(setRl).catch(() => {})
  }
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    if (q.get('oauth')) { setTab('Settings'); window.history.replaceState({}, '', '/') }
    refreshHeader()
    if (window.poe2desktop?.getVersion) window.poe2desktop.getVersion().then(setAppVersion).catch(() => {})
    api.currencies().then(setCurrencies).catch(console.error)
    api.leagues().then(setLeagues).catch(() => setLeagues([]))
    const t = setInterval(refreshHeader, 30000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => bus.on(t => {
    const id = ++toastId.current
    setToasts(x => [...x.slice(-3), { id, ...t }])
    setTimeout(() => setToasts(x => x.filter(y => y.id !== id)), t.ok === false ? 6000 : 2200)
  }), [])
  // Global ⌘K / Ctrl-K opens the command palette (the fast path to anything).
  useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setCmdOpen(o => !o) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  // Phase 4: poll the market-signal inbox (Divine orb). Phase 3: poll the league-arc anchor for the
  // topbar day chip. Both re-key on league change; both degrade silently when the sidecar is idle.
  useEffect(() => {
    const refresh = () => useSignals.getState().refresh()
    refresh()
    const t = setInterval(refresh, 60000)
    return () => clearInterval(t)
  }, [status?.league])
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
  // The global focus hotkey (desktop) raises the window here; jump to Live + focus newest.
  useEffect(() => {
    if (!window.poe2desktop?.trade?.onFocusLive) return
    return window.poe2desktop.trade.onFocusLive(() => goLive())
  }, [goLive])

  const setLeague = async (league) => {
    if (!league || league === status?.league) return
    try {
      await surface(api.putSettings({ league }), `League set to ${league}`)
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
          <DivinePingOrb onOpenSignal={(s) => { setTab('Board'); assetModal.open(s.name) }} />
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
          <span className="capital-pill" title="Total value of what you hold, in the reference currency">
            capital <b>{fmt.n(capital?.total_ref, 1)}</b> <Cur id={ref} size={14} /></span>
          {status?.oauth?.logged_in && <span className="muted oauth-user">{status.oauth.username}</span>}
          <UpdateStatus version={appVersion} />
          <DownloadApp />
        </div>
      </header>

      {tab === 'Board' && <BoardView key={league} status={status} />}
      {tab === 'Strategy' && <StrategyView key={league} league={league} capital={capital} status={status} currencies={currencies} onCapitalSaved={refreshHeader} />}
      {tab === 'Economy' && <EconomyView key={league} league={league} currencies={currencies} />}
      {tab === 'Trading' && <TradingView key={league} league={league} />}
      {tab === 'Settings' && <SettingsView currencies={currencies} status={status} onSaved={refreshHeader} />}

      <CommandPalette
        open={cmdOpen} onClose={() => setCmdOpen(false)}
        tabs={TABS} onGoTab={setTab}
        subDests={SUB_DESTS}
        onGoSub={(section, sub) => { setTab(section); setTimeout(() => (section === 'Trading' ? nav.openTrading(sub) : nav.openSub(section, sub)), 0) }}
        leagues={leagues} onSetLeague={setLeague}
        onOpenCurrency={(id) => { setTab('Board'); setTimeout(() => nav.openCurrency(id), 0) }}
      />

      {assetModal.node}

      <Toaster position="top-right" theme="dark" offset={64} toastOptions={{ unstyled: false }} />

      <div className="toasts">
        <AnimatePresence>
          {toasts.map(t => (
            <motion.div key={t.id} className={`toast ${t.ok === false ? 'error' : ''}`}
              initial={{ opacity: 0, x: 40, scale: 0.96 }} animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.96 }} transition={{ type: 'spring', stiffness: 420, damping: 30 }}>
              <span className="toast-ic">{t.ok === false ? '⚠' : '✓'}</span>{t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}
