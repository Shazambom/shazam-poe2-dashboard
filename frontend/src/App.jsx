import React, { useEffect, useRef, useState } from 'react'
import { api, fmt, bus, surface } from './lib/api.js'
import RoutesView from './components/RoutesView.jsx'
import MarketView from './components/MarketView.jsx'
import SettingsView from './components/SettingsView.jsx'

const TABS = ['Routes', 'Market', 'Settings']

function feedState(ts, staleAfter, enabled = true) {
  if (!enabled) return 'off'
  if (!ts) return ''
  const age = Date.now() / 1000 - ts
  return age < staleAfter ? 'ok' : 'stale'
}

export default function App() {
  const [tab, setTab] = useState('Routes')
  const [status, setStatus] = useState(null)
  const [capital, setCapital] = useState(null)
  const [currencies, setCurrencies] = useState(null)
  const [leagues, setLeagues] = useState([])
  const [toasts, setToasts] = useState([])
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

  const digestOk = feedState(status?.digest?.last_fetch, 2 * 3600)
  const bookOk = feedState(status?.orderbook?.last_fetch, 3600, status?.session?.connected)
  const ref = capital?.reference ?? 'ref'
  const backfilling = status?.digest?.backfilling
  const league = status?.league ?? ''

  return (
    <div className="app">
      <header className="topbar">
        <h1>Exchange loops</h1>
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
          <button className="feed as-btn" title={status?.orderbook?.last_error || 'Live order book — click to manage the trade session'}
            onClick={() => setTab('Settings')}>
            <i className={`dot ${bookOk}`} />
            {!status?.session?.connected ? 'live book: connect'
              : status.orderbook.in_flight ? `fetching ${status.orderbook.in_flight}`
              : status.orderbook.queue ? `${status.orderbook.queue} queued`
              : status.orderbook.last_fetch ? `live ${fmt.age(Date.now() / 1000 - status.orderbook.last_fetch)} ago` : 'live: idle'}
          </button>
          <span className="capital-pill" title="Total value of what you hold, in the reference currency">
            capital <b>{fmt.n(capital?.total_ref, 1)}</b> {ref}</span>
          {status?.oauth?.logged_in && <span className="muted">{status.oauth.username}</span>}
        </div>
      </header>

      {tab === 'Routes' && <RoutesView key={league} capital={capital} status={status} currencies={currencies} onCapitalSaved={refreshHeader} />}
      {tab === 'Market' && <MarketView key={league} currencies={currencies} />}
      {tab === 'Settings' && <SettingsView currencies={currencies} status={status} onSaved={refreshHeader} />}

      <div className="toasts">
        {toasts.map(t => <div key={t.id} className={`toast ${t.ok === false ? 'error' : ''}`}>{t.text}</div>)}
      </div>
    </div>
  )
}
