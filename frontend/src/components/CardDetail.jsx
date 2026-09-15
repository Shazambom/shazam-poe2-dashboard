import React, { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { api, fmt, toast } from '../lib/api.js'
import Cur from './Cur.jsx'

export const SRC_LABEL = { live: 'live order book', digest: 'hourly market data', derived: 'derived via other markets', scout: 'poe2scout', none: 'no data' }

// Canonical hours → range label (matches the board/hold horizon pickers).
export function rangeLabel(hours) {
  return { 24: '24h', 72: '3d', 168: '7d', 336: '14d' }[hours] || `${Math.max(1, Math.round((hours || 24) / 24))}d`
}

// A trend sparkline: single series, so no legend. Thin 2px line, faint area fill,
// emphasized endpoint, recessive baseline — per the dataviz mark specs. Colored by
// direction of the window (up = gain, down = loss), which is state, not identity.
export function Spark({ points, w = 132, h = 34 }) {
  if (!points || points.length < 2) return <div className="spark empty" style={{ width: w, height: h }} />
  const xs = points.map(p => p.t), ys = points.map(p => p.v)
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
  const pad = 3
  const sx = t => pad + (x1 === x0 ? 0 : (t - x0) / (x1 - x0)) * (w - 2 * pad)
  const sy = v => (h - pad) - (y1 === y0 ? 0.5 : (v - y0) / (y1 - y0)) * (h - 2 * pad)
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' ')
  const area = `${line} L${sx(x1).toFixed(1)},${h - pad} L${sx(x0).toFixed(1)},${h - pad} Z`
  const up = ys[ys.length - 1] >= ys[0]
  const col = up ? 'var(--gain)' : 'var(--loss)'
  const ex = sx(x1), ey = sy(ys[ys.length - 1])
  const gid = `sg-${up ? 'u' : 'd'}`
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" preserveAspectRatio="none" style={{ width: '100%' }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity="0.28" />
          <stop offset="100%" stopColor={col} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={col} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={ex} cy={ey} r="3" fill={col} />
      <circle cx={ex} cy={ey} r="5.5" fill={col} opacity="0.25" />
    </svg>
  )
}

