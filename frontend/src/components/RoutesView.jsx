import React, { useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { finishRoutes, streamSearch } from '../lib/routesStream.js'
import { api, fmt } from '../lib/api.js'
import ConvertView from './ConvertView.jsx'
import Cur from './Cur.jsx'
import GoldValueSlider from './GoldValueSlider.jsx'
import ArbitrageAlgorithm from './ArbitrageAlgorithm.jsx'
import Toggle from './Toggle.jsx'
import { Detail, Loop } from './RouteSteps.jsx'
import Wealth from './Wealth.jsx'
import { useSync } from '../lib/syncStore.js'
import { arbitrageHoldings, netWorth } from '../lib/stash.js'
import { nav } from '../lib/nav.js'
import { useCurrencies } from '../lib/icons.js'
import { ensureSettings, useStatus } from '../lib/statusStore.js'
import { useApi, useAutosave, useDebounced } from '../lib/hooks.js'
import { useTweaks } from '../lib/tweaks.js'
import { yieldTiers } from '../lib/yieldTier.js'
import { DEFAULT_FILTERS, filtersFromSettings, filtersToSave, sameSearch, searchKeyOf, streamQuery } from '../lib/routeFilters.js'
import { activePreset } from '../lib/arbPresets.js'

const INF = Infinity
const SEARCH_RETRIES = 2   // a timed-out search is searched again this many times, then the page says so

// Column definitions: [key, label, accessor, defaultDir, title]. The row says what you need, what you make and how
// long it takes (first-contact audit, 2026-10-08); the engine's figures (score, liquidity, volume, age) sort it but
// never sit on it. The default order is the hidden score, best first; clicking "Loop" returns to it.
const COLS = [
  ['commit', 'Needs', r => r.start_amount ?? 0, 'desc'],
  ['margin', 'Profit', r => r.margin ?? -INF, 'desc'],
  ['velocity', 'Yield', r => r.velocity_inf ? INF : (r.velocity ?? -INF), 'desc'],
  ['gold', 'Gold', r => r.gold_free ? -1 : (r.gold ?? INF), 'asc'],
  ['fill_hours', 'Takes', r => r.fill_hours ?? INF, 'asc'],
]
const SORTS = Object.fromEntries(COLS.map(([k, , acc, dir]) => [k, [acc, dir]]))
SORTS.score = [r => r.score ?? -INF, 'desc']
const NCOLS = COLS.length + 1

export default function RoutesView({ capital, status, currencies }) {
  const { nameOf } = useCurrencies()
  const [f, setF] = useState(DEFAULT_FILTERS)
  const [loaded, setLoaded] = useState(false)    // the saved filters are in: only then search
  const [routes, setRoutes] = useState([])
  const [meta, setMeta] = useState(null)
  const [counts, setCounts] = useState(null)
  const [streaming, setStreaming] = useState(false)
  const [sort, setSort] = useState({ key: 'score', dir: 'desc' })
  const [err, setErr] = useState(null)
  const [open, setOpen] = useState(null)
  const tick = useSync(s => s.tick)              // topbar ⟳ → refresh loops
  const settings = useStatus(s => s.settings)
  const presets = useApi(() => api.arbitragePresets(), []).data || []
  const [rev, setRev] = useState(0)              // bumped by a preset pick: the sliders re-read the settings
  const esRef = useRef(null)
  const accRef = useRef([])
  const retries = useRef(0)
  // The search sends exactly what the form shows (a cleared box as 0 = off), never leaving a blank
  // for the server to fill from the saved settings, and re-runs when any of it changes — but not
  // before the saved filters have loaded (a search with the defaults first swapped the table a
  // second later).
  const filterKey = searchKeyOf(f, loaded)

  const load = () => {
    esRef.current?.()                            // a superseded search reports nothing more
    accRef.current = []
    setCounts(null); setErr(null); setStreaming(true)
    // The server scores as it streams (provisional `scores` after each batch, authoritative on
    // `done`) — one ranking implementation, in the backend. The table shows the PREVIOUS result
    // until `done`, then swaps in the new one whole: rows never re-sort under the cursor mid-read.
    esRef.current = streamSearch(api.routesStreamUrl(streamQuery(f)), {
      meta: setMeta,
      routes: (rs) => { accRef.current = accRef.current.concat(rs) },
      scores: (scores) => { if (scores) accRef.current.forEach(r => { if (scores[r.id] != null) r.score = scores[r.id] }) },
      // The authoritative top list, whether this was a fresh search or a cached replay
      // (lib/routesStream.js): one population for the banding, so the rows don't change on reload.
      done: (d) => { retries.current = 0; setRoutes(finishRoutes(accRef.current, d)); setCounts(d); setStreaming(false) },
      fail: (msg) => { if (msg) setErr(msg); setStreaming(false) },
      // a busy backend, not an empty market: search again, a couple of times, then stop and say so
      timeout: () => { if (retries.current < SEARCH_RETRIES) { retries.current += 1; load() } else { setErr('the search is taking too long — press refresh to try again'); setStreaming(false) } },
    })
  }

  // The filters live in the user's settings: loaded once, saved (debounced) on every edit.
  const { save, arm, flush } = useAutosave(next => useStatus.getState().saveSettings({ filters: filtersToSave(next) }), 800)
  useEffect(() => {
    ensureSettings().then(s => { setF(filtersFromSettings(s.filters)); setLoaded(true); arm() })
      .catch(() => setLoaded(true))              // no settings: search with the defaults, once
  }, []) // eslint-disable-line
  // The first key applies at once; later edits are debounced.
  const searchKey = useDebounced(filterKey, 500) ?? filterKey
  useEffect(() => {
    if (searchKey == null) return
    load()
    return () => esRef.current?.()
  }, [searchKey]) // eslint-disable-line
  useEffect(() => {
    if (searchKey == null) return
    const t = setInterval(() => { if (document.visibilityState === 'visible' && !streaming) load() }, 120000)
    return () => clearInterval(t)
  }, [searchKey, streaming]) // eslint-disable-line

  const active = activePreset(presets, settings)
  // A pick is an ordinary settings save of the preset's values, made after any edit still waiting to save: the
  // sliders are redrawn first (each sends its pending edit as it goes), then the filter boxes' edit is sent, then the
  // preset — saves land in order, so the preset wins its own values. The form and sliders then show them. A preset
  // that leaves the filter boxes as they are (only weights, window, spread or gold differ) gives the search key
  // nothing to react to, so the pick searches itself.
  const pick = async (p) => {
    flushSync(() => setRev(r => r + 1))
    await flush().catch(() => {})
    const s = await useStatus.getState().saveSettings(p.values).catch(() => null)
    if (!s) return
    const next = filtersFromSettings(s.filters)
    setF(next); setRev(r => r + 1)
    if (sameSearch(next, f)) load()
  }

  // Manual refresh from the topbar ⟳ re-runs the search.
  useEffect(() => { if (tick > 0 && searchKey != null) load() }, [tick]) // eslint-disable-line

  const update = (k, v) => { const next = { ...f, [k]: v }; setF(next); save(next) }
  const set = (k) => (e) => update(k, e.target.type === 'checkbox' ? e.target.checked : e.target.value)
  const clickSort = (key, defDir) => setSort(s => s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: defDir })
  const ref = meta?.reference ?? capital?.reference ?? 'ref'
  // Surface only the standout loops: those at least 1σ better-than-mean on the SELECTED metric
  // (velocity/score by default), and split what's left into σ bands so the truly exceptional
  // loops read apart from the merely-good. Degenerate data (too few loops, no spread, or nothing
  // clears +1σ) falls back to showing everything so the view never blanks.
  const banded = useMemo(() => {
    const [acc, defDir] = SORTS[sort.key] ?? SORTS.score
    const desc = defDir !== 'asc'
    const limit = Number(f.limit) || 100
    const display = (arr) => {
      arr.sort((a, b) => { const ka = acc(a), kb = acc(b); return ka === kb ? 0 : kb > ka ? 1 : -1 })
      if (sort.dir === 'asc') arr.reverse()
      return arr
    }
    const all = () => ({ rows: display([...routes]).slice(0, limit).map(r => ({ r, band: 0 })), active: false })
    const vals = routes.map(acc).filter(Number.isFinite)
    if (vals.length < 3) return all()
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length)
    if (!(sd > 0)) return all()
    // σ better-than-mean: +ve = better. Non-finite (∞ velocity / free gold) counts as top-tier.
    const sig = (r) => { const v = acc(r); if (!Number.isFinite(v)) return (v > 0) === desc ? 9 : -9; return (desc ? v - mean : mean - v) / sd }
    let kept = routes.filter(r => sig(r) >= 1)
    if (!kept.length) return all()
    kept = display(kept).slice(0, limit)
    return { rows: kept.map(r => ({ r, band: Math.min(4, Math.max(1, Math.floor(sig(r)))) })), active: true }
  }, [routes, sort, f.limit])
  const shown = banded.rows
  const tiers = useMemo(() => yieldTiers(shown.map(({ r }) => r.velocity_inf ? Infinity : r.velocity)), [shown])
  const quoteAge = useMemo(() => Math.max(0, ...shown.map(({ r }) => r.max_age_s ?? 0)), [shown])
  const tweaks = useTweaks()                     // knobs show on beta and dev clients only
  const held = Object.keys(meta?.capital ?? {})
  const backfilling = status?.digest?.backfilling

  return (
    <div className="workspace">
      <aside className="rail">
        <ArbitrageCapital />

        {presets.length > 0 && <>
          <h2>Preset</h2>
          <div className="preset-grid">
            {presets.map(p => (
              <button key={p.id} type="button" className={`btn small ${active === p.id ? 'primary' : ''}`}
                aria-pressed={active === p.id} onClick={() => pick(p)}>{p.label}</button>
            ))}
          </div>
        </>}

        {tweaks && <>
          <h2>Gold value</h2>
          <GoldValueSlider key={`gold-${rev}`} onCommit={load} />
        </>}

        <h2>Filters</h2>
        {tweaks && <div className="field"><label>Minimum margin %</label><input type="number" step="0.1" value={f.min_margin_pct} onChange={set('min_margin_pct')} /></div>}
        <div className="field"><label>Start from</label>
          <select value={f.start} onChange={set('start')}>
            <option value="">Everything I hold</option>
            {held.map(c => <option key={c} value={c}>{nameOf(c)}</option>)}
          </select>
        </div>

        {tweaks && <details className="adv">
          <summary>More filters</summary>
          <div className="field"><label>Minimum margin, in exalted</label><input type="number" step="0.1" value={f.min_margin_ref} onChange={set('min_margin_ref')} /></div>
          <div className="field"><label>Maximum gold per loop</label><input type="number" step="100" placeholder="no limit" value={f.max_gold} onChange={set('max_gold')} /></div>
          <div className="field"><label>Minimum margin per 1k gold</label><input type="number" step="0.01" placeholder="no limit" value={f.min_margin_per_1k_gold} onChange={set('min_margin_per_1k_gold')} /></div>
          <div className="field"><label>Minimum liquidity, in exalted</label><input type="number" step="1" placeholder="no limit" value={f.min_liquidity_ref} onChange={set('min_liquidity_ref')} />
            {f.min_liquidity_ref !== '' && Number(f.min_liquidity_ref) < 200 && <span className="warn-hint">⚠ Below 200 you'll see routes you can't actually fill — expect a bad time.</span>}</div>
          <div className="field"><label>Minimum velocity, exalted/h per 1k gold</label><input type="number" step="0.01" placeholder="no limit" value={f.min_velocity} onChange={set('min_velocity')} /></div>
          <div className="field"><label>Minimum traded volume, exalted per hour</label><input type="number" step="1" placeholder="no limit" value={f.min_volume_ref_per_h} onChange={set('min_volume_ref_per_h')} />
            {f.min_volume_ref_per_h !== '' && Number(f.min_volume_ref_per_h) < 100 && <span className="warn-hint">⚠ Below 100/h markets are too thin to trust — expect a bad time.</span>}</div>
          <div className="field"><label>Maximum minutes per step</label><input type="number" step="5" placeholder="no limit" value={f.max_step_minutes} onChange={set('max_step_minutes')}
            title="How long the slowest step would take at that market's own trading pace: the units you push in ÷ the units it trades per hour." /></div>
          <div className="field"><label>Maximum estimated fill time, hours</label><input type="number" step="0.5" placeholder="no limit" value={f.max_fill_hours} onChange={set('max_fill_hours')} /></div>
          <div className="check"><Toggle checked={!!f.exclude_recipes} onChange={v => update('exclude_recipes', v)} label="Exchange steps only" /></div>
          <div className="field"><label>Show at most</label><input type="number" value={f.limit} onChange={set('limit')} /></div>
        </details>}
        {tweaks && <ArbitrageAlgorithm key={`algo-${rev}`} onSaved={load} />}

      </aside>

      <section className="main">
        <ConvertView currencies={currencies} capital={capital} />
        {err && <div className="notice error">Couldn't load routes: {err}</div>}
        {backfilling && (
          <div className="notice">Market history is still syncing ({fmt.n(status.digest.behind_h, 0)}h behind). Loops fill in as rates land — no action needed.</div>
        )}
        {meta?.notional && (
          <div className="notice">Sized to 10 <Cur id={ref} size={14} /> · <button type="button" className="link-btn" onClick={() => nav.goTrading('sales')}>Add what you hold ›</button></div>
        )}

        {streaming && routes.length === 0 ? (
          <table><tbody>{Array.from({ length: 6 }).map((_, i) => <tr key={i}><td colSpan={NCOLS}><div className="sk sk-row" /></td></tr>)}</tbody></table>
        ) : !streaming && counts && routes.length === 0 ? (
          <div className="empty">
            <b>{(counts?.total_candidates ?? 0) === 0 ? 'No loops yet.' : 'No loop clears your thresholds.'}</b><br />
            {(counts?.total_candidates ?? 0) === 0
              ? (backfilling
                ? 'Market history is still syncing — this page fills in by itself within a few minutes.'
                : 'The market graph is empty for this league. Check the league in the top bar, or wait for the next hourly market update.')
              : tweaks ? 'Loosen a filter on the left — the margin threshold is usually the one.' : 'Try a looser preset.'}
          </div>
        ) : (
          <>
          <div className="loops-head"><span>Best loops</span><span className="muted">prices from {fmt.age(quoteAge)} ago</span></div>
          <table>
            <thead>
              <tr>
                <th className={`sortable ${sort.key === 'score' ? 'sorted' : ''}`} title="Best first" onClick={() => setSort({ key: 'score', dir: 'desc' })}>Loop{sort.key === 'score' ? ' ▾' : ''}{streaming && <span className="streaming" aria-label="searching" />}</th>
                {COLS.map(([key, label, , defDir, title]) => (
                  <th key={key} className={`num sortable ${sort.key === key ? 'sorted' : ''}`} title={title || `Sort by ${label}`}
                    onClick={() => clickSort(key, defDir)}>
                    {label}{sort.key === key ? (sort.dir === 'desc' ? ' ▾' : ' ▴') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map(({ r, band }, i) => (
                <React.Fragment key={r.id}>
                  {banded.active && i > 0 && band !== shown[i - 1].band && (
                    <tr className="std-sep" aria-hidden="true"><td colSpan={NCOLS}><span className="std-bar" /></td></tr>
                  )}
                  <tr className="route" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <td className="loop-cell"><Loop r={r} /></td>
                    <td className="num" title={r.cycle_unit > 1 ? `${r.cycles} cycles × ${r.cycle_unit} per cycle` : `${r.cycles} single-unit cycles`}>
                      {fmt.n(r.start_amount)} <Cur id={r.start} size={16} />
                      {r.cycle_unit > 1 && <span className="muted" style={{ fontSize: 11 }}> ×{fmt.n(r.cycle_unit)}</span>}
                    </td>
                    <td className="num">
                      <span className={r.margin >= 0 ? 'gain' : 'loss'}>{r.margin >= 0 ? '+' : ''}{fmt.n(r.margin)} <Cur id={r.start} size={14} /></span>
                      <span className="muted" style={{ marginLeft: 6 }}>{fmt.pct(r.margin_pct)}</span>
                    </td>
                    <td className="num">{tiers[i] ? <span className={`tier tier-${tiers[i].toLowerCase()}`}>{tiers[i]}</span> : <span className="muted">–</span>}</td>
                    <td className="num">{r.gold_free ? <span className="muted">free</span> : fmt.n(r.gold)}</td>
                    <td className={`num ${r.fill_hours != null && r.fill_hours > 4 ? 'muted' : ''}`}>{fmt.dur(r.fill_hours)}</td>
                  </tr>
                  {open === r.id && <tr><td colSpan={NCOLS} style={{ padding: 0 }}><Detail r={r} refCur={ref} /></td></tr>}
                </React.Fragment>
              ))}
            </tbody>
          </table>
          </>
        )}
      </section>
    </div>
  )
}

// What arbitrage may trade from: the held default cash and hub currencies (the server's `arbitrage`
// flag on /api/capital). Holdings are edited on Trading → Stash, where every holding counts.
function ArbitrageCapital() {
  const capital = useStatus(s => s.capital)
  const held = arbitrageHoldings(capital)
  return (
    <div className="capcard">
      <h2>What arbitrage can use</h2>
      {held.length
        ? held.map(r => <div className="cap-row" key={r.currency}><span className="cap-name"><Cur id={r.currency} text /></span><span className="cap-q">{fmt.n(r.qty, 0)}</span></div>)
        : <div className="hint">You hold nothing arbitrage trades from yet. Add Chaos, Exalted or Divine on Stash.</div>}
      <div className="cap-foot">
        {held.length > 0 && <Wealth v={netWorth(held)} cur={capital?.reference} size={12} />}
        <button type="button" className="link-btn" onClick={() => nav.goTrading('sales')}>Stash ›</button>
      </div>
    </div>
  )
}
