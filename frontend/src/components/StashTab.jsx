import React, { useEffect, useState } from 'react'
import SubTabs from './SubTabs.jsx'
import { subsOf } from '../lib/dests.js'
import { nav } from '../lib/nav.js'
import StashView from './StashView.jsx'
import RoutesView from './RoutesView.jsx'
import StratCalcView from './StratCalcView.jsx'

// The Stash tab (owner, 2026-10-08; was "Strategy"): what you hold, then what to do with it. Stash = holdings and
// sales; Arbitrage = exchange-loop routes (and the Convert tool); Strat Calculator = what a farming strategy earns,
// in divines per hour. Hold moved to Economy the same day.
const SUBS = subsOf('Stash')

export default function StashTab({ league, capital, status, currencies }) {
  const [sub, setSub] = useState('stash')
  useEffect(() => nav.on(e => { if (e.type === 'openSub' && e.section === 'Stash' && e.sub) setSub(e.sub) }), [])
  useEffect(() => nav.reportSub('Stash', sub), [sub])
  return (
    <div className="section">
      <SubTabs subs={SUBS} value={sub} onChange={setSub} layoutId="subtab-underline-stash" />
      {sub === 'stash' && <StashView league={league} />}
      {sub === 'arbitrage' && <RoutesView key={league} capital={capital} status={status} currencies={currencies} />}
      {sub === 'calc' && <StratCalcView league={league} currencies={currencies} />}
    </div>
  )
}
