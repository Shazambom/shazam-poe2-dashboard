import React, { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence, MotionConfig } from 'motion/react'
import { THEMES, useTheme } from './lib/themeStore.js'
import { api, fmt, bus, surface } from './lib/api.js'
import { useStatus, startStatusPolling } from './lib/statusStore.js'
import { useCurrencies } from './lib/icons.js'
import { nav } from './lib/nav.js'
import { HORIZONS, useHorizon } from './lib/horizonStore.js'
import { useLiveWiring, useLiveSync } from './lib/liveWiring.js'
import VaalPingOrb from './components/VaalPingOrb.jsx'
import DivinePingOrb from './components/DivinePingOrb.jsx'
import HorizonPicker from './components/HorizonPicker.jsx'
import { SyncMetrics, RefreshControls } from './components/SyncControls.jsx'
import { useSignals, startSignalPolling } from './lib/signalStore.js'
import { notify } from './lib/notifications.js'
import Wealth from './components/Wealth.jsx'
import { liquidNetWorth } from './lib/stash.js'
import { wealthUnit } from './lib/wealth.js'
import { useAssetModal } from './components/CardDetail.jsx'
import CommandPalette from './components/CommandPalette.jsx'
import { connectBridge, connectSessionWithToast } from './lib/session.js'
import { useWorkspace, HISTORY_SYS } from './lib/workspaceStore.js'
import { addFromClipboard } from './lib/clipboardAdd.js'
import { useEe2History, clearHistoryWithUndo } from './lib/ee2History.js'
import { findWhere } from './lib/tree.js'
import { DESTS, SCREEN_COMMANDS, SUB_DESTS, SNAP, settle } from './lib/dests.js'
import { runTarget } from './lib/paletteRun.js'
import BoardView from './components/BoardView.jsx'
import StrategyView from './components/StrategyView.jsx'
import EconomyView from './components/EconomyView.jsx'
import TradingView from './components/TradingView.jsx'
import Cur from './components/Cur.jsx'
import SettingsView from './components/SettingsView.jsx'
import DownloadApp from './components/DownloadApp.jsx'
import UpdateStatus from './components/UpdateStatus.jsx'
import BrandOrb from './components/BrandOrb.jsx'
import FeedbackDialog from './components/FeedbackDialog.jsx'
import DiscordLink from './components/DiscordLink.jsx'

