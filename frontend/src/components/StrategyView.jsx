import React, { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { nav } from '../lib/nav.js'
import HoldView from './HoldView.jsx'
import RoutesView from './RoutesView.jsx'

// "Strategy" tab: what to do with capital. Hold = long-term stores of value that beat
// inflation; Arbitrage = active exchange-loop routes (which also hosts the Convert tool).
const SUBS = [
  { id: 'arbitrage', label: 'Arbitrage' },
  { id: 'hold', label: 'Hold' },
]

export default function StrategyView({ league, capital, status, currencies, onCapitalSaved }) {
  const [sub, setSub] = useState('arbitrage')
  useEffect(() => nav.on(e => { if (e.type === 'openSub' && e.section === 'Strategy' && e.sub) setSub(e.sub) }), [])
  return (
    <div className="section">
      <nav className="subtabs" role="tablist">
        {SUBS.map(s => (
          <button key={s.id} role="tab" aria-selected={sub === s.id} onClick={() => setSub(s.id)}>
            {s.label}
            {sub === s.id && <motion.span className="subtab-underline" layoutId="subtab-underline-strategy"
              transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
          </button>
        ))}
      </nav>
      {sub === 'hold' && <HoldView key={league} />}
      {sub === 'arbitrage' && <RoutesView key={league} capital={capital} status={status} currencies={currencies} onCapitalSaved={onCapitalSaved} />}
    </div>
  )
}
