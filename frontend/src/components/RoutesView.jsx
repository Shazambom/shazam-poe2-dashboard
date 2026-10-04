import React, { useEffect, useMemo, useRef, useState } from 'react'
import { finishRoutes } from '../lib/routesStream.js'
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
import { useAutosave, useDebounced } from '../lib/hooks.js'
import { DEFAULT_FILTERS, filtersFromSettings, filtersToSave, searchKeyOf, streamQuery } from '../lib/routeFilters.js'

const INF = Infinity

// Column definitions: [key, label, accessor, defaultDir, title]
const COLS = [
  ['score', 'Score', r => r.score ?? -INF, 'desc', 'Overall rank: velocity-led blend of the weighted metrics'],
  ['commit', 'Commit', r => r.start_amount ?? 0, 'desc'],
  ['margin', 'Margin', r => r.margin ?? -INF, 'desc'],
  ['margin_pct', 'Margin %', r => r.margin_pct ?? -INF, 'desc'],
  ['margin_ref', 'Margin (ref)', r => r.margin_ref ?? -INF, 'desc'],
  ['gold', 'Gold', r => r.gold_free ? -1 : (r.gold ?? INF), 'asc'],
  ['velocity', 'Velocity', r => r.velocity_inf ? INF : (r.velocity ?? -INF), 'desc', 'margin ÷ (fill hours × gold) × 1000 — profit per hour per 1k gold'],
  ['liquidity_ref', 'Liquidity', r => r.liquidity_ref ?? INF, 'desc'],
  ['volume_ref_per_h', 'Volume / h', r => r.volume_ref_per_h ?? -INF, 'desc', "Slowest step's executed value per hour"],
  ['fill_hours', 'Fill est.', r => r.fill_hours ?? INF, 'asc', 'Sum over steps of commit ÷ hourly turnover'],
  ['max_age_s', 'Age', r => r.max_age_s ?? INF, 'asc'],
]

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
  const esRef = useRef(null)
  const accRef = useRef([])
  // The search sends exactly what the form shows (a cleared box as 0 = off), never leaving a blank
  // for the server to fill from the saved settings, and re-runs when any of it changes — but not
  // before the saved filters have loaded (a search with the defaults first swapped the table a
  // second later).
  const filterKey = searchKeyOf(f, loaded)

  const load = () => {
    esRef.current?.close()
    accRef.current = []
    setCounts(null); setErr(null); setStreaming(true)
    const es = new EventSource(api.routesStreamUrl(streamQuery(f)))
    esRef.current = es
    // The server scores as it streams (provisional `scores` after each batch, authoritative on
    // `done`) — one ranking implementation, in the backend. The table shows the PREVIOUS result
    // until `done`, then swaps in the new one whole: rows never re-sort under the cursor mid-read.
    const applyScores = (scores) => { if (scores) accRef.current.forEach(r => { if (scores[r.id] != null) r.score = scores[r.id] }) }
    es.addEventListener('meta', e => setMeta(JSON.parse(e.data)))
    es.addEventListener('routes', e => { accRef.current = accRef.current.concat(JSON.parse(e.data)) })
    es.addEventListener('scores', e => applyScores(JSON.parse(e.data)))
    es.addEventListener('done', e => {
      const d = JSON.parse(e.data)
      // The authoritative top list, whether this was a fresh search or a cached replay
      // (lib/routesStream.js): one population for the banding, so the rows don't change on reload.
      setRoutes(finishRoutes(accRef.current, d))
      setCounts(d)
      setStreaming(false)
      es.close()
    })
    es.addEventListener('error', e => {
      if (e.data) { try { setErr(JSON.parse(e.data).error) } catch { setErr('stream error') } }
      setStreaming(false)
      es.close()
    })
  }

  // The filters live in the user's settings: loaded once, saved (debounced) on every edit.
  const { save, arm } = useAutosave(next => useStatus.getState().saveSettings({ filters: filtersToSave(next) }), 800)
  useEffect(() => {
    ensureSettings().then(s => { setF(filtersFromSettings(s.filters)); setLoaded(true); arm() })
      .catch(() => setLoaded(true))              // no settings: search with the defaults, once
  }, []) // eslint-disable-line
  // The first key applies at once; later edits are debounced.
  const searchKey = useDebounced(filterKey, 500) ?? filterKey
  useEffect(() => {
    if (searchKey == null) return
    load()
    return () => esRef.current?.close()
  }, [searchKey]) // eslint-disable-line
  useEffect(() => {
    if (searchKey == null) return
    const t = setInterval(() => { if (document.visibilityState === 'visible' && !streaming) load() }, 120000)
    return () => clearInterval(t)
  }, [searchKey, streaming]) // eslint-disable-line

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
    const col = COLS.find(c => c[0] === sort.key) ?? COLS[0]
    const acc = col[2], desc = col[3] !== 'asc'
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
    return { rows: kept.map(r => ({ r, band: Math.min(4, Math.max(1, Math.floor(sig(r)))) })), active: true, metric: col[1] }
  }, [routes, sort, f.limit])
  const shown = banded.rows
  const maxVel = useMemo(() => Math.max(1e-9, ...shown.map(({ r }) => r.velocity_inf ? 0 : (r.velocity || 0))), [shown])
  const held = Object.keys(meta?.capital ?? {})
  const backfilling = status?.digest?.backfilling

  return (
    <div className="workspace">
      <aside className="rail">
        <ArbitrageCapital />

        <h2>Gold value</h2>
        <GoldValueSlider onCommit={load} />

        <h2>Filters</h2>
        <div className="field"><label>Minimum margin %</label><input type="number" step="0.1" value={f.min_margin_pct} onChange={set('min_margin_pct')} /></div>
        <div className="field"><label>Start from</label>
          <select value={f.start} onChange={set('start')}>
            <option value="">Everything I hold</option>
            {held.map(c => <option key={c} value={c}>{nameOf(c)}</option>)}
          </select>
        </div>

        <details className="adv">
          <summary>More filters</summary>
          <div className="field"><label>Minimum margin, in {ref}</label><input type="number" step="0.1" value={f.min_margin_ref} onChange={set('min_margin_ref')} /></div>
          <div className="field"><label>Maximum gold per loop</label><input type="number" step="100" placeholder="no limit" value={f.max_gold} onChange={set('max_gold')} /></div>
          <div className="field"><label>Minimum margin per 1k gold</label><input type="number" step="0.01" placeholder="no limit" value={f.min_margin_per_1k_gold} onChange={set('min_margin_per_1k_gold')} /></div>
          <div className="field"><label>Minimum liquidity, in {ref}</label><input type="number" step="1" placeholder="no limit" value={f.min_liquidity_ref} onChange={set('min_liquidity_ref')} />
            {f.min_liquidity_ref !== '' && Number(f.min_liquidity_ref) < 200 && <span className="warn-hint">⚠ Below 200 you'll see routes you can't actually fill — expect a bad time.</span>}</div>
          <div className="field"><label>Minimum velocity, {ref}/h per 1k gold</label><input type="number" step="0.01" placeholder="no limit" value={f.min_velocity} onChange={set('min_velocity')} /></div>
          <div className="field"><label>Minimum traded volume, {ref} per hour</label><input type="number" step="1" placeholder="no limit" value={f.min_volume_ref_per_h} onChange={set('min_volume_ref_per_h')} />
            {f.min_volume_ref_per_h !== '' && Number(f.min_volume_ref_per_h) < 100 && <span className="warn-hint">⚠ Below 100/h markets are too thin to trust — expect a bad time.</span>}</div>
          <div className="field"><label>Maximum minutes per step</label><input type="number" step="5" placeholder="no limit" value={f.max_step_minutes} onChange={set('max_step_minutes')}
            title="How long the slowest step would take at that market's own trading pace: the units you push in ÷ the units it trades per hour." /></div>
          <div className="field"><label>Maximum estimated fill time, hours</label><input type="number" step="0.5" placeholder="no limit" value={f.max_fill_hours} onChange={set('max_fill_hours')} /></div>
          <div className="check"><Toggle checked={!!f.exclude_recipes} onChange={v => update('exclude_recipes', v)} label="Exchange steps only" /></div>
          <div className="field"><label>Show at most</label><input type="number" value={f.limit} onChange={set('limit')} /></div>
        </details>
        <ArbitrageAlgorithm onSaved={load} />

      </aside>

      <section className="main">
        <ConvertView currencies={currencies} capital={capital} />
        {err && <div className="notice error">Couldn't load routes: {err}</div>}
        {backfilling && (
          <div className="notice">Market history is still syncing ({fmt.n(status.digest.behind_h, 0)}h behind). Loops fill in as rates land — no action needed.</div>
        )}
        {meta?.notional && (
          <div className="notice">Loops are sized to a notional 10 {ref}. Add Chaos, Exalted or Divine on
            {' '}<button type="button" className="link-btn" onClick={() => nav.goTrading('sales')}>Stash</button> to size them to what you hold.</div>
        )}

        {streaming && routes.length === 0 ? (
          <table><tbody>{Array.from({ length: 6 }).map((_, i) => <tr key={i}><td colSpan={12}><div className="sk sk-row" /></td></tr>)}</tbody></table>
        ) : !streaming && routes.length === 0 ? (
          <div className="empty">
            <b>{(counts?.total_candidates ?? 0) === 0 ? 'No loops yet.' : 'No loop clears your thresholds.'}</b><br />
            {(counts?.total_candidates ?? 0) === 0
              ? (backfilling
                ? 'Market history is still syncing — this page fills in by itself within a few minutes.'
                : 'The market graph is empty for this league. Check the league in the top bar, or wait for the next hourly market update.')
              : 'Loosen a filter on the left — the margin threshold is usually the one.'}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Loop{streaming && <span className="streaming" aria-label="searching" />}</th>
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
                    <tr className="std-sep" aria-hidden="true"><td colSpan={12}><span className="std-bar" /></td></tr>
                  )}
                  <tr className="route" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <td className="loop-cell"><Loop r={r} /></td>
                    <td className="num">{r.score == null ? <span className="muted">–</span> : r.score.toFixed(3)}</td>
                    <td className="num" title={r.cycle_unit > 1 ? `${r.cycles} cycles × ${r.cycle_unit} per cycle` : `${r.cycles} single-unit cycles`}>
                      {fmt.n(r.start_amount)} <Cur id={r.start} size={16} />
                      {r.cycle_unit > 1 && <span className="muted" style={{ fontSize: 11 }}> ×{fmt.n(r.cycle_unit)}</span>}
                    </td>
                    <td className={`num ${r.margin >= 0 ? 'gain' : 'loss'}`}>{r.margin >= 0 ? '+' : ''}{fmt.n(r.margin)}</td>
                    <td className={`num ${r.margin >= 0 ? 'gain' : 'loss'}`}>{fmt.pct(r.margin_pct)}</td>
                    <td className="num"><Wealth v={r.margin_ref} cur={ref} size={12} /></td>
                    <td className="num">{r.gold_free ? <span className="muted">free</span> : fmt.n(r.gold)}</td>
                    <td className="num mpg">
                      {r.velocity_inf ? <span className="gain">∞</span> : r.velocity == null ? <span className="muted">–</span> : (
                        <>
                          <span className="gold-bar" style={{ width: `${Math.max(2, Math.min(60, 60 * (r.velocity || 0) / maxVel))}px` }} />
                          {fmt.n(r.velocity, 3)}
                        </>
                      )}
                    </td>
                    <td className="num">{r.liquidity_ref == null ? <span className="muted">∞</span> : <Wealth v={r.liquidity_ref} cur={ref} size={12} />}</td>
                    <td className="num">{r.volume_ref_per_h == null ? <span className="muted">–</span> : <Wealth v={r.volume_ref_per_h} cur={ref} size={12} suffix="/h" />}</td>
                    <td className={`num ${r.fill_hours != null && r.fill_hours > 4 ? 'muted' : ''}`}>{fmt.dur(r.fill_hours)}</td>
                    <td className="num muted">{fmt.age(r.max_age_s)}</td>
                  </tr>
                  {open === r.id && <tr><td colSpan={12} style={{ padding: 0 }}><Detail r={r} refCur={ref} /></td></tr>}
                </React.Fragment>
              ))}
            </tbody>
          </table>
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
