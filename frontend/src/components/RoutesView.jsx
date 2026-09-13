import React, { useEffect, useMemo, useState } from 'react'
import { api, fmt } from '../lib/api.js'

const SORTS = [
  ['score', 'Overall (velocity-led blend)'],
  ['velocity', 'Velocity: margin ÷ (fill time × gold)'],
  ['margin_per_1k_gold', 'Margin per 1k gold'],
  ['margin_ref', 'Margin (value)'],
  ['margin_pct', 'Margin %'],
  ['value_ref', 'Value traded'],
  ['gold', 'Gold cost'],
  ['liquidity_ref', 'Liquidity'],
  ['volume_ref_per_h', 'Traded volume per hour'],
  ['fill_hours', 'Fastest fill estimate'],
]
const hrs = (h) => h == null ? '–' : h < 1 / 60 ? '<1m' : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`

const DEFAULT_FILTERS = {
  min_margin_pct: 0.5, min_margin_ref: 0, max_gold: '', min_margin_per_1k_gold: '',
  min_liquidity_ref: '', min_volume_ref_per_h: '', max_fill_hours: '', min_velocity: '', live_only: false, exclude_recipes: false, sort: 'score', limit: 100, start: '',
}

function Loop({ r }) {
  return (
    <span className="loop">
      {r.path_names.map((n, i) => (
        <React.Fragment key={i}>
          {i > 0 && (
            <span className="hop" title={`${r.kinds[i - 1]} · ${fmt.rate(r.steps[i - 1].rate)} per unit`}>
              <i className={`k ${r.kinds[i - 1]}`} />{fmt.rate(r.steps[i - 1].rate)}
            </span>
          )}
          <span className="node">{n}</span>
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
        <span>Commit <b>{fmt.n(r.start_amount)}</b> {r.start_name}, hold {fmt.n(r.capital_held)}</span>
        <span>· ends with <b>{fmt.n(r.end_amount)}</b></span>
        <span>· value through loop {fmt.n(r.value_ref, 1)} {refCur}</span>
        <span>· oldest quote {fmt.age(r.max_age_s)}</span>
        {r.profit_per_hour != null && <span>· earns {fmt.n(r.profit_per_hour, 2)} {refCur}/h</span>}
        {r.score != null && <span>· score {r.score} (velocity {r.score_parts.velocity}, efficiency {r.score_parts.efficiency}, value {r.score_parts.value}, volume {r.score_parts.volume})</span>}
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
                <td>{s.from_name} to {s.to_name}</td>
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

export default function RoutesView({ capital, status }) {
  const [f, setF] = useState(DEFAULT_FILTERS)
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(null)
  const [auto, setAuto] = useState(true)
  const [liveN, setLiveN] = useState(5)
  const [autoLive, setAutoLive] = useState(false)
  const [liveBusy, setLiveBusy] = useState(false)
  const [refreshingId, setRefreshingId] = useState(null)
  const [note, setNote] = useState(null)
  const [rl, setRl] = useState(null)
  const canLive = !!status?.session?.connected

  const load = async () => {
    setBusy(true)
    try { setData(await api.routes(f)); setErr(null) } catch (e) { setErr(String(e.message || e)) }
    setBusy(false)
  }
  useEffect(() => { api.settings().then(s => { const f = { ...s.filters }; ['max_gold','min_margin_per_1k_gold','min_liquidity_ref','min_volume_ref_per_h','max_fill_hours','min_velocity'].forEach(k => { if (!f[k]) f[k] = '' }); setF(x => ({ ...x, ...f })); setLiveN(s.live_top_n ?? 5) }).catch(() => {}) }, [])
  useEffect(() => {
    const tick = () => api.rateLimits().then(setRl).catch(() => {})
    tick(); const t = setInterval(tick, 5000); return () => clearInterval(t)
  }, [])

  const refreshTop = async () => {
    if (!canLive || liveBusy) return
    setLiveBusy(true); setNote(null)
    try {
      const d = await api.refreshTop(f, Number(liveN))
      setData(d)
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
      setData(x => ({ ...x, routes: d.routes }))
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
  }, [autoLive, canLive, f, liveN]) // eslint-disable-line
  useEffect(() => { load() }, [f]) // eslint-disable-line
  useEffect(() => {
    if (!auto) return
    const t = setInterval(load, 60000)
    return () => clearInterval(t)
  }, [auto, f]) // eslint-disable-line

  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const ref = data?.reference ?? capital?.reference ?? 'ref'
  const maxVel = useMemo(() => Math.max(1e-9, ...(data?.routes ?? []).map(r => r.velocity_inf ? 0 : (r.velocity || 0))), [data])
  const held = Object.keys(data?.capital ?? {})

  return (
    <div className="workspace">
      <aside className="rail">
        <h2>Thresholds</h2>
        <div className="field"><label>Minimum margin %</label><input type="number" step="0.1" value={f.min_margin_pct} onChange={set('min_margin_pct')} /></div>
        <div className="field"><label>Minimum margin, in {ref}</label><input type="number" step="0.1" value={f.min_margin_ref} onChange={set('min_margin_ref')} /></div>
        <div className="field"><label>Maximum gold per loop</label><input type="number" step="100" placeholder="no limit" value={f.max_gold} onChange={set('max_gold')} /></div>
        <div className="field"><label>Minimum margin per 1k gold</label><input type="number" step="0.01" placeholder="no limit" value={f.min_margin_per_1k_gold} onChange={set('min_margin_per_1k_gold')} /></div>
        <div className="field"><label>Minimum liquidity, in {ref}</label><input type="number" step="1" placeholder="no limit" value={f.min_liquidity_ref} onChange={set('min_liquidity_ref')} /></div>
        <div className="field"><label>Minimum velocity, {ref}/h per 1k gold</label><input type="number" step="0.01" placeholder="no limit" value={f.min_velocity} onChange={set('min_velocity')} /></div>
        <div className="field"><label>Minimum traded volume, {ref} per hour</label><input type="number" step="1" placeholder="no limit" value={f.min_volume_ref_per_h} onChange={set('min_volume_ref_per_h')} /></div>
        <div className="field"><label>Maximum estimated fill time, hours</label><input type="number" step="0.5" placeholder="no limit" value={f.max_fill_hours} onChange={set('max_fill_hours')} /></div>
        <label className="check"><input type="checkbox" checked={!!f.live_only} onChange={set('live_only')} /> Live quotes only</label>
        <label className="check"><input type="checkbox" checked={!!f.exclude_recipes} onChange={set('exclude_recipes')} /> Exchange steps only</label>

        <h2>Ranking</h2>
        <div className="field"><label>Sort by</label>
          <select value={f.sort} onChange={set('sort')}>{SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </div>
        <div className="field"><label>Start from</label>
          <select value={f.start} onChange={set('start')}>
            <option value="">Everything I hold</option>
            {held.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="field"><label>Show at most</label><input type="number" value={f.limit} onChange={set('limit')} /></div>
        <label className="check"><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} /> Recalculate from cache every minute</label>
        <button className="btn" onClick={load} disabled={busy}>{busy ? 'Working' : 'Recalculate'}</button>

        <h2>Live quotes</h2>
        {!canLive ? <p className="hint">Connect a trade session in Settings to fetch live books. Until then loops use the hourly digest and cached quotes.</p> : (
          <>
            <p className="hint">Only the pairs behind the top loops are fetched, and only when older than the threshold in Settings. Pairs that want the same currency share one request.</p>
            <div className="field"><label>Refresh pairs behind the top</label><input type="number" min="1" max="50" value={liveN} onChange={e => setLiveN(e.target.value)} /></div>
            <label className="check"><input type="checkbox" checked={autoLive} onChange={e => setAutoLive(e.target.checked)} /> Do this every 2 minutes</label>
            <button className="btn primary" onClick={refreshTop} disabled={liveBusy}>{liveBusy ? 'Fetching…' : `Refresh top ${liveN} now`}</button>
          </>
        )}
        {rl && (
          <p className="hint" style={{ marginTop: 12 }}>
            Exchange budget: {rl.policies.trade.rates.map(r => `${r.limit}/${r.window_s}s`).join(', ')}
            {rl.policies.trade.advertised.length ? ' (from GGG headers, halved)' : ' (default until GGG reports)'}
            {rl.policies.trade.penalty_remaining_s > 0 && <span className="loss"> · holding {Math.ceil(rl.policies.trade.penalty_remaining_s)}s</span>}
            <br />queue {rl.queue.queue}{rl.queue.in_flight ? ` · fetching ${rl.queue.in_flight}` : ''} · {rl.policies.trade.requests} requests, {rl.policies.trade.throttled} holds this run
            {rl.queue.padded > 0 && <> · {rl.queue.padded} pairs came free via padding</>}
            {rl.pair_scores?.length > 0 && <><br />priority pairs: {rl.pair_scores.slice(0, 4).map(p => `${p.have}→${p.want}`).join(', ')}</>}
          </p>
        )}
      </aside>

      <section className="main">
        {err && <div className="notice error">Couldn't load routes: {err}</div>}
        {note && <div className="notice">{note}</div>}
        {data?.notional && (
          <div className="notice">No capital entered yet, so routes are sized to a notional 10 {ref} from every currency.
            Enter what you hold in the Capital tab to size loops to your stash.</div>
        )}
        <div className="legend">
          <span><i className="k live" /> live order book</span>
          <span><i className="k digest" /> hourly digest (executed VWAP)</span>
          <span><i className="k recipe" /> disenchant / combine, no gold</span>
          {data && <span className="spacer" />}
          {data && <span>{data.total_after_filters} of {data.total_candidates} loops pass · graph {data.graph.nodes} currencies,
            {' '}{data.graph.edges.live} live / {data.graph.edges.digest} digest / {data.graph.edges.recipe} recipe edges</span>}
        </div>

        {data && data.routes.length === 0 ? (
          <div className="empty">
            <b>No loop clears your thresholds.</b><br />
            {data.total_candidates === 0
              ? 'The graph has no cycles yet. Wait for the first digest sync or order-book sweep, or add currencies to the watchlist in Settings.'
              : 'Loosen a threshold on the left, or allow digest quotes and recipe steps.'}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Loop</th>
                <th className="num">Commit</th>
                <th className="num">Margin</th>
                <th className="num">Margin %</th>
                <th className="num">Margin in {ref}</th>
                <th className="num">Value in {ref}</th>
                <th className="num">Gold</th>
                <th className="num" title="margin ÷ (fill hours × gold) × 1000 — profit per hour per 1k gold">Velocity</th>
                <th className="num">Margin / 1k gold</th>
                <th className="num">Liquidity in {ref}</th>
                <th className="num" title="Slowest step's executed value per hour, from the hourly digest">Volume / h</th>
                <th className="num" title="Sum over steps of commit ÷ hourly turnover">Fill est.</th>
                <th className="num">Age</th>
              </tr>
            </thead>
            <tbody>
              {(data?.routes ?? []).map(r => (
                <React.Fragment key={r.id}>
                  <tr className="route" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <td className="loop-cell"><Loop r={r} /></td>
                    <td className="num">{fmt.n(r.start_amount)} {r.start}</td>
                    <td className={`num ${r.margin >= 0 ? 'gain' : 'loss'}`}>{r.margin >= 0 ? '+' : ''}{fmt.n(r.margin)}</td>
                    <td className={`num ${r.margin >= 0 ? 'gain' : 'loss'}`}>{fmt.pct(r.margin_pct)}</td>
                    <td className="num">{fmt.n(r.margin_ref, 2)}</td>
                    <td className="num">{fmt.n(r.value_ref, 1)}</td>
                    <td className="num">{r.gold_free ? <span className="muted">free</span> : fmt.n(r.gold)}</td>
                    <td className="num mpg">
                      {r.velocity_inf ? <span className="gain">∞</span> : r.velocity == null ? <span className="muted">–</span> : (
                        <>
                          <span className="gold-bar" style={{ width: `${Math.max(2, Math.min(60, 60 * (r.velocity || 0) / maxVel))}px` }} />
                          {fmt.n(r.velocity, 3)}
                        </>
                      )}
                    </td>
                    <td className="num mpg">
                      {r.gold_free ? <span className="gain">∞</span> : (
                        fmt.n(r.margin_per_1k_gold, 3)
                      )}
                    </td>
                    <td className="num">{r.liquidity_ref == null ? <span className="muted">∞</span> : fmt.n(r.liquidity_ref, 0)}</td>
                    <td className="num">{r.volume_ref_per_h == null ? <span className="muted">–</span> : fmt.n(r.volume_ref_per_h, 0)}</td>
                    <td className={`num ${r.fill_hours != null && r.fill_hours > 4 ? 'muted' : ''}`}>{hrs(r.fill_hours)}</td>
                    <td className="num muted">{fmt.age(r.max_age_s)}</td>
                  </tr>
                  {open === r.id && <tr><td colSpan={13} style={{ padding: 0 }}><Detail r={r} refCur={ref} onRefresh={refreshOne} refreshing={refreshingId === r.id} canLive={canLive} /></td></tr>}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
