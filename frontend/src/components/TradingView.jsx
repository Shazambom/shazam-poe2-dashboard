import React, { useEffect, useState } from 'react'
import SubTabs from './SubTabs.jsx'
import { nav } from '../lib/nav.js'
import WorkspaceView from './WorkspaceView.jsx'
import LiveView from './LiveView.jsx'

// The Trading tab: Workspace (file tree of searches + the embedded trade site) and Live
// (pings + one-click travel-to-hideout). The trade site lives INSIDE the workspace — no
// separate Browse tab.
const SUBS = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'live', label: 'Live' },
]

export default function TradingView({ league }) {
  const [sub, setSub] = useState(() => nav.consumePendingTrading() || 'workspace')
  useEffect(() => nav.on(e => {
    if (e.type === 'openTrading' && e.sub) setSub(e.sub === 'browse' || e.sub === 'watches' ? 'workspace' : e.sub)
  }), [])

  return (
    <div className="trading">
      <SubTabs subs={SUBS} value={sub} onChange={setSub} layoutId="subtab-underline-trading" />
      {/* Keep Workspace mounted (its <webview> is costly to recreate); just hide it. */}
      <div style={{ display: sub === 'workspace' ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
        <WorkspaceView league={league} />
      </div>
      {sub === 'live' && <LiveView league={league} />}
    </div>
  )
}
