import React, { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { nav } from '../lib/nav.js'
import TradeView from './TradeView.jsx'
import WorkspaceView from './WorkspaceView.jsx'
import LiveView from './LiveView.jsx'

// Merged "Trading" tab: one home for Browse (the embedded trade site), Watches (saved
// searches / workspace), and Live (live-search pings). Declutters the top nav — the two
// old tabs (Trade, Watches) collapse into this sub-nav. Pure shell in PR1; later PRs
// swap Watches -> workspace tree and light up Live.
const SUBS = [
  { id: 'browse', label: 'Browse' },
  { id: 'watches', label: 'Workspace' },
  { id: 'live', label: 'Live' },
]

const isDesktop = typeof window !== 'undefined' && !!window.poe2desktop

export default function TradingView({ league }) {
  // Default to Watches on web (Browse is a desktop-only embedded site), Browse on desktop.
  const [sub, setSub] = useState(isDesktop ? 'browse' : 'watches')

  // Command palette / hotkey / orb-click can drive the sub-nav.
  useEffect(() => nav.on(e => {
    if (e.type === 'openTrading' && e.sub) setSub(e.sub)
    if (e.type === 'focusLive') setSub('live')
  }), [])

  return (
    <div className="trading">
      <nav className="subtabs" role="tablist">
        {SUBS.map(s => (
          <button key={s.id} role="tab" aria-selected={sub === s.id} onClick={() => setSub(s.id)}>
            {s.label}
            {sub === s.id && <motion.span className="subtab-underline" layoutId="subtab-underline"
              transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
          </button>
        ))}
      </nav>

      {sub === 'browse' && <TradeView key={league} league={league} />}
      {sub === 'watches' && <WorkspaceView league={league} />}
      {sub === 'live' && <LiveView league={league} />}
    </div>
  )
}
