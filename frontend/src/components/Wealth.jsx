import React from 'react'
import { fmt } from '../lib/api.js'
import { useStatus } from '../lib/statusStore.js'
import { wealthUnit, wealthDigits, wealthText } from '../lib/wealth.js'
import Cur from './Cur.jsx'

// The one way to show an amount of wealth: `<Wealth v={amountInRef} />` renders the
// re-denominated value + its currency icon (see lib/wealth.js for the rule), with the raw
// reference amount on hover. `cur` (the currency `v` is denominated in) defaults to the app's
// reference currency; `suffix` renders after the icon (e.g. "/h", "/day"); `digits` overrides the magnitude-scaled default.
export default function Wealth({ v, cur = null, size = 14, suffix = null, digits = null, className = '' }) {
  const status = useStatus(s => s.status)
  const ref = cur || status?.reference || 'exalted'
  const w = wealthUnit(v, ref, status?.wealth_prices)
  if (!w) return <span className={`muted ${className}`}>–</span>
  return (
    <span className={`wealth ${className}`} title={wealthText(v, ref, status?.wealth_prices)}>
      {fmt.n(w.value, digits ?? wealthDigits(w.value))} <Cur id={w.unit} size={size} />{suffix}
    </span>
  )
}

// For code that needs the text form with the app's live prices (titles, tooltips).
export function useWealthText() {
  const status = useStatus(s => s.status)
  return (v, ref) => wealthText(v, ref || status?.reference || 'exalted', status?.wealth_prices)
}
