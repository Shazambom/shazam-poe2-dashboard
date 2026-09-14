import React, { useEffect, useRef, useState } from 'react'
import { api, fmt, bus, surface } from './lib/api.js'
import { connectBridge, connectSessionWithToast } from './lib/session.js'
import BoardView from './components/BoardView.jsx'
import HoldView from './components/HoldView.jsx'
import InflationView from './components/InflationView.jsx'
import WatchesView from './components/WatchesView.jsx'
import TradeView from './components/TradeView.jsx'
import RoutesView from './components/RoutesView.jsx'
import MarketView from './components/MarketView.jsx'
import Cur from './components/Cur.jsx'
import SettingsView from './components/SettingsView.jsx'
import DownloadApp from './components/DownloadApp.jsx'
import UpdateStatus from './components/UpdateStatus.jsx'

const TABS = ['Board', 'Hold', 'Inflation', 'Trade', 'Watches', 'Routes', 'Market', 'Settings']

function feedState(ts, staleAfter, enabled = true) {
  if (!enabled) return 'off'
  if (!ts) return ''
  const age = Date.now() / 1000 - ts
  return age < staleAfter ? 'ok' : 'stale'
}

export default function App() {
  const [tab, setTab] = useState('Board')
  const [status, setStatus] = useState(null)
  const [capital, setCapital] = useState(null)
  const [currencies, setCurrencies] = useState(null)
  const [leagues, setLeagues] = useState([])
  const [toasts, setToasts] = useState([])
  const [connecting, setConnecting] = useState(false)
  const [appVersion, setAppVersion] = useState(null)
  const toastId = useRef(0)

  const refreshHeader = async () => {
    try {
      const [s, c] = await Promise.all([api.status(), api.capital()])
      setStatus(s); setCapital(c)
    } catch (e) { console.error(e) }
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

  const digestOk = feedState(status?.digest?.last_fetch, 2 * 3600)
  const connected = !!status?.session?.connected
  const bookOk = feedState(status?.orderbook?.last_fetch, 3600, connected)
  const ref = capital?.reference ?? 'ref'
  const backfilling = status?.digest?.backfilling
  const league = status?.league ?? ''
  const bridge = connectBridge()   // 'desktop' | 'extension' | null

  return (
    <div className="app">
      <header className="topbar">
        <img className="brand-logo"
          src="https://web.poecdn.com/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvQ3VycmVuY3kvQW5udWxsT3JiIiwic2NhbGUiOjEsInJlYWxtIjoicG9lMiJ9XQ/2daba8ccca/AnnullOrb.png"
          alt="" width="24" height="24" onError={e => { e.currentTarget.style.display = 'none' }} />
        <h1>Arbiter</h1>
        {appVersion && (
          <button className="ver-chip" title="Click to check for updates"
            onClick={() => window.poe2desktop?.checkUpdate?.()}>v{appVersion}</button>
        )}
        <select className="league-select" value={league} title="League — saves on select"
          onChange={e => setLeague(e.target.value)} disabled={!status}>
          {league && !leagues.some(l => l.id === league) && <option value={league}>{league}</option>}
          {leagues.map(l => <option key={l.id} value={l.id}>{l.text}</option>)}
        </select>
        <nav className="tabs" role="tablist">
          {TABS.map(t => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>
          ))}
        </nav>
        <div className="feeds">
          <span className="feed" title={status?.digest?.last_error || `last hour ${status?.digest?.last_hour ?? '–'}`}>
            <i className={`dot ${backfilling ? 'stale' : digestOk}`} />
            {backfilling ? `syncing history · ${fmt.n(status.digest.behind_h, 0)}h behind`
              : status?.digest?.last_fetch ? `market data ${fmt.age(Date.now() / 1000 - status.digest.last_fetch)} ago` : 'waiting for market data'}
          </span>
          {connected ? (
            <span className="feed" title={status?.orderbook?.last_error || 'Live order book'}>
              <i className={`dot ${bookOk}`} />
              {status.orderbook.in_flight ? `fetching ${status.orderbook.in_flight}`
                : status.orderbook.queue ? `${status.orderbook.queue} queued`
                : status.orderbook.last_fetch ? `live ${fmt.age(Date.now() / 1000 - status.orderbook.last_fetch)} ago` : 'live: idle'}
            </span>
          ) : bridge === 'desktop' ? (
            <button className="btn primary connect-live" disabled={connecting} onClick={doConnect}
              title="Sign in to pathofexile.com and stream live order books">
              {connecting ? 'Connecting…' : 'Connect live data'}
            </button>
          ) : (
            // Web build: live order book needs the desktop app — steer there, don't
            // advertise the extension flow. (The download button is right here.)
            <span className="feed muted" title="Live order books run in the desktop app">
              <i className="dot" /> live: desktop app
            </span>
          )}
          <span className="capital-pill" title="Total value of what you hold, in the reference currency">
            capital <b>{fmt.n(capital?.total_ref, 1)}</b> <Cur id={ref} size={14} /></span>
          {status?.oauth?.logged_in && <span className="muted">{status.oauth.username}</span>}
          <UpdateStatus />
          <DownloadApp />
        </div>
      </header>

      {tab === 'Board' && <BoardView key={league} status={status} />}
      {tab === 'Hold' && <HoldView key={league} />}
      {tab === 'Inflation' && <InflationView key={league} league={league} />}
      {tab === 'Trade' && <TradeView key={league} league={league} />}
      {tab === 'Watches' && <WatchesView key={league} league={league} />}
      {tab === 'Routes' && <RoutesView key={league} capital={capital} status={status} currencies={currencies} onCapitalSaved={refreshHeader} />}
      {tab === 'Market' && <MarketView key={league} currencies={currencies} />}
      {tab === 'Settings' && <SettingsView currencies={currencies} status={status} onSaved={refreshHeader} />}

      <div className="toasts">
        {toasts.map(t => <div key={t.id} className={`toast ${t.ok === false ? 'error' : ''}`}>{t.text}</div>)}
      </div>
    </div>
  )
}
