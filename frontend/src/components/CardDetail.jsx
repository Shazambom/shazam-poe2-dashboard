import React, { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { api, fmt, toast } from '../lib/api.js'
import Cur from './Cur.jsx'
import Wealth from './Wealth.jsx'
import { useCurrencies } from '../lib/icons.js'
import LeagueArcSection from './LeagueArc.jsx'
import { useSignals } from '../lib/signalStore.js'
import { useHorizon } from '../lib/horizonStore.js'
import { useStatus } from '../lib/statusStore.js'
import { factorFor, trendIn, valueIn } from '../lib/price.js'

export const SRC_LABEL = { live: 'live order book', digest: 'hourly market data', derived: 'derived via other markets', scout: 'poe2scout', none: 'no data' }
const SRC_SHORT = { live: 'LIVE', digest: 'HR', derived: '~', scout: 'SC' }
// The source badge (board tile + detail head): the short tag and its hover title, from one table.
export function srcBadge(source) {
  return { label: SRC_SHORT[source] || '–', title: SRC_LABEL[source] || 'no data' }
}

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

// The expanded detail view: bigger trend, freshness, and the value in every
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
  const mid = rp(r.mid)
  const trend = trendIn(r, num, f, prices)
  const change = r.change_pct
  const inCurs = Object.keys(prices).filter(c => c !== r.id && prices[c]).sort((a, b) => prices[b] - prices[a]).slice(0, 8)
  // Phase 4: if this item currently has a fired 'about to move' signal, explain why it fired.
  // Joined by NAME (the signal carries a numeric item_id, the row a currency id).
  const signal = useSignals(s => s.byName[r.name])
  // Ghost Wealth: if the user HOLDS this currency, show what the stack would actually cash out to.
  // Pulls the enriched capital row (realizable/ghost/slippage/fill) — no bespoke endpoint.
  // From the app's one capital fetch (statusStore), so the cash-out here, the Capital card and
  // the topbar total are always the same numbers priced at the same gold price.
  const capital = useStatus(s => s.capital)
  const cash = useMemo(() => {
    const row = capital?.rows.find(x => x.currency === r.id && Number(x.qty) > 0)
    return row ? { ...row, reference: capital.reference } : null
  }, [capital, r.id])
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [onClose])
  // Focus moves into the dialog on open and back to whatever opened it on close.
  const closeRef = useRef(null)
  useEffect(() => {
    const opener = document.activeElement
    closeRef.current?.focus()
    return () => { try { opener?.focus?.() } catch {} }
  }, [])
  return (
    <motion.div className="detail-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div className={`card-detail src-${r.source || 'none'}`} role="dialog" aria-modal="true"
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.18, ease: [0.22, 0.61, 0.36, 1] }} onClick={e => e.stopPropagation()}>
        <button ref={closeRef} className="cd-close" onClick={onClose} title="Close (Esc)">×</button>
        <div className="cd-head">
          <span className="cd-title"><Cur id={r.id} name={r.name} text size={24} /></span>
          <span className={`pt-src ${r.source}`} title={srcBadge(r.source).title}>{srcBadge(r.source).label}</span>
        </div>
        <div className="cd-price">
          {mid == null ? <span className="muted">no price</span>
            : <><b>{fmt.rate(mid)}</b><Cur id={num} size={18} /></>}
          {change != null && <span className={`pt-chg ${change >= 0 ? 'gain' : 'loss'}`}>{fmt.pct(change)}<span className="muted" style={{ fontWeight: 400, marginLeft: 4 }}>· {range}</span></span>}
        </div>
        <div className="cd-spark"><Spark points={trend} w={560} h={150} /></div>
        {signal && <>
          <div className="cd-section">⚡ Signal <span className="muted" style={{ fontWeight: 400 }}>· volume-confirmed move forming</span></div>
          <div className="cd-chips">
            <span className="arc-win signal">about to move</span>
            <span className="cd-chip" title="price at the anomaly">at {fmt.rate(rp(signal.close))} <Cur id={num} size={12} /></span>
          </div>
        </>}
        <LeagueArcSection name={r.name} num={num} />
        <div className="cd-grid">
          {r.medvol != null && <div className="cd-stat"><span>volume</span><b><Wealth v={r.medvol} cur="exalted" suffix={<span className="muted">/day</span>} /></b></div>}
          {r.age_s != null && <div className="cd-stat"><span>last traded</span><b>{fmt.age(r.age_s)} ago</b></div>}
          {r.hub && <div className="cd-stat" title="A central market — a lot of value routes through it"><span>market</span><b className="cd-hub">⬢ hub</b></div>}
        </div>
        {cash && cash.realizable_ref != null && cash.source !== 'cash' && (() => {
          const cref = cash.reference || 'exalted'
          const gh = (cash.value_ref != null) ? cash.value_ref - cash.realizable_ref : null
          return <>
            <div className="cd-section">Cash out <span className="muted" style={{ fontWeight: 400 }}>· selling all {fmt.n(cash.qty)}</span></div>
            <div className="cd-grid">
              <div className="cd-stat" title="what the whole stack would realize now, net of gold"><span>realizable</span><b><Wealth v={cash.realizable_ref} cur={cref} /></b></div>
              {gh != null && <div className="cd-stat" title="paper value you can't currently cash out"><span>ghost</span><b className={gh > 0.5 ? 'cd-ghost' : ''}>👻 <Wealth v={gh} cur={cref} /></b></div>}
              {cash.slippage_pct != null && <div className="cd-stat" title="market-depth loss on the filled portion (excludes gold)"><span>slippage</span><b>{Math.max(0, cash.slippage_pct).toFixed(1)}%</b></div>}
              {cash.fill_hours != null && <div className="cd-stat"><span>fill time</span><b>{fmt.dur(cash.fill_hours)}</b></div>}
              {cash.full_fill === false && <div className="cd-stat" title="the market can't absorb the whole stack right now"><span>fill</span><b className="cd-ghost">partial</b></div>}
            </div>
            {cash.cashout_path && cash.cashout_path.length > 1 && (
              <div className="cd-cashpath">sell via {cash.cashout_path.map((id, i) => (
                <React.Fragment key={id}>{i > 0 && <span className="cd-arrow"> › </span>}<Cur id={id} size={15} /></React.Fragment>
              ))}</div>
            )}
          </>
        })()}
        {inCurs.length > 0 && <>
          <div className="cd-section">Value in other currencies</div>
          <div className="cd-invalue">
            {inCurs.map(c => (
              <div key={c} className="cd-vrow"><Cur id={c} text size={16} /><span className="spacer" /><b>{fmt.rate(valueIn(r.id, r.mid, c, prices))}</b></div>
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
