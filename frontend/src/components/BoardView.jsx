import React, { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence, useSpring, useTransform } from 'motion/react'
import { api, fmt, surface, toast } from '../lib/api.js'
import { nav } from '../lib/nav.js'
import Cur from './Cur.jsx'

const isDesktop = typeof window !== 'undefined' && !!window.poe2desktop

// A number that counts up on mount, then rolls when its value changes between polls.
// Fast, stiff spring (~0.5s) so the count-up feels snappy, not a slow loading crawl.
function AnimatedNumber({ value, format }) {
  const sv = useSpring(0, { stiffness: 210, damping: 24, restDelta: 0.01 })
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

function Tile({ r, num, factor, numOptions, onNum, onRemove, onOpen, index = 0 }) {
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
      layoutId={`tile-${r.id}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      whileHover={{ y: -3 }}
      transition={{ duration: 0.18, ease: [0.22, 0.61, 0.36, 1], delay: Math.min(index * 0.012, 0.07) }}
      className={`price-tile clickable src-${r.source || 'none'}`}
      onClick={() => onOpen?.(r.id)}
      role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen?.(r.id) } }}
    >
      <div className="pt-head">
        <span className="pt-name"><Cur id={r.id} text /></span>
        {onRemove && <button className="pt-remove" title="Remove from board" onClick={e => { e.stopPropagation(); onRemove(r.id) }}>×</button>}
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
        <div className="pt-num-row" onClick={e => e.stopPropagation()}>priced in{' '}
          <select value={num} onChange={e => onNum(r.id, e.target.value)} title="Currency this card is priced in (defaults to its highest-volume market)">
            {numOptions.filter(o => o.id !== r.id).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
      )}
    </motion.div>
  )
}

const SRC_LABEL = { live: 'live order book', digest: 'hourly market data', derived: 'derived via other markets', scout: 'poe2scout', none: 'no data' }

// The expanded view a card morphs into (shared layoutId with its Tile). Shows the
// bigger trend, the bid/ask breakdown, freshness, and the value expressed in every
// other major currency — the "more detail" the hover-lift promises.
function CardDetail({ r, num, factor, numOptions, onNum, prices, onClose }) {
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
      <motion.div className={`card-detail src-${r.source || 'none'}`} layoutId={`tile-${r.id}`}
        transition={{ duration: 0.2, ease: [0.22, 0.61, 0.36, 1] }} onClick={e => e.stopPropagation()}>
        <button className="cd-close" onClick={onClose} title="Close (Esc)">×</button>
        <div className="cd-head">
          <span className="cd-title"><Cur id={r.id} text size={24} /></span>
          <span className={`pt-src ${r.source}`} title={SRC_LABEL[r.source] || 'no data'}>
            {r.source === 'live' ? 'LIVE' : r.source === 'digest' ? 'HR' : r.source === 'derived' ? '~' : r.source === 'scout' ? 'SC' : '–'}
          </span>
        </div>
        <div className="cd-price">
          {mid == null ? <span className="muted">no price</span>
            : <><b>{fmt.rate(mid)}</b><Cur id={num} size={18} /></>}
          {change != null && <span className={`pt-chg ${change >= 0 ? 'gain' : 'loss'}`}>{fmt.pct(change)}</span>}
        </div>
        <div className="cd-spark"><Spark points={trend} w={560} h={150} /></div>
        <div className="cd-grid">
          {r.source === 'live' && <>
            <div className="cd-stat"><span>buy</span><b>{buy == null ? '–' : fmt.rate(buy)}</b></div>
            <div className="cd-stat"><span>sell</span><b>{sell == null ? '–' : fmt.rate(sell)}</b></div>
            {r.spread_pct != null && <div className="cd-stat"><span>spread</span><b>{r.spread_pct.toFixed(1)}%</b></div>}
            {r.depth != null && <div className="cd-stat"><span>depth</span><b>{r.depth} offers</b></div>}
          </>}
          <div className="cd-stat"><span>source</span><b>{SRC_LABEL[r.source] || 'no data'}</b></div>
          {r.age_s != null && <div className="cd-stat"><span>updated</span><b>{fmt.age(r.age_s)} ago</b></div>}
        </div>
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

export default function BoardView({ status }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [auto, setAuto] = useState(false)
  const [watchlist, setWatchlist] = useState(null)   // desktop-only board customization
  const [opts, setOpts] = useState([])               // all currencies (names for pickers)
  const [q, setQ] = useState('')
  const [winH, setWinH] = useState(24)               // trend / %-change horizon (hours)
  const [openId, setOpenId] = useState(null)         // card expanded into detail view
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
    try { setData(await api.board(winH)); setErr(null) } catch (e) { setErr(String(e.message || e)) }
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
    try { setData(await api.boardRefresh(winH)) } catch (e) { setErr(String(e.message || e)) }
    setBusy(false)
  }
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [winH]) // eslint-disable-line
  // command palette → open a currency's detail here
  useEffect(() => nav.on(e => { if (e.type === 'openCurrency') setOpenId(e.id) }), [])
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
  // Market pulse: derived at-a-glance insights that aren't on any single card —
  // the biggest mover and how broad the move is (up vs down).
  const pulse = useMemo(() => {
    const withChg = rows.filter(r => r.change_pct != null)
    if (!withChg.length) return null
    const top = withChg.reduce((a, b) => Math.abs(b.change_pct) > Math.abs(a.change_pct) ? b : a)
    const up = withChg.filter(r => r.change_pct >= 0).length
    return { top, up, down: withChg.length - up }
  }, [rows])

  return (
    <div className="single board">
      {data && rows.length > 0 && pulse && (
        <div className="pulse-strip">
          {prices.divine != null && ref !== 'divine' && (
            <div className="pulse-chip"><Cur id="divine" size={16} /><span className="pulse-v">{fmt.rate(prices.divine)}</span><span className="pulse-u"><Cur id={ref} size={12} /></span></div>
          )}
          {prices.chaos != null && ref !== 'chaos' && (
            <div className="pulse-chip"><Cur id="chaos" size={16} /><span className="pulse-v">{fmt.rate(prices.chaos)}</span><span className="pulse-u"><Cur id={ref} size={12} /></span></div>
          )}
          {pulse.top && (
            <div className="pulse-chip"><span className="pulse-label">Top mover</span><Cur id={pulse.top.id} size={16} />
              <span className={`pulse-v ${pulse.top.change_pct >= 0 ? 'gain' : 'loss'}`}>{fmt.pct(pulse.top.change_pct)}</span></div>
          )}
          <div className="pulse-chip"><span className="pulse-label">Breadth</span>
            <span className="gain">{pulse.up}▲</span><span className="loss">{pulse.down}▼</span></div>
        </div>
      )}
      <div className="board-bar">
        <h2 style={{ margin: 0 }}>Price board <span className="muted" style={{ fontWeight: 400 }}>· {rows.length} currencies · each priced in its top market</span></h2>
        <div className="seg" title="Trend & % change window">
          {[['24h', 24], ['3d', 72], ['7d', 168], ['14d', 336]].map(([label, h]) => (
            <button key={h} className={`seg-btn ${winH === h ? 'on' : ''}`} onClick={() => setWinH(h)}>{label}</button>
          ))}
        </div>
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
                onNum={setNum} onRemove={isDesktop && watchlist ? removeCur : null} onOpen={setOpenId} />
            })}
          </AnimatePresence>
        </motion.div>
      )}
      <AnimatePresence>
        {(() => {
          const openRow = rows.find(r => r.id === openId)
          if (!openRow) return null
          const num = numFor(openRow)
          return <CardDetail key="detail" r={openRow} num={num} factor={prices[num] ?? 1}
            numOptions={numOptions} onNum={setNum} prices={prices} onClose={() => setOpenId(null)} />
        })()}
      </AnimatePresence>
    </div>
  )
}
