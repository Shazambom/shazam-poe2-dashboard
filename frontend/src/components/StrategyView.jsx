import React, { useEffect, useState } from 'react'
import SubTabs from './SubTabs.jsx'
import { nav } from '../lib/nav.js'
import HoldView from './HoldView.jsx'
import RoutesView from './RoutesView.jsx'
import StratCalcView from './StratCalcView.jsx'

// "Strategy" tab: what to do with capital. Hold = long-term stores of value that beat
// inflation; Arbitrage = active exchange-loop routes (which also hosts the Convert tool);
// Strat Calculator = what a farming strategy earns, in divines per hour.
const SUBS = [
  { id: 'arbitrage', label: 'Arbitrage' },
  { id: 'hold', label: 'Hold' },
  { id: 'calc', label: 'Strat Calculator' },
]

export default function StrategyView({ league, capital, status, currencies, onCapitalSaved }) {
  const [sub, setSub] = useState('arbitrage')
  useEffect(() => nav.on(e => { if (e.type === 'openSub' && e.section === 'Strategy' && e.sub) setSub(e.sub) }), [])
  return (
    <div className="section">
      <SubTabs subs={SUBS} value={sub} onChange={setSub} layoutId="subtab-underline-strategy" />
      {sub === 'hold' && <HoldView key={league} />}
      {sub === 'arbitrage' && <RoutesView key={league} capital={capital} status={status} currencies={currencies} onCapitalSaved={onCapitalSaved} />}
      {sub === 'calc' && <StratCalcView league={league} currencies={currencies} />}
    </div>
  )
}
