import React from 'react'
import { fmt } from '../lib/api.js'
import { useSync } from '../lib/syncStore.js'
import RefreshButton from './RefreshButton.jsx'

// The topbar sync UI, split into two pieces so the live-refresh CONTROLS can sit up top next to the
// Divine notification orb, while the passive METRICS stay on the second row:
//   <RefreshControls/> — the manual ⟳ (reloads the mounted view).
//   <SyncMetrics/>     — market-data freshness and the connect action.
// Both read the shared sync store / status; nothing is duplicated across views (topbar is the sole home).

export function RefreshControls() {
  const busy = useSync(s => s.busy)
  const requestRefresh = useSync(s => s.requestRefresh)
  return (
    <div className="refresh-controls">
      <RefreshButton busy={busy} onClick={requestRefresh} title="Refresh" />
    </div>
  )
}

export function SyncMetrics({ status, bridge, connecting, onConnect, rl }) {
  const connected = !!status?.session?.connected
  const backfilling = status?.digest?.backfilling
  // Feed freshness comes from the backend as a state string (it owns the thresholds).
  const digestOk = status?.digest?.state === 'waiting' ? '' : (status?.digest?.state || '')

  return (
    <div className="sync-cluster">
      {/* market-data crawl freshness (the background pipeline; 'Sync now' still lives in Settings) */}
      <span className="feed" title={status?.digest?.last_error || `last hour ${status?.digest?.last_hour ?? '–'}`}>
        <i className={`dot ${backfilling ? 'stale' : digestOk}`} />
        {backfilling ? `syncing · ${fmt.n(status.digest.behind_h, 0)}h behind`
          : status?.digest?.last_fetch ? `market ${fmt.age(Date.now() / 1000 - status.digest.last_fetch)} ago`
          : 'waiting for data'}
      </span>

      {/* The trade-site session powers live searches and the sales ledger (prices come from the
          hourly Currency Exchange data only — see docs/market-data-sources.md). */}
      {!connected && bridge === 'desktop' && (
        <button className="btn primary connect-live" disabled={connecting} onClick={onConnect}
          title="Sign in to pathofexile.com for live searches and the sales ledger">
          {connecting ? 'Connecting…' : 'Connect'}
        </button>
      )}
    </div>
  )
}