const TABS = ['Board', 'Strategy', 'Economy', 'Trading', 'Settings']
export default function App() {
  const [tab, setTab] = useState('Board')
  const status = useStatus(s => s.status)
  const capital = useStatus(s => s.capital)
  const settings = useStatus(s => s.settings)
  // The Stash's two figures (owner, 2026-10-03): net worth, and liquid net worth — the switched-on holdings
  // at what they would sell for; none until the market has synced.
  const liquidTop = capital?.syncing ? null : liquidNetWorth(capital?.rows, settings?.stash_counted, capital?.counted_by_default)
  const pairUnit = wealthUnit(capital?.total_ref, capital?.reference || 'exalted', status?.wealth_prices)?.unit   // one scale for both
  const rl = useStatus(s => s.rl)              // trade-API rate/queue budget — surfaced in the topbar sync cluster
  const refreshHeader = useStatus(s => s.refresh)
  const { raw: currencies } = useCurrencies()
  const [leagues, setLeagues] = useState([])
  const [toasts, setToasts] = useState([])
  const [connecting, setConnecting] = useState(false)
  const [appVersion, setAppVersion] = useState(null)
  const [cmdOpen, setCmdOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)   // "Report a problem" (desktop only)
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
    if (SNAP) return
    const id = t.id ?? `t${++toastId.current}`
    if (t.dismiss) { setToasts(x => x.filter(y => y.id !== id)); return }
    const entry = { ...t, id }
    setToasts(x => [...x.filter(y => y.id !== id).slice(-3), entry])
    // The timer pauses while the pointer is over the toast (so a banner's button can't run away)
    // and resumes on leave; a click on a plain toast dismisses it.
    let left = t.ttl ?? (t.ok === false ? 6000 : 2200), since = Date.now(), timer = null
    const remove = () => setToasts(x => x.filter(y => y !== entry))
    const arm = () => { since = Date.now(); timer = setTimeout(remove, left) }
    entry.pause = () => { clearTimeout(timer); left = Math.max(400, left - (Date.now() - since)) }
    entry.resume = arm
    entry.dismissNow = remove
    arm()
  }), [])
  // Global ⌘K / Ctrl-K opens the command palette (the fast path to anything).
  useEffect(() => {
    if (SNAP) return
    const h = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      if (e.key === 'k' || e.key === 'K') { e.preventDefault(); setCmdOpen(o => !o) }
      else if (e.key >= '1' && e.key <= '5' && TABS[e.key - 1]) { e.preventDefault(); setTab(TABS[e.key - 1]) }   // ⌘1–5 = the tabs, in order
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  // Phase 4: the market-signal inbox (Divine orb) polls in the background (signalStore); a change
  // in the fired set pings — sound, OS notification, and a banner in the toast stack whose Open
  // action lands on the SAME CardDetail the orb opens. Phase 3: poll the league-arc anchor for the
  // topbar day chip. Both re-key on league change; both degrade silently when the sidecar is idle.
  useEffect(() => (SNAP ? undefined : startSignalPolling()), [status?.league])
  const lastNew = useSignals(s => s.lastNew)
  useEffect(() => {
    if (SNAP || !lastNew?.signals?.length) return
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
  // (The hidden feedback window, `?snap=1`, gets a preload without `trade`, so the three desktop
  // hooks below no-op there by construction; it photographs, nothing else.)
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
  useEffect(() => nav.on(e => {
    if (e.type === 'goTrading') { setTab('Trading'); setTimeout(() => nav.openTrading(e.sub || 'workspace'), 0) }
  }), [])
  const ee2Present = useWorkspace(s => s.ee2Present)
  const hasHistoryRows = useWorkspace(s => !!(findWhere(s.tree, n => n.kind === 'folder' && n.sys === HISTORY_SYS)?.children || []).length)
  const customThemes = useTheme(s => s.customs)
  // The screen ⌘K opens on: the tab, and the sub-view its section reports (nav.reportSub).
  const [subs, setSubs] = useState({})
  useEffect(() => nav.on(e => { if (e.type === 'sub') setSubs(m => ({ ...m, [e.section]: e.sub })) }), [])
  const screen = (DESTS.find(d => d.section === tab && (!d.sub || d.sub === subs[tab])) || DESTS[0]).id
  const goSub = React.useCallback((section, sub) => {
    setTab(section)
    if (sub) setTimeout(() => (section === 'Trading' ? nav.openTrading(sub) : nav.openSub(section, sub)), 0)
  }, [])
  const goScreen = React.useCallback((id) => { const d = DESTS.find(x => x.id === id); if (d) goSub(d.section, d.sub) }, [goSub])
  // ⌘K actions App runs itself (SCREEN_COMMANDS entries without a control): each lands on Trading → Workspace and
  // mutates the store directly, or opens the report dialog. Absent = not available here (no clipboard bridge…).
  const appRuns = React.useMemo(() => ({
    'ws-new-search': () => { goWorkspace(); const ws = useWorkspace.getState(); ws.setActive(ws.addSearch(null, { type: 'search', slug: '', live: false }, 'New search')) },
    'ws-new-group': () => { goWorkspace(); useWorkspace.getState().addFolder(null) },
    'ws-toggle-rail': () => { goWorkspace(); const ws = useWorkspace.getState(); ws.setLayout({ collapsed: !ws.layout?.collapsed }) },
    ...(window.poe2desktop?.clipboard ? { 'ws-clipboard': () => { goWorkspace(); addFromClipboard(null) } } : {}),
    ...(window.poe2desktop?.ee2 && (ee2Present || hasHistoryRows) ? { 'ws-clear-history': () => { goWorkspace(); clearHistoryWithUndo() } } : {}),
    'ws-sort': () => { goWorkspace(); useWorkspace.getState().sortChildren(null) },
    ...(window.poe2desktop?.feedback ? { 'send-feedback': () => setFeedbackOpen(true) } : {}),
  }), [goWorkspace, ee2Present, hasHistoryRows])
  // Every screen's actions, runnable: a control action goes to its screen, then focuses or clicks the control.
  const screenCommands = React.useMemo(() => Object.fromEntries(Object.entries(SCREEN_COMMANDS).map(([id, cs]) => [id,
    cs.map(c => ({ ...c, run: appRuns[c.id] || (c.target && (() => { goScreen(id); runTarget(c.target, c.act) })) })).filter(c => c.run)])),
  [appRuns, goScreen])
  const themeCommands = React.useMemo(() => [...THEMES, ...customThemes].map(t => ({ id: `theme-${t.id}`, label: `Theme: ${t.name}`, hint: 'Appearance', run: () => useTheme.getState().apply(t.id) })), [customThemes])
  // The global time window, by the words players type for it (7d, window, range).
  const windowCommands = React.useMemo(() => HORIZONS.map(([k, h]) => ({ id: `window-${h}`, label: `Time window · ${k}`, hint: 'Picker', aka: [k, 'window', 'range', 'horizon'], run: () => useHorizon.getState().setHours(h) })), [])
  const appCommands = React.useMemo(() => [...windowCommands, ...themeCommands], [windowCommands, themeCommands])

  const setLeague = async (league) => {
    if (!league || league === status?.league) return
    try {
      await surface(useStatus.getState().saveSettings({ league }))
      await refreshHeader()
    } catch {}
  }

  const doConnect = async () => {
    setConnecting(true)
    try { await connectSessionWithToast(refreshHeader) } finally { setConnecting(false) }
  }

  // `?snap=1`: main's feedback sweep drives the screens through this; resolves after the tab and
  // sub-view are set, status has loaded, the screen's own fetches have gone quiet and two frames
  // have painted.
  useEffect(() => {
    if (!SNAP) return
    window.__arbiterSnap = async ({ section, sub }) => {
      setTab(section)
      if (sub) setTimeout(() => (section === 'Trading' ? nav.openTrading(sub) : nav.openSub(section, sub)), 0)
      await new Promise(res => { const tick = () => (useStatus.getState().status ? res() : setTimeout(tick, 50)); tick() })
      await new Promise(res => setTimeout(res, 100))   // let the view mount and fire its loads
      await settle()
      await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)))
      return true
    }
    return () => { delete window.__arbiterSnap }
  }, [])

  const ref = capital?.reference ?? 'ref'
  const league = status?.league ?? ''
  const bridge = connectBridge()   // 'desktop' | 'extension' | null

  return (
    <MotionConfig reducedMotion="user"><div className="app">
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
          <RefreshControls />
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
          {/* Nothing entered yet: the one action that fills it, where the number will be (styleguide §0.1). */}
          {capital && !capital.syncing && !capital.rows?.some(r => r.qty > 0)
            ? <button type="button" className="btn primary connect-live nudge" title="Trading › Stash" onClick={() => nav.goTrading('sales')}><Cur id="mirror" size={14} /> Add what you hold ›</button>
            : <span className="capital-pill">
              net worth <b><Wealth v={capital?.total_ref} cur={ref} unit={pairUnit} /></b> · liquid <b><Wealth v={liquidTop} cur={ref} unit={pairUnit} /></b></span>}
          {status?.oauth?.logged_in && <span className="muted oauth-user">{status.oauth.username}</span>}
          <DiscordLink />
          <UpdateStatus version={appVersion} />
          <DownloadApp />
        </div>
      </header>

      {tab === 'Board' && <BoardView key={league} status={status} />}
      {tab === 'Strategy' && <StrategyView key={league} league={league} capital={capital} status={status} currencies={currencies} />}
      {tab === 'Economy' && <EconomyView key={league} league={league} currencies={currencies} />}
      {tab === 'Trading' && <TradingView league={league} />}
      {tab === 'Settings' && <SettingsView currencies={currencies} status={status} onSaved={refreshHeader} onReportProblem={() => setFeedbackOpen(true)} />}

      <CommandPalette
        open={cmdOpen} onClose={() => setCmdOpen(false)}
        tabs={TABS} onGoTab={setTab}
        subDests={SUB_DESTS}
        onGoSub={goSub}
        leagues={leagues} onSetLeague={setLeague}
        onOpenCurrency={(it) => { if (!it.onBoard) return assetModal.open(it.label); setTab('Board'); setTimeout(() => nav.openCurrency(it.id), 0) }}
        screen={screen} screenCommands={screenCommands}
        commands={appCommands} onOpenSearch={(id) => { goWorkspace(); useWorkspace.getState().setActive(id) }}
      />

      {assetModal.node}
      <AnimatePresence>{feedbackOpen && <FeedbackDialog onClose={() => setFeedbackOpen(false)} />}</AnimatePresence>

      <div className="toasts">
        <AnimatePresence>
          {toasts.map(t => (
            <motion.div key={t.id} className={`toast ${t.ok === false ? 'error' : ''} ${t.node ? 'custom' : ''}`}
              initial={{ opacity: 0, x: 40, scale: 0.96 }} animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.96 }} transition={{ type: 'spring', stiffness: 420, damping: 30 }}
              onPointerEnter={t.pause} onPointerLeave={t.resume} onClick={t.node ? undefined : t.dismissNow}>
              {t.node ?? <><span className="toast-ic">{t.ok === false ? '⚠' : '✓'}</span>{t.text}</>}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div></MotionConfig>
  )
}
