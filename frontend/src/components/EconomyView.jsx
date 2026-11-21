import React, { Suspense, lazy, useEffect, useState } from 'react'
import SubTabs from './SubTabs.jsx'
import { subsOf } from '../lib/dests.js'
import { nav } from '../lib/nav.js'
import HoldView from './HoldView.jsx'

const InflationView = lazy(() => import('./InflationView.jsx'))
const MoversView = lazy(() => import('./MoversView.jsx'))
const MarketView = lazy(() => import('./MarketView.jsx'))

// "Economy" tab (owner's order, 2026-10-08): Hold = stores of value that beat inflation; Inflation = cross-league
// price trends vs hard-currency anchors; Top movers = the biggest upward swings; Market = top markets / exchange edges.
const SUBS = subsOf('Economy')

export default function EconomyView({ league, currencies }) {
  const [sub, setSub] = useState('hold')
  useEffect(() => nav.on(e => { if (e.type === 'openSub' && e.section === 'Economy' && e.sub) setSub(e.sub) }), [])
  useEffect(() => nav.reportSub('Economy', sub), [sub])
  return (
    <div className="section">
      <SubTabs subs={SUBS} value={sub} onChange={setSub} layoutId="subtab-underline-economy" />
      <Suspense fallback={null}>
        {sub === 'hold' && <HoldView key={league} />}
        {sub === 'inflation' && <InflationView key={league} league={league} />}
        {sub === 'movers' && <MoversView key={league} />}
        {sub === 'market' && <MarketView key={league} currencies={currencies} />}
      </Suspense>
    </div>
  )
}
