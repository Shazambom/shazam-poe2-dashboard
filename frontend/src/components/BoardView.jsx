import React, { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence, useSpring, useTransform } from 'motion/react'
import { api, fmt, surface, toast } from '../lib/api.js'
import Cur from './Cur.jsx'

const isDesktop = typeof window !== 'undefined' && !!window.poe2desktop

// A number that springs to its value — counts up on mount, rolls when it changes.
// Keeps the price feeling live rather than snapping between polls.
function AnimatedNumber({ value, format }) {
  const sv = useSpring(0, { stiffness: 90, damping: 20, restDelta: 0.001 })
  useEffect(() => { sv.set(value) }, [value, sv])
  const text = useTransform(sv, v => format(v))
  return <motion.span>{text}</motion.span>
}

// A trend sparkline: single series, so no legend. Thin 2px line, faint area fill,
// emphasized endpoint, recessive baseline — per the dataviz mark specs. Colored by
// direction of the window (up = gain, down = loss), which is state, not identity.
function Spark({ points, w = 132, h = 34 }) {
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

function Tile({ r, num, factor, numOptions, onNum, onRemove, index = 0 }) {
  const change = r.change_pct
  const f = factor || 1
  const rp = (v) => (v == null ? null : v / f)               // reprice R-value into `num`
  const mid = rp(r.mid), buy = rp(r.buy), sell = rp(r.sell), spread = rp(r.spread)
  const trend = r.trend ? r.trend.map(p => ({ t: p.t, v: p.v / f })) : r.trend
  const unit = <Cur id={num} size={14} />
  // Flash the price green/red when its value actually changes (new data landing).
  const prev = useRef(mid)
  const [flash, setFlash] = useState('')
  useEffect(() => {
    if (prev.current != null && mid != null && mid !== prev.current) {
      setFlash(mid > prev.current ? 'up' : 'down')
      const t = setTimeout(() => setFlash(''), 1000)
      prev.current = mid
      return () => clearTimeout(t)
    }
    prev.current = mid
  }, [mid])
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.94 }}
      whileHover={{ y: -3 }}
      transition={{ type: 'spring', stiffness: 380, damping: 30, delay: Math.min(index * 0.035, 0.4) }}
      className={`price-tile src-${r.source || 'none'}`}
    >
      <div className="pt-head">
        <span className="pt-name"><Cur id={r.id} text /></span>
        {onRemove && <button className="pt-remove" title="Remove from board" onClick={() => onRemove(r.id)}>×</button>}
        <span className={`pt-src ${r.source}`} title={
          r.source === 'live' ? 'live order book' : r.source === 'digest' ? 'hourly market data'
            : r.source === 'derived' ? 'derived via other markets' : r.source === 'scout' ? 'poe2scout price' : 'no data'}>
          {r.source === 'live' ? 'LIVE' : r.source === 'digest' ? 'HR' : r.source === 'derived' ? '~' : r.source === 'scout' ? 'SC' : '–'}
        </span>
      </div>
      <div className="pt-mid">
        {mid == null ? <span className="muted">no price</span>
          : <span className={`pt-num ${flash}`}><AnimatedNumber value={mid} format={fmt.rate} /><span className="pt-unit">{unit}</span></span>}
        {change != null && <span className={`pt-chg ${change >= 0 ? 'gain' : 'loss'}`}>{fmt.pct(change)}</span>}
      </div>
      <Spark points={trend} />
      {/* Real bid/ask only exists with a live order book; digest gives one mid both
          ways, so showing buy/sell/spread there would be a fake spread. */}
      {r.source === 'live' ? (
        <div className="pt-foot">
          <span title="what it costs to buy one">buy <b>{buy == null ? '–' : fmt.rate(buy)}</b></span>
          <span title="what you get selling one">sell <b>{sell == null ? '–' : fmt.rate(sell)}</b></span>
          {r.spread_pct != null && (
            <span className="pt-spread" title={`spread ${fmt.rate(spread)} (${r.spread_pct.toFixed(1)}%)`}>
              <span className="spread-bar" style={{ width: `${Math.max(2, Math.min(46, r.spread_pct * 2))}px` }} />
              {r.spread_pct.toFixed(1)}%
            </span>
          )}
          {r.depth != null && <span className="muted">{r.depth} offers</span>}
        </div>
      ) : (
        <div className="pt-foot muted">hourly mid{r.age_s != null && <> · {fmt.age(r.age_s)} old</>}</div>
      )}
      {onNum && numOptions.length > 0 && (
        <div className="pt-num-row">priced in{' '}
          <select value={num} onChange={e => onNum(r.id, e.target.value)} title="Currency this card is priced in (defaults to its highest-volume market)">
            {numOptions.filter(o => o.id !== r.id).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
      )}
    </motion.div>
  )
}

