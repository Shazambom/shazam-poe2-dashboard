import React, { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { nav } from '../lib/nav.js'
import InflationView from './InflationView.jsx'
import MarketView from './MarketView.jsx'

// "Economy" tab: the macro view. Inflation = cross-league price trends vs hard-currency
// anchors; Market = market cap / top markets / exchange edges.
const SUBS = [
  { id: 'inflation', label: 'Inflation' },
  { id: 'market', label: 'Market' },
]

export default function EconomyView({ league, currencies }) {
  const [sub, setSub] = useState('inflation')
  useEffect(() => nav.on(e => { if (e.type === 'openSub' && e.section === 'Economy' && e.sub) setSub(e.sub) }), [])
  return (
    <div className="section">
      <nav className="subtabs" role="tablist">
        {SUBS.map(s => (
          <button key={s.id} role="tab" aria-selected={sub === s.id} onClick={() => setSub(s.id)}>
            {s.label}
            {sub === s.id && <motion.span className="subtab-underline" layoutId="subtab-underline-economy"
              transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
          </button>
        ))}
      </nav>
      {sub === 'inflation' && <InflationView key={league} league={league} />}
      {sub === 'market' && <MarketView key={league} currencies={currencies} />}
    </div>
  )
}
