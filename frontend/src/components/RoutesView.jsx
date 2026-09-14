import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, fmt } from '../lib/api.js'
import CapitalCard from './CapitalCard.jsx'
import Cur from './Cur.jsx'

const INF = Infinity
const hrs = (h) => h == null ? '–' : h < 1 / 60 ? '<1m' : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`

const DEFAULT_FILTERS = {
  min_margin_pct: 0.5, min_margin_ref: 0, max_gold: '', min_margin_per_1k_gold: '',
  min_liquidity_ref: '', min_volume_ref_per_h: '', max_fill_hours: '', min_velocity: '', live_only: false, exclude_recipes: false, limit: 100, start: '',
}

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

function scoreAll(routes, w) {
  const n = routes.length
  if (!n) return
  const wv = w?.velocity ?? 0.5, we = w?.margin_per_1k_gold ?? 0.2, wl = w?.margin_ref ?? 0.2, wo = w?.volume ?? 0.1
  const tot = (wv + we + wl + wo) || 1
  const rank = (key) => {
    const order = [...routes].sort((a, b) => { const ka = key(a), kb = key(b); return ka === kb ? 0 : kb > ka ? 1 : -1 })
    const m = {}; order.forEach((r, i) => { m[r.id] = 1 - i / n }); return m
  }
  const eff = rank(r => r.gold_free && r.margin_ref > 0 ? INF : (r.margin_per_1k_gold ?? -INF))
  const val = rank(r => r.margin_ref)
  const vol = rank(r => r.volume_ref_per_h == null ? INF : r.volume_ref_per_h)
  const vel = rank(r => r.velocity_inf ? INF : (r.velocity ?? -INF))
  routes.forEach(r => { r.score = Math.round(((wv * vel[r.id] + we * eff[r.id] + wl * val[r.id] + wo * vol[r.id]) / tot) * 1e4) / 1e4 })
}

const RECIPE_GLYPH = { disenchant: '⊖', combine: '⊕', reforge: '⟳', vendor: '⇄' }

function Loop({ r }) {
  return (
    <span className="loop">
      {r.path_names.map((n, i) => (
        <React.Fragment key={i}>
          {i > 0 && (() => {
            const step = r.steps[i - 1]
            const kind = r.kinds[i - 1]
            const glyph = kind === 'recipe' ? (RECIPE_GLYPH[step.meta?.kind] ?? '⊕') : null
            const title = kind === 'recipe'
              ? `${step.meta?.kind ?? 'recipe'}: ${step.meta?.name ?? ''} · ${fmt.rate(step.rate)} per unit · no gold`
              : `${kind} · ${fmt.rate(step.rate)} per unit`
            return (
              <span className="hop" title={title}>
                <i className={`k ${kind}`} />{glyph && <b className="recipe-glyph">{glyph}</b>}{fmt.rate(step.rate)}
              </span>
            )
          })()}
          <span className="node"><Cur id={r.path?.[i]} name={n} size={18} /></span>
        </React.Fragment>
      ))}
    </span>
  )
}

function Detail({ r, refCur, onRefresh, refreshing, canLive }) {
  const [copied, setCopied] = useState(null)
  const copy = async (text, i) => {
    try { await navigator.clipboard.writeText(text); setCopied(i); setTimeout(() => setCopied(null), 1500) } catch {}
  }
  return (
    <div className="detail">
      <div className="row hint">
        <span>Commit <b>{fmt.n(r.start_amount)}</b> <Cur id={r.start} name={r.start_name} size={16} />, hold {fmt.n(r.capital_held)}</span>
        <span>· ends with <b>{fmt.n(r.end_amount)}</b></span>
        <span>· value through loop {fmt.n(r.value_ref, 1)} <Cur id={refCur} size={14} /></span>
        <span>· oldest quote {fmt.age(r.max_age_s)}</span>
        {r.profit_per_hour != null && <span>· earns {fmt.n(r.profit_per_hour, 2)} <Cur id={refCur} size={14} />/h</span>}
        {r.score != null && r.score_parts && <span>· score {r.score} (velocity {r.score_parts.velocity}, efficiency {r.score_parts.efficiency}, value {r.score_parts.value}, volume {r.score_parts.volume})</span>}
        <span className="spacer" />
        {canLive && r.pairs.length > 0 && (
          <button className="btn small" disabled={refreshing} onClick={(e) => { e.stopPropagation(); onRefresh(r) }}>
            {refreshing ? 'Fetching live…' : `Refresh this loop (${r.pairs.length} ${r.pairs.length === 1 ? 'pair' : 'pairs'})`}
          </button>
        )}
      </div>
      <table>
        <thead>
          <tr>
            <th>Step</th><th>Source</th><th className="num">Rate</th><th className="num">In</th>
            <th className="num">Out</th><th className="num">Gold</th><th className="num" title="executed units of the input currency per hour">Turnover / h</th><th>Best offer</th>
          </tr>
        </thead>
        <tbody>
          {r.steps.map((s, i) => {
            const f = s.fills?.[0]
            return (
              <tr key={i}>
                <td><Cur id={s.from} name={s.from_name} size={16} /> to <Cur id={s.to} name={s.to_name} size={16} /></td>
                <td><i className={`k ${s.kind}`} style={{ display: 'inline-block', marginRight: 6 }} />
                  {s.kind === 'recipe' ? (s.meta?.name || 'recipe') : s.kind}
                  {s.kind !== 'recipe' && <span className="muted"> {fmt.age(s.age_s)}</span>}
                </td>
                <td className="num">{fmt.rate(s.rate)}</td>
                <td className="num">{fmt.n(s.in, 2)}{s.unconverted > 0.5 && <span className="muted"> (+{fmt.n(s.unconverted)} idle)</span>}</td>
                <td className="num">{fmt.n(s.out)}</td>
                <td className="num">{s.gold ? fmt.n(s.gold) : <span className="muted">free</span>}</td>
                <td className="num">{s.kind === 'recipe' ? <span className="muted">n/a</span> : s.vol_in_per_h == null ? '–' : fmt.n(s.vol_in_per_h, 0)}</td>
                <td>
                  {f?.whisper ? (
                    <span className="row">
                      <span className="whisper" title={f.whisper}>{f.account ? `${f.account}: ` : ''}{f.whisper}</span>
                      <button className="btn small" onClick={() => copy(f.whisper, i)}>{copied === i ? 'Copied' : 'Copy'}</button>
                    </span>
                  ) : <span className="muted">{s.kind === 'digest' ? 'hourly VWAP, place at market' : '–'}</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default function RoutesView({ capital, status, currencies, onCapitalSaved }) {
  const [f, setF] = useState(DEFAULT_FILTERS)
  const [routes, setRoutes] = useState([])
  const [meta, setMeta] = useState(null)
  const [counts, setCounts] = useState(null)
  const [streaming, setStreaming] = useState(false)
  const [sort, setSort] = useState({ key: 'score', dir: 'desc' })
  const [err, setErr] = useState(null)
  const [open, setOpen] = useState(null)
  const [liveBusy, setLiveBusy] = useState(false)
  const [autoLive, setAutoLive] = useState(false)
  const [refreshingId, setRefreshingId] = useState(null)
  const [note, setNote] = useState(null)
  const [rl, setRl] = useState(null)
  const [liveN, setLiveN] = useState(5)
  const esRef = useRef(null)
  const accRef = useRef([])
  const weightsRef = useRef(null)
  const canLive = !!status?.session?.connected
  const filterKey = JSON.stringify([f.min_margin_pct, f.min_margin_ref, f.max_gold, f.min_margin_per_1k_gold,
    f.min_liquidity_ref, f.min_volume_ref_per_h, f.max_fill_hours, f.min_velocity, f.live_only, f.exclude_recipes, f.start])

  const load = () => {
    esRef.current?.close()
    accRef.current = []
    setRoutes([]); setCounts(null); setErr(null); setStreaming(true)
    const es = new EventSource(api.routesStreamUrl({ ...f, sort: undefined, limit: undefined }))
    esRef.current = es
    es.addEventListener('meta', e => {
      const m = JSON.parse(e.data)
      weightsRef.current = m.rank_weights
      setMeta(m)
    })
    es.addEventListener('routes', e => {
      accRef.current = accRef.current.concat(JSON.parse(e.data))
      scoreAll(accRef.current, weightsRef.current)
      setRoutes([...accRef.current])
    })
    es.addEventListener('done', e => {
      const d = JSON.parse(e.data)
      if (d.scores) accRef.current.forEach(r => { if (d.scores[r.id] != null) r.score = d.scores[r.id] })
      setRoutes([...accRef.current])
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

  useEffect(() => { api.settings().then(s => { const g = { ...s.filters }; delete g.sort; ['max_gold','min_margin_per_1k_gold','min_liquidity_ref','min_volume_ref_per_h','max_fill_hours','min_velocity'].forEach(k => { if (!g[k]) g[k] = '' }); setF(x => ({ ...x, ...g })); setLiveN(s.live_top_n ?? 5) }).catch(() => {}) }, [])
  useEffect(() => { load(); return () => esRef.current?.close() }, [filterKey]) // eslint-disable-line
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible' && !streaming) load() }, 120000)
    return () => clearInterval(t)
  }, [filterKey, streaming]) // eslint-disable-line
  useEffect(() => {
    const tick = () => api.rateLimits().then(setRl).catch(() => {})
    tick(); const t = setInterval(tick, 5000); return () => clearInterval(t)
  }, [])

  const applyResult = (d) => {
    accRef.current = d.routes
    setRoutes(d.routes)
    setCounts({ total_candidates: d.total_candidates, total_after_filters: d.total_after_filters })
  }
  const refreshTop = async () => {
    if (!canLive || liveBusy) return
    setLiveBusy(true); setNote(null)
    try {
      const d = await api.refreshTop(f, Number(liveN))
      applyResult(d)
      const r = d.refresh
      setNote(r.waited === 0 ? `Top ${r.top_n}: all ${r.pairs_considered} pairs already fresh, nothing fetched.`
        : `Top ${r.top_n}: fetched ${r.done} of ${r.waited} stale pairs${r.timed_out ? ' (rest still queued)' : ''}.`)
    } catch (e) { setNote(String(e.message || e)) }
    setLiveBusy(false)
  }
  const refreshOne = async (r) => {
    setRefreshingId(r.id); setNote(null)
    try {
      const d = await api.refreshRoute(r.id, r.pairs, f)
      accRef.current = d.routes; setRoutes(d.routes)
      if (!d.still_passes) setNote(d.route ? `After refresh that loop no longer clears your thresholds (margin now ${fmt.pct(d.route.margin_pct)}).` : 'After refresh that loop no longer exists.')
      else setNote(`Loop refreshed: ${d.refresh.done} of ${d.refresh.waited} pairs fetched.`)
    } catch (e) { setNote(String(e.message || e)) }
    setRefreshingId(null)
  }
  useEffect(() => {
    if (!autoLive || !canLive) return
    refreshTop()
    const t = setInterval(refreshTop, 120000)
    return () => clearInterval(t)
  }, [autoLive, canLive, filterKey, liveN]) // eslint-disable-line

  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const clickSort = (key, defDir) => setSort(s => s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: defDir })
  const ref = meta?.reference ?? capital?.reference ?? 'ref'
  const shown = useMemo(() => {
    const col = COLS.find(c => c[0] === sort.key) ?? COLS[0]
    const acc = col[2]
    const arr = [...routes].sort((a, b) => { const ka = acc(a), kb = acc(b); return ka === kb ? 0 : kb > ka ? 1 : -1 })
    if (sort.dir === 'asc') arr.reverse()
    return arr.slice(0, Number(f.limit) || 100)
  }, [routes, sort, f.limit])
  const maxVel = useMemo(() => Math.max(1e-9, ...shown.map(r => r.velocity_inf ? 0 : (r.velocity || 0))), [shown])
  const held = Object.keys(meta?.capital ?? {})
  const backfilling = status?.digest?.backfilling

  return (
    <div className="workspace">
      <aside className="rail">
        <CapitalCard currencies={currencies} status={status} onSaved={() => { onCapitalSaved?.(); load() }} />

        <h2>Filters</h2>
        <div className="field"><label>Minimum margin %</label><input type="number" step="0.1" value={f.min_margin_pct} onChange={set('min_margin_pct')} /></div>
        <div className="field"><label>Start from</label>
          <select value={f.start} onChange={set('start')}>
            <option value="">Everything I hold</option>
            {held.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <label className="check"><input type="checkbox" checked={!!f.live_only} onChange={set('live_only')} /> Live quotes only</label>

        <details className="adv">
          <summary>More filters</summary>
          <div className="field"><label>Minimum margin, in {ref}</label><input type="number" step="0.1" value={f.min_margin_ref} onChange={set('min_margin_ref')} /></div>
          <div className="field"><label>Maximum gold per loop</label><input type="number" step="100" placeholder="no limit" value={f.max_gold} onChange={set('max_gold')} /></div>
          <div className="field"><label>Minimum margin per 1k gold</label><input type="number" step="0.01" placeholder="no limit" value={f.min_margin_per_1k_gold} onChange={set('min_margin_per_1k_gold')} /></div>
          <div className="field"><label>Minimum liquidity, in {ref}</label><input type="number" step="1" placeholder="no limit" value={f.min_liquidity_ref} onChange={set('min_liquidity_ref')} /></div>
          <div className="field"><label>Minimum velocity, {ref}/h per 1k gold</label><input type="number" step="0.01" placeholder="no limit" value={f.min_velocity} onChange={set('min_velocity')} /></div>
          <div className="field"><label>Minimum traded volume, {ref} per hour</label><input type="number" step="1" placeholder="no limit" value={f.min_volume_ref_per_h} onChange={set('min_volume_ref_per_h')} /></div>
          <div className="field"><label>Maximum estimated fill time, hours</label><input type="number" step="0.5" placeholder="no limit" value={f.max_fill_hours} onChange={set('max_fill_hours')} /></div>
          <label className="check"><input type="checkbox" checked={!!f.exclude_recipes} onChange={set('exclude_recipes')} /> Exchange steps only</label>
          <div className="field"><label>Show at most</label><input type="number" value={f.limit} onChange={set('limit')} /></div>
        </details>

        <h2>Live quotes</h2>
        {!canLive ? (
          <p className="hint">Not connected — loops use hourly market data. Connect a trade session in Settings for real-time order books.</p>
        ) : (
          <>
            <button className="btn primary" onClick={refreshTop} disabled={liveBusy} style={{ width: '100%' }}>
              {liveBusy ? 'Fetching…' : `Refresh top ${liveN} loops now`}</button>
            <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={autoLive} onChange={e => setAutoLive(e.target.checked)} /> Keep fresh (every 2 min)</label>
          </>
        )}
        {rl && (
          <details className="adv">
            <summary>Fetch status</summary>
            <p className="hint">
              Exchange budget: {rl.policies.trade.rates.map(r => `${r.limit}/${r.window_s}s`).join(', ')}
              {rl.policies.trade.penalty_remaining_s > 0 && <span className="loss"> · holding {Math.ceil(rl.policies.trade.penalty_remaining_s)}s</span>}
              <br />queue {rl.queue.queue}{rl.queue.in_flight ? ` · fetching ${rl.queue.in_flight}` : ''} · {rl.policies.trade.requests} requests this run
            </p>
          </details>
        )}
      </aside>

      <section className="main">
        {err && <div className="notice error">Couldn't load routes: {err}</div>}
        {note && <div className="notice">{note}</div>}
        {backfilling && (
          <div className="notice">Market history is still syncing ({fmt.n(status.digest.behind_h, 0)}h behind). Loops fill in as rates land — no action needed.</div>
        )}
        {meta?.notional && (
          <div className="notice">No capital entered yet, so loops are sized to a notional 10 {ref} from every currency.
            Enter what you hold on the left to size them to your stash.</div>
        )}
        <div className="legend">
          <span><i className="k live" /> live order book</span>
          <span><i className="k digest" /> hourly market data</span>
          <span><i className="k recipe" /> recipe hop: <b className="recipe-glyph">⊖</b> disenchant · <b className="recipe-glyph">⊕</b> combine — no gold</span>
          <span className="spacer" />
          {streaming && <span className="streaming">searching… {routes.length} found</span>}
          {!streaming && counts && <span>{counts.total_after_filters ?? routes.length} of {counts.total_candidates} loops pass{counts.truncated ? ' (search capped)' : ''}</span>}
          {meta && <span>· {meta.graph.edges.live} live / {meta.graph.edges.digest} digest / {meta.graph.edges.recipe} recipe edges</span>}
        </div>

        {!streaming && routes.length === 0 ? (
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
                <th>Loop</th>
                {COLS.map(([key, label, , defDir, title]) => (
                  <th key={key} className={`num sortable ${sort.key === key ? 'sorted' : ''}`} title={title || `Sort by ${label}`}
                    onClick={() => clickSort(key, defDir)}>
                    {label}{sort.key === key ? (sort.dir === 'desc' ? ' ▾' : ' ▴') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map(r => (
                <React.Fragment key={r.id}>
                  <tr className="route" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <td className="loop-cell"><Loop r={r} /></td>
                    <td className="num">{r.score == null ? <span className="muted">–</span> : r.score.toFixed(3)}</td>
                    <td className="num">{fmt.n(r.start_amount)} <Cur id={r.start} size={16} /></td>
                    <td className={`num ${r.margin >= 0 ? 'gain' : 'loss'}`}>{r.margin >= 0 ? '+' : ''}{fmt.n(r.margin)}</td>
                    <td className={`num ${r.margin >= 0 ? 'gain' : 'loss'}`}>{fmt.pct(r.margin_pct)}</td>
                    <td className="num">{fmt.n(r.margin_ref, 2)}</td>
                    <td className="num">{r.gold_free ? <span className="muted">free</span> : fmt.n(r.gold)}</td>
                    <td className="num mpg">
                      {r.velocity_inf ? <span className="gain">∞</span> : r.velocity == null ? <span className="muted">–</span> : (
                        <>
                          <span className="gold-bar" style={{ width: `${Math.max(2, Math.min(60, 60 * (r.velocity || 0) / maxVel))}px` }} />
                          {fmt.n(r.velocity, 3)}
                        </>
                      )}
                    </td>
                    <td className="num">{r.liquidity_ref == null ? <span className="muted">∞</span> : fmt.n(r.liquidity_ref, 0)}</td>
                    <td className="num">{r.volume_ref_per_h == null ? <span className="muted">–</span> : fmt.n(r.volume_ref_per_h, 0)}</td>
                    <td className={`num ${r.fill_hours != null && r.fill_hours > 4 ? 'muted' : ''}`}>{hrs(r.fill_hours)}</td>
                    <td className="num muted">{fmt.age(r.max_age_s)}</td>
                  </tr>
                  {open === r.id && <tr><td colSpan={12} style={{ padding: 0 }}><Detail r={r} refCur={ref} onRefresh={refreshOne} refreshing={refreshingId === r.id} canLive={canLive} /></td></tr>}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