// The expanded detail view: bigger trend, bid/ask breakdown, freshness, and the value in every
// other major currency — the "more detail" the hover-lift promises. It enters as a centered
// scale/fade zoom — deliberately NOT a Framer Motion shared-`layoutId` morph.
// The old tile→card morph occasionally measured the origin tile at a near-zero/off rect and
// overshot to fill the whole screen for a frame ("blowup"). A self-contained enter/exit has
// no shared-layout math, so that class of glitch can't happen.
export default function CardDetail({ r, num, factor, numOptions, onNum, prices, onClose, range }) {
  // Contract: a detail view must state the time range its graph + % cover. Callers pass a
  // label ("3d"/"24h"/…) or the literal "all" to opt into the whole-league view on purpose.
  // Missing range is a bug (an ambiguous, unlabeled graph) — fail loud rather than mislead.
  if (range == null) throw new Error('CardDetail requires a `range` prop — a time-range label (e.g. "3d") or "all"')
  const f = factor || 1
  const rp = (v) => (v == null ? null : v / f)
  const mid = rp(r.mid), buy = rp(r.buy), sell = rp(r.sell)
  const trend = r.trend ? r.trend.map(p => ({ t: p.t, v: p.v / f })) : r.trend
  const change = r.change_pct
  const inCurs = Object.keys(prices).filter(c => c !== r.id && prices[c]).sort((a, b) => prices[b] - prices[a]).slice(0, 8)
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <motion.div className="detail-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div className={`card-detail src-${r.source || 'none'}`}
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.18, ease: [0.22, 0.61, 0.36, 1] }} onClick={e => e.stopPropagation()}>
        <button className="cd-close" onClick={onClose} title="Close (Esc)">×</button>
        <div className="cd-head">
          <span className="cd-title"><Cur id={r.id} name={r.name} text size={24} /></span>
          <span className={`pt-src ${r.source}`} title={SRC_LABEL[r.source] || 'no data'}>
            {r.source === 'live' ? 'LIVE' : r.source === 'digest' ? 'HR' : r.source === 'derived' ? '~' : r.source === 'scout' ? 'SC' : '–'}
          </span>
        </div>
        <div className="cd-price">
          {mid == null ? <span className="muted">no price</span>
            : <><b>{fmt.rate(mid)}</b><Cur id={num} size={18} /></>}
          {change != null && <span className={`pt-chg ${change >= 0 ? 'gain' : 'loss'}`}>{fmt.pct(change)}<span className="muted" style={{ fontWeight: 400, marginLeft: 4 }}>· {range}</span></span>}
        </div>
        <div className="cd-spark"><Spark points={trend} w={560} h={150} /></div>
        <div className="cd-grid">
          {r.source === 'live' && <>
            <div className="cd-stat"><span>buy</span><b>{buy == null ? '–' : fmt.rate(buy)}</b></div>
            <div className="cd-stat"><span>sell</span><b>{sell == null ? '–' : fmt.rate(sell)}</b></div>
            {r.spread_pct != null && <div className="cd-stat"><span>spread</span><b>{r.spread_pct.toFixed(1)}%</b></div>}
            {r.depth != null && <div className="cd-stat"><span>depth</span><b>{r.depth} offers</b></div>}
          </>}
          {r.medvol != null && <div className="cd-stat"><span>volume</span><b>{Math.round(r.medvol).toLocaleString()}<span className="muted"> ex/day</span></b></div>}
          <div className="cd-stat"><span>source</span><b>{SRC_LABEL[r.source] || 'no data'}</b></div>
          {r.age_s != null && <div className="cd-stat"><span>updated</span><b>{fmt.age(r.age_s)} ago</b></div>}
          {r.hub && <div className="cd-stat" title="A central market — a lot of value routes through it"><span>market</span><b className="cd-hub">⬢ hub</b></div>}
        </div>
        {r.hub && <div className="cd-hub-note"><span className="cd-hub">⬢</span> A hub is one of the market's most-traded currencies — most trades route through it, so it's easy to buy and sell.</div>}
        {inCurs.length > 0 && <>
          <div className="cd-section">Value in other currencies</div>
          <div className="cd-invalue">
            {inCurs.map(c => (
              <div key={c} className="cd-vrow"><Cur id={c} text size={16} /><span className="spacer" /><b>{fmt.rate(r.mid / prices[c])}</b></div>
            ))}
          </div>
        </>}
        {numOptions.length > 0 && (
          <div className="pt-num-row cd-num">priced in{' '}
            <select value={num} onChange={e => onNum(r.id, e.target.value)}>
              {numOptions.filter(o => o.id !== r.id).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}

// Reusable "zoom into any asset by name" modal — the SAME card→detail morph the Board uses,
// backed by /api/asset (poe2scout daily data). Any leaderboard (Board pulse strip, Hold,
// Movers) calls `open(name, winH)` to expand a currency; drop `node` into the tree once.
// Keeps every list's click-to-zoom identical instead of each view reinventing a modal.
export function useAssetModal() {
  const [detail, setDetail] = useState(null)
  const [num, setNum] = useState(null)              // numeraire override inside the modal (not persisted)
  const [winH, setWinH] = useState(24)              // the window this detail was opened for (for the range label)
  const [nameById, setNameById] = useState({})
  useEffect(() => {
    api.currencies().then(d => setNameById(Object.fromEntries((d?.currencies ?? []).map(o => [o.id, o.name])))).catch(() => {})
  }, [])
  const open = async (name, w = 24) => {
    try { setWinH(w); setDetail(await api.asset(name, w)); setNum(null) }
    catch { toast('No price history for that item yet', false) }
  }
  const node = (
    <AnimatePresence>
      {detail && (() => {
        const r = detail.row
        const ap = detail.prices || {}
        const n = (num && ap[num] != null) ? num : (ap.divine != null ? 'divine' : (detail.reference || 'exalted'))
        const numOpts = Object.keys(ap).filter(id => id !== r.id).sort((a, b) => (ap[b] || 0) - (ap[a] || 0)).map(id => ({ id, name: nameById[id] || id }))
        const close = () => { setDetail(null); setNum(null) }
        return <CardDetail key="asset" r={r} num={n} factor={ap[n] ?? 1} range={rangeLabel(winH)} numOptions={numOpts} onNum={(id, nn) => setNum(nn)} prices={ap} onClose={close} />
      })()}
    </AnimatePresence>
  )
  return { open, node }
}
