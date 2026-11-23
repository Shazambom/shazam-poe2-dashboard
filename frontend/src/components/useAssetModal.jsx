import { useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { api, toast } from '../lib/api.js'
import { useCurrencies } from '../lib/icons.js'
import { rangeLabel, useHorizon } from '../lib/horizonStore.js'
import { factorFor } from '../lib/price.js'
import CardDetail from './CardDetail.jsx'

// Reusable "zoom into any asset by name" modal — the SAME card→detail morph the Board uses,
// backed by /api/asset (the hourly exchange card; poe2scout dailies for what the exchange doesn't trade). Any leaderboard (Board pulse strip, Hold,
// Movers) calls `open(name, winH)` to expand a currency; drop `node` into the tree once.
// Keeps every list's click-to-zoom identical instead of each view reinventing a modal.
export function useAssetModal() {
  const [detail, setDetail] = useState(null)
  const [num, setNum] = useState(null)              // numeraire override inside the modal (not persisted)
  const [winH, setWinH] = useState(24)              // the window this detail was opened for (for the range label)
  const { nameOf } = useCurrencies()
  // `inNum`: the numeraire the caller's list measured in (Hold's score, Movers' % in the league
  // base), so the modal's % is the number the user just clicked.
  const open = async (name, inNum = null) => {
    const w = useHorizon.getState().hours   // the app-wide horizon at open time
    try { setWinH(w); setDetail(await api.asset(name, w, inNum)); setNum(inNum) }
    catch { toast('No price history for that item yet', false) }
  }
  // A different numeraire is a different series (the line re-expressed in THAT currency),
  // so the modal refetches rather than rescaling the line by today's rate.
  const reqRef = useRef(0)
  const repriceTo = async (nn) => {
    const id = ++reqRef.current, was = num
    setNum(nn)
    try {
      const next = await api.asset(detail.row.name, winH, nn)
      if (id === reqRef.current) setDetail(next)       // a later pick already landed: drop this one
    } catch { if (id === reqRef.current) setNum(was) }  // the number stays with the series it has
  }
  const node = (
    <AnimatePresence>
      {detail && (() => {
        const r = detail.row
        const ap = detail.prices || {}
        const n = (num && ap[num] != null) ? num : (r.pref_num && ap[r.pref_num] != null ? r.pref_num : (detail.reference || 'exalted'))
        const numOpts = Object.keys(ap).filter(id => id !== r.id).sort((a, b) => (ap[b] || 0) - (ap[a] || 0)).map(id => ({ id, name: nameOf(id) }))
        const close = () => { setDetail(null); setNum(null) }
        return <CardDetail key="asset" r={r} num={n} factor={factorFor(r, n, ap)} range={rangeLabel(winH)} numOptions={numOpts} onNum={(id, nn) => repriceTo(nn)} prices={ap} onClose={close} />
      })()}
    </AnimatePresence>
  )
  return { open, node }
}