export default function BoardView({ status }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [auto, setAuto] = useState(false)
  const [watchlist, setWatchlist] = useState(null)   // desktop-only board customization
  const [opts, setOpts] = useState([])               // all currencies (names for pickers)
  const [q, setQ] = useState('')
  const [numById, setNumById] = useState(() => {     // per-card numeraire overrides (persisted)
    try { return JSON.parse(localStorage.getItem('board.num.v1') || '{}') } catch { return {} }
  })
  const setNum = (id, n) => {
    const next = { ...numById, [id]: n }
    setNumById(next)
    try { localStorage.setItem('board.num.v1', JSON.stringify(next)) } catch {}
  }
  const canLive = !!status?.session?.connected
  const timer = useRef(null)

  const load = async () => {
    try { setData(await api.board()); setErr(null) } catch (e) { setErr(String(e.message || e)) }
  }

  const saveWatchlist = async (next, note) => {
    setWatchlist(next)
    try { await surface(api.putSettings({ watchlist: next }), note) ; await load() }
    catch { setWatchlist(watchlist) }   // revert on failure
  }
  const addCur = async () => {
    const term = q.trim().toLowerCase()
    if (!term) return
    const m = opts.find(o => o.name.toLowerCase() === term || o.id.toLowerCase() === term)
    if (!m) { toast('Pick a currency from the list', false); return }
    if ((watchlist || []).includes(m.id)) { toast(`${m.name} is already on the board`, false); return }
    setQ('')
    await saveWatchlist([...(watchlist || []), m.id], `Added ${m.name}`)
  }
  const removeCur = (id) => saveWatchlist((watchlist || []).filter(x => x !== id), 'Removed from board')
  const refreshLive = async () => {
    if (!canLive || busy) return
    setBusy(true)
    try { setData(await api.boardRefresh()) } catch (e) { setErr(String(e.message || e)) }
    setBusy(false)
  }
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [])
  useEffect(() => { api.currencies().then(d => setOpts(d?.currencies ?? [])).catch(() => {}) }, [])
  useEffect(() => {
    if (!isDesktop) return
    api.settings().then(s => setWatchlist(s.watchlist || [])).catch(() => {})
  }, [])
  useEffect(() => {
    if (!auto || !canLive) return
    refreshLive()
    timer.current = setInterval(refreshLive, 60000)
    return () => clearInterval(timer.current)
  }, [auto, canLive]) // eslint-disable-line

  const ref = data?.reference ?? 'ref'
  const rows = data?.rows ?? []
  const prices = data?.prices ?? {}
  const live = useMemo(() => rows.filter(r => r.source === 'live').length, [rows])
  const nameById = useMemo(() => Object.fromEntries(opts.map(o => [o.id, o.name])), [opts])
  // Currencies a card can be priced in = those with a known reference price, richest first.
  const numOptions = useMemo(() => Object.keys(prices)
    .sort((a, b) => (prices[b] || 0) - (prices[a] || 0))
    .map(id => ({ id, name: nameById[id] || id })), [prices, nameById])
  // Effective numeraire for a card: user override → backend's highest-volume default → reference.
  // Never price a currency against itself (a 1:1 is useless) — fall back to divine/ref.
  const numFor = (r) => {
    let pick = numById[r.id] || r.pref_num || ref
    if (pick === r.id) pick = (r.id !== 'divine' && prices.divine != null) ? 'divine' : ref
    return prices[pick] != null ? pick : ref
  }

  return (
    <div className="single board">
      <div className="board-bar">
        <h2 style={{ margin: 0 }}>Price board <span className="muted" style={{ fontWeight: 400 }}>· {rows.length} currencies · each priced in its top market</span></h2>
        <span className="spacer" />
        <span className="hint">{live} live · {rows.length - live} from hourly data</span>
        {canLive ? (
          <>
            <button className="btn primary" disabled={busy} onClick={refreshLive}>{busy ? 'Fetching…' : 'Refresh live'}</button>
            <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} /> auto (60s)</label>
          </>
        ) : <span className="hint">Connect live data (top bar) for real-time rates.</span>}
      </div>
      {isDesktop && watchlist && (
        <div className="board-bar" style={{ marginTop: 4 }}>
          <span className="hint">Customize your board:</span>
          <input className="btn" list="board-add-cur" placeholder="Add a currency…" value={q}
            onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addCur() }} style={{ width: 240 }} />
          <datalist id="board-add-cur">
            {opts.filter(o => !watchlist.includes(o.id)).map(o => <option key={o.id} value={o.name} />)}
          </datalist>
          <button className="btn" onClick={addCur} disabled={!q.trim()}>Add</button>
          <span className="spacer" />
          <span className="hint">{watchlist.length} on board · hover a tile’s × to remove</span>
        </div>
      )}
      {err && <div className="notice error">{err}</div>}
      {data === null && !err && (
        <div className="price-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="price-tile skeleton" style={{ animationDelay: `${i * 0.08}s` }}>
              <div className="sk sk-name" /><div className="sk sk-num" /><div className="sk sk-spark" /><div className="sk sk-foot" />
            </div>
          ))}
        </div>
      )}
      {data && rows.length === 0 && !err && <div className="empty">No watched currencies yet — add some to the watchlist in Settings.</div>}
      {data && rows.length > 0 && (
        <motion.div className="price-grid" layout>
          <AnimatePresence mode="popLayout">
            {rows.map((r, i) => {
              const num = numFor(r)
              return <Tile key={r.id} index={i} r={r} num={num} factor={prices[num] ?? 1} numOptions={numOptions}
                onNum={setNum} onRemove={isDesktop && watchlist ? removeCur : null} />
            })}
          </AnimatePresence>
        </motion.div>
      )}
    </div>
  )
}
