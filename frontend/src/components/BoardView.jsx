import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { api, fmt, surface, toast } from '../lib/api.js'
import { nav } from '../lib/nav.js'
import { isDesktop } from '../lib/session.js'
import Cur from './Cur.jsx'
import CardDetail, { Spark, srcBadge, useAssetModal, rangeLabel } from './CardDetail.jsx'
import { useCurrencies } from '../lib/icons.js'
import { useStatus, ensureSettings } from '../lib/statusStore.js'
import CurrencyPicker from './CurrencyPicker.jsx'
import { useHorizon } from '../lib/horizonStore.js'
import { useSync } from '../lib/syncStore.js'
import { factorFor, trendIn, valueIn } from '../lib/price.js'
import AnimatedNumber from '../lib/animatedNumber.js'


function Tile({ r, num, factor, prices, numOptions, onNum, onRemove, onOpen, index = 0 }) {
  const change = r.change_pct
  const f = factor || 1
  const rp = (v) => (v == null ? null : v / f)               // reprice R-value into `num`
  const mid = rp(r.mid)
  const trend = trendIn(r, num, f, prices)
  const unit = <Cur id={num} size={14} />
  // Flash the price green/red only when THIS currency's price changes (new data landing) —
  // compared before repricing, so changing "priced in" or the numeraire moving never flashes.
  const raw = r.mid
  const prev = useRef(raw)
  const [flash, setFlash] = useState('')
  useEffect(() => {
    if (prev.current != null && raw != null && raw !== prev.current) {
      setFlash(raw > prev.current ? 'up' : 'down')
      const t = setTimeout(() => setFlash(''), 600)
      prev.current = raw
      return () => clearTimeout(t)
    }
    prev.current = raw
  }, [raw])
  return (
    <motion.div
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
        <span className={`pt-src ${r.source}`} title={srcBadge(r.source).title}>{srcBadge(r.source).label}</span>
      </div>
      <div className="pt-mid">
        {mid == null ? <span className="muted">no price</span>
          : <span className={`pt-num ${flash}`}><AnimatedNumber value={mid} format={fmt.rate} /><span className="pt-unit">{unit}</span></span>}
        {change != null && <span className={`pt-chg ${change >= 0 ? 'gain' : 'loss'}`}>{fmt.pct(change)}</span>}
      </div>
      <Spark points={trend} />
      {/* Ask / bid / spread live in the zoomed card (CardDetail), with their currency — the base
          card stays a price, a trend and where the price came from. */}
      <div className="pt-foot muted">{r.source === 'scout' ? 'daily close' : 'hourly mid'}{r.age_s != null && <> · {fmt.age(r.age_s)} old</>}</div>
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
  const winH = useHorizon(s => s.hours)              // app-wide horizon (topbar picker)
  const tick = useSync(s => s.tick)                  // topbar ⟳ pulse → refresh this view
  const setSyncBusy = useSync(s => s.setBusy)        // drive the topbar ⟳ spinner
  const [watchlist, setWatchlist] = useState(null)   // desktop-only board customization
  const { list: opts, nameOf } = useCurrencies()      // all currencies (names for pickers)
  const [openId, setOpenId] = useState(null)         // card expanded into detail view
  const [numById, setNumById] = useState(() => {     // per-card numeraire overrides (persisted)
    try { return JSON.parse(localStorage.getItem('board.num.v1') || '{}') } catch { return {} }
  })
  const setNum = (id, n) => {
    const next = { ...numById, [id]: n }
    setNumById(next)
    try { localStorage.setItem('board.num.v1', JSON.stringify(next)) } catch {}
  }

  // The picks ride along so each card's trend is the history of the market it is shown in.
  const numsParam = useMemo(() => Object.entries(numById).map(([c, n]) => `${c}:${n}`).join(','), [numById])
  const load = async () => {
    try { setData(await api.board(winH, numsParam)); setErr(null) } catch (e) { setErr(String(e.message || e)) }
  }

  // The board re-rendering IS the confirmation; only a failure toasts.
  const saveWatchlist = async (next) => {
    setWatchlist(next)
    try { await surface(useStatus.getState().saveSettings({ watchlist: next })); await load() }
    catch { setWatchlist(watchlist) }   // revert on failure
  }
  const addById = async (id) => {
    const m = opts.find(o => o.id === id)
    if (!m) return
    if ((watchlist || []).includes(m.id)) { toast(`${m.name} is already on the board`, false); return }
    await saveWatchlist([...(watchlist || []), m.id])
  }
  const removeCur = (id) => saveWatchlist((watchlist || []).filter(x => x !== id))
  const refresh = async () => {
    if (busy) return
    setBusy(true); setSyncBusy(true)
    await load()
    setBusy(false); setSyncBusy(false)
  }
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [winH, numsParam]) // eslint-disable-line
  // command palette → open a currency's detail here
  useEffect(() => nav.on(e => { if (e.type === 'openCurrency') setOpenId(e.id) }), [])
  // Hold leaderboard powers the pulse strip's top-3 holds + the full-universe top mover.
  useEffect(() => {
    // Holds = top stores of value (divine-denominated hold score). Movers = biggest |% change|
    // over the SAME window as the board, full universe — a genuinely different ranking.
    const load = () => {
      api.hold(winH, 'all', 'divine').then(setHold).catch(() => setHold(null))
      api.movers(winH, 3).then(setMovers).catch(() => setMovers(null))
    }
    load()
    // Same refresh as the tiles beside them — chips that only reloaded on a window change sat
    // stale next to a board that polls.
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [winH, tick])
  // Expand a pulse-strip item into the shared detail modal (enlarged graph + volume + change
  // over time), identical to clicking a board currency — via /api/asset (the hourly exchange card).
  const openAsset = (name, inNum) => assetModal.open(name, inNum)
  useEffect(() => {
    if (!isDesktop) return
    ensureSettings().then(s => setWatchlist(s.watchlist || [])).catch(() => {})
  }, [])
  // Manual refresh from the topbar ⟳ (bumps the shared tick) refreshes the mounted view.
  useEffect(() => { if (tick > 0) refresh() }, [tick]) // eslint-disable-line

  const ref = data?.reference ?? 'ref'
  const rows = data?.rows ?? []
  const prices = data?.prices ?? {}
  // Currencies a card can be priced in = those with a known reference price, richest first.
  const numOptions = useMemo(() => Object.keys(prices)
    .sort((a, b) => (prices[b] || 0) - (prices[a] || 0))
    .map(id => ({ id, name: nameOf(id) })), [prices, nameOf]) // eslint-disable-line
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
                const val = valueIn(r.id, r.mid, num, prices)
                return (
                  <button key={r.id} className="pulse-chip clickable" title={`${r.name || nameOf(r.id)} — central market · expand chart`}
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
                  onClick={() => openAsset(a.name, 'divine')}>
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
                  onClick={() => openAsset(a.name, a.num)}>
                  <span className="pulse-rank">{i + 1}</span><Cur name={a.name} size={16} />
                  <span className={`pulse-v ${a.change_pct >= 0 ? 'gain' : 'loss'}`}>{fmt.pct(a.change_pct)}</span></button>
              ))}
            </div>
          )}
        </div>
        </div>
      )}
      <div className="board-bar">
        <h2 style={{ margin: 0 }}>Price board <span className="muted" style={{ fontWeight: 400 }}>· {rangeLabel(winH)}</span></h2>
        <span className="spacer" />
        {isDesktop && watchlist && (
          <CurrencyPicker value="" placeholder="Add a currency…" onChange={addById}
            options={opts.filter(o => !watchlist.includes(o.id))} />
        )}
      </div>
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
      {data && rows.length === 0 && !err && <div className="empty">{isDesktop && watchlist ? 'Nothing on the board yet.' : 'No watched currencies yet — add some to the watchlist in Settings.'}</div>}
      {data && rows.length > 0 && (
        <motion.div className="price-grid" layout>
          <AnimatePresence mode="popLayout">
            {rows.map((r, i) => {
              const num = numFor(r)
              return <Tile key={r.id} index={i} r={r} num={num} factor={factorFor(r, num, prices)} prices={prices} numOptions={numOptions}
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
          return <CardDetail key="detail" r={openRow} num={num} factor={factorFor(openRow, num, prices)} range={rangeLabel(winH)}
            numOptions={numOptions} onNum={setNum} prices={prices} onClose={() => setOpenId(null)} />
        })()}
      </AnimatePresence>
      {/* A pulse-strip Hold/Mover item expanded into the SAME detail modal as a board currency. */}
      {assetModal.node}
    </div>
  )
}
