import React, { useEffect, useState } from 'react'
import { api, fmt } from './lib/api.js'
import RoutesView from './components/RoutesView.jsx'
import MarketView from './components/MarketView.jsx'
import CapitalView from './components/CapitalView.jsx'
import RecipesView from './components/RecipesView.jsx'
import SettingsView from './components/SettingsView.jsx'

const TABS = ['Routes', 'Market', 'Capital', 'Recipes', 'Settings']

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
    const t = setInterval(refreshHeader, 30000)
    return () => clearInterval(t)
  }, [])

  const digestOk = feedState(status?.digest?.last_fetch, 2 * 3600)
  const bookOk = feedState(status?.orderbook?.last_fetch, 3600, status?.session?.connected)
  const ref = capital?.reference ?? 'ref'

  return (
    <div className="app">
      <header className="topbar">
        <h1>Exchange loops <span className="league">{status?.league ?? '…'}</span></h1>
        <nav className="tabs" role="tablist">
          {TABS.map(t => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>
          ))}
        </nav>
        <div className="feeds">
          <span className="feed" title={status?.digest?.last_error || `last hour ${status?.digest?.last_hour ?? '–'}`}>
            <i className={`dot ${digestOk}`} /> hourly digest {status?.digest?.last_fetch ? fmt.age(Date.now() / 1000 - status.digest.last_fetch) + ' ago' : 'waiting'}
          </span>
          <span className="feed" title={status?.orderbook?.last_error || ''}>
            <i className={`dot ${bookOk}`} /> live book {!status?.session?.connected ? 'no session'
              : status.orderbook.in_flight ? `fetching ${status.orderbook.in_flight}`
              : status.orderbook.queue ? `${status.orderbook.queue} queued`
              : status.orderbook.last_fetch ? fmt.age(Date.now() / 1000 - status.orderbook.last_fetch) + ' ago' : 'idle'}
          </span>
          <span className="capital-pill">capital <b>{fmt.n(capital?.total_ref, 1)}</b> {ref}</span>
          {status?.oauth?.logged_in && <span className="muted">{status.oauth.username}</span>}
        </div>
      </header>

      {tab === 'Routes' && <RoutesView capital={capital} status={status} />}
      {tab === 'Market' && <MarketView currencies={currencies} />}
      {tab === 'Capital' && <CapitalView currencies={currencies} onSaved={refreshHeader} />}
      {tab === 'Recipes' && <RecipesView currencies={currencies} />}
      {tab === 'Settings' && <SettingsView currencies={currencies} status={status} onSaved={refreshHeader} />}
    </div>
  )
}
