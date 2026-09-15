import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence, useSpring, useTransform } from 'motion/react'
import { api, fmt, surface, toast } from '../lib/api.js'
import { nav } from '../lib/nav.js'
import Cur from './Cur.jsx'
import CardDetail, { Spark, SRC_LABEL, useAssetModal, rangeLabel } from './CardDetail.jsx'
import CurrencyPicker from './CurrencyPicker.jsx'
import RefreshButton from './RefreshButton.jsx'
import Toggle from './Toggle.jsx'

const isDesktop = typeof window !== 'undefined' && !!window.poe2desktop

// The board's trend window (hours) → the nearest Hold day-horizon (Hold data is poe2scout DAILY).
const holdHorizon = (winH) => (winH <= 24 ? '1d' : winH <= 72 ? '3d' : '7d')

// A number that counts up on mount, then rolls when its value changes between polls.
// Fast, stiff spring (~0.5s) so the count-up feels snappy, not a slow loading crawl.
function AnimatedNumber({ value, format }) {
  const sv = useSpring(0, { stiffness: 210, damping: 24, restDelta: 0.01 })
  useEffect(() => { sv.set(value) }, [value, sv])
  const text = useTransform(sv, v => format(v))
  return <motion.span>{text}</motion.span>
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
        {r.hub && <span className="pt-hub" title="Hub — a central market; a lot of value routes through it">⬢</span>}
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

export default function BoardView({ status }) {
  const [data, setData] = useState(null)
  const [hold, setHold] = useState(null)             // hold leaderboard (top-3 stores of value) — feeds the pulse strip
  const [movers, setMovers] = useState(null)         // biggest movers by |% change| over the window (full universe)
  const assetModal = useAssetModal()                 // shared "zoom into any asset by name" modal (pulse-strip items)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [auto, setAuto] = useState(false)
  const [watchlist, setWatchlist] = useState(null)   // desktop-only board customization
  const [opts, setOpts] = useState([])               // all currencies (names for pickers)
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
  const addById = async (id) => {
    const m = opts.find(o => o.id === id)
    if (!m) return
    if ((watchlist || []).includes(m.id)) { toast(`${m.name} is already on the board`, false); return }
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
  // Hold leaderboard powers the pulse strip's top-3 holds + the full-universe top mover.
  // Hold data is poe2scout DAILY, so map the board's window to the nearest day-horizon.
  useEffect(() => {
    // Holds = top stores of value (divine-denominated hold score). Movers = biggest |% change|
    // over the SAME window as the board, full universe — a genuinely different ranking.
    api.hold(holdHorizon(winH), 'all', 'divine').then(setHold).catch(() => setHold(null))
    api.movers(winH, 3).then(setMovers).catch(() => setMovers(null))
  }, [winH])
  // Expand a pulse-strip item into the shared detail modal (enlarged graph + volume + change
  // over time), identical to clicking a board currency — via /api/asset (daily data).
  const openAsset = (name) => assetModal.open(name, winH)
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
  // the top-3 holds and the single biggest mover. Both come from the hold
  // leaderboard (full poe2scout currency universe), NOT the board watchlist, so
  // the top mover reflects the whole economy rather than just what's pinned here.
  const pulse = useMemo(() => {
    const holds = (hold?.assets ?? []).slice(0, 3)      // pre-sorted by hold score (store of value, vs Divine)
    const mvrs = (movers?.assets ?? []).slice(0, 3)     // pre-sorted by |% change| over the window (raw market move)
    if (!holds.length && !mvrs.length) return null
    return { holds, movers: mvrs }
  }, [hold, movers])
  // Hubs: the market's most-central currencies (top PageRank, backend `hub` flag), richest first.
  // Priced EXACTLY like the board cards — in the counterpart with the highest trade volume (the
  // derived pref_num / numFor), never the raw reference — so Mirror shows in Divine, Divine in
  // Chaos, etc. Count is user-tunable (settings hub_count → backend flags the top N).
  const hubChips = useMemo(
    () => rows.filter(r => r.hub).slice().sort((a, b) => (prices[b.id] || 0) - (prices[a.id] || 0)),
    [rows, prices])
  // Scale-to-fit the pulse strip: shrink the whole row (transform: scale) so all three groups
  // stay on ONE line as the window narrows; only once scaling would drop below the floor
  // ("squished a ton") do we let it wrap instead. Re-runs on resize and when content changes.
  const fitRef = useRef(null), stripRef = useRef(null)
  useLayoutEffect(() => {
    const outer = fitRef.current, inner = stripRef.current
    if (!outer || !inner) return
    const FLOOR = 0.72
    const fit = () => {
      inner.classList.remove('wrap'); inner.style.transform = 'none'; outer.style.height = ''
      const cw = outer.clientWidth, sw = inner.scrollWidth
      if (!cw || !sw) return
      const scale = cw / sw
      if (scale >= 1) return                              // fits at full size
      if (scale < FLOOR) { inner.classList.add('wrap'); return }  // too tight → wrap instead
      inner.style.transform = `scale(${scale})`
      outer.style.height = `${inner.offsetHeight * scale}px`
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(outer)
    return () => ro.disconnect()
  }, [data, hubChips, pulse])

  return (
    <div className="single board">
      {data && rows.length > 0 && (
        <div className="pulse-fit" ref={fitRef}>
        <div className="pulse-strip" ref={stripRef}>
          {hubChips.length > 0 && (
            <div className="pulse-group hubs">
              <span className="pulse-group-label" title="Hubs — the market's most-traded currencies; most trades route through them, so they're easy to buy and sell. Click to expand.">Hubs <span className="pulse-hub">⬢</span></span>
              {hubChips.map(r => {
                const num = numFor(r)
                const val = r.mid != null && prices[num] ? r.mid / prices[num] : null
                return (
                  <button key={r.id} className="pulse-chip clickable" title={`${r.name || nameById[r.id] || r.id} — central market · expand chart`}
                    onClick={() => setOpenId(r.id)}>
                    <Cur id={r.id} size={16} /><span className="pulse-v">{val == null ? '–' : fmt.rate(val)}</span><span className="pulse-u"><Cur id={num} size={12} /></span>
                  </button>
                )
              })}
            </div>
          )}
          {pulse?.holds.length > 0 && (
            <div className="pulse-group holds">
              <span className="pulse-group-label" title="Top stores of value vs Divine (hold score). Click to expand its chart.">Hold</span>
              {pulse.holds.map((a, i) => (
                <button key={a.id} className="pulse-chip clickable" title={`#${i + 1} to hold · ${a.name} — expand chart`}
                  onClick={() => openAsset(a.name)}>
                  <span className="pulse-rank">{i + 1}</span><Cur name={a.name} size={16} />
                  <span className={`pulse-v ${a.ret_pct >= 0 ? 'gain' : 'loss'}`}>{fmt.pct(a.ret_pct)}</span></button>
              ))}
            </div>
          )}
          {pulse?.movers.length > 0 && (
            <div className="pulse-group movers">
              <span className="pulse-group-label" title="Biggest % moves across all currencies over the window. Click to expand its chart.">Movers</span>
              {pulse.movers.map((a, i) => (
                <button key={a.id} className="pulse-chip clickable" title={`#${i + 1} biggest move across all currencies · ${a.name} — expand chart`}
                  onClick={() => openAsset(a.name)}>
                  <span className="pulse-rank">{i + 1}</span><Cur name={a.name} size={16} />
                  <span className={`pulse-v ${a.change_pct >= 0 ? 'gain' : 'loss'}`}>{fmt.pct(a.change_pct)}</span></button>
              ))}
            </div>
          )}
        </div>
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
            <RefreshButton busy={busy} onClick={refreshLive} title="Refresh live rates" />
            <Toggle checked={auto} onChange={setAuto} label="auto (60s)" />
          </>
        ) : <span className="hint">Connect live data (top bar) for real-time rates.</span>}
      </div>
      {isDesktop && watchlist && (
        <div className="board-bar" style={{ marginTop: 4 }}>
          <span className="hint">Customize your board:</span>
          <CurrencyPicker value="" placeholder="Add a currency…" onChange={addById}
            options={opts.filter(o => !watchlist.includes(o.id))} />
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
          return <CardDetail key="detail" r={openRow} num={num} factor={prices[num] ?? 1} range={rangeLabel(winH)}
            numOptions={numOptions} onNum={setNum} prices={prices} onClose={() => setOpenId(null)} />
        })()}
      </AnimatePresence>
      {/* A pulse-strip Hold/Mover item expanded into the SAME detail modal as a board currency. */}
      {assetModal.node}
    </div>
  )
}
