import React from 'react'
import { fmt } from '../lib/api.js'
import { useSync } from '../lib/syncStore.js'
import RefreshButton from './RefreshButton.jsx'
import Toggle from './Toggle.jsx'

// The topbar sync UI, split into two pieces so the live-refresh CONTROLS can sit up top next to the
// Divine notification orb, while the passive METRICS stay on the second row:
//   <RefreshControls/> — manual ⟳ (refreshes the mounted live view) + the global auto toggle.
//   <SyncMetrics/>     — market-data freshness, live-order-book status + queue, and the connect action.
// Both read the shared sync store / status; nothing is duplicated across views (topbar is the sole home).

function feedState(ts, staleAfter, enabled = true) {
  if (!enabled) return 'off'
  if (!ts) return ''
  const age = Date.now() / 1000 - ts
  return age < staleAfter ? 'ok' : 'stale'
}

export function RefreshControls({ connected }) {
  const auto = useSync(s => s.auto)
  const setAuto = useSync(s => s.setAuto)
  const busy = useSync(s => s.busy)
  const requestRefresh = useSync(s => s.requestRefresh)
  return (
    <div className="refresh-controls">
      <RefreshButton busy={busy} onClick={requestRefresh} disabled={!connected}
        title={connected ? 'Refresh live data now' : 'Connect live data to refresh'} />
      <Toggle checked={auto} onChange={setAuto} label="auto" />
    </div>
  )
}

export function SyncMetrics({ status, bridge, connecting, onConnect, rl }) {
  const connected = !!status?.session?.connected
  const backfilling = status?.digest?.backfilling
  const digestOk = feedState(status?.digest?.last_fetch, 2 * 3600)
  const bookOk = feedState(status?.orderbook?.last_fetch, 3600, connected)
  const ob = status?.orderbook || {}
  const queue = ob.queue || 0
  const inFlight = ob.in_flight || 0
  const reqs = rl?.policies?.trade?.requests

  return (
    <div className="sync-cluster">
      {/* market-data crawl freshness (the background pipeline; 'Sync now' still lives in Settings) */}
      <span className="feed" title={status?.digest?.last_error || `last hour ${status?.digest?.last_hour ?? '–'}`}>
        <i className={`dot ${backfilling ? 'stale' : digestOk}`} />
        {backfilling ? `syncing · ${fmt.n(status.digest.behind_h, 0)}h behind`
          : status?.digest?.last_fetch ? `market ${fmt.age(Date.now() / 1000 - status.digest.last_fetch)} ago`
          : 'waiting for data'}
      </span>

      {/* live order book: status + queue, or the connect action, or the web note */}
      {connected ? (
        <span className="feed" title={status?.orderbook?.last_error || 'Live order book'}>
          <i className={`dot ${bookOk}`} />
          {inFlight ? `fetching ${inFlight}`
            : queue ? `${queue} queued`
            : ob.last_fetch ? `live ${fmt.age(Date.now() / 1000 - ob.last_fetch)} ago` : 'live: idle'}
          {(queue || inFlight || reqs) ? (
            <span className="sync-rl" title="live-fetch rate budget this run">
              {queue ? ` · queue ${queue}` : ''}{reqs ? ` · ${reqs} req` : ''}
            </span>
          ) : null}
        </span>
      ) : bridge === 'desktop' ? (
        <button className="btn primary connect-live" disabled={connecting} onClick={onConnect}
          title="Sign in to pathofexile.com and stream live order books">
          {connecting ? 'Connecting…' : 'Connect live data'}
        </button>
      ) : (
        <span className="feed muted" title="Live order books run in the desktop app">
          <i className="dot" /> live: desktop app
        </span>
      )}
    </div>
  )
}
