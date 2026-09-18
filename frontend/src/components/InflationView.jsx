import React, { useMemo, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Legend, CartesianGrid } from 'recharts'
import { api, fmt } from '../lib/api.js'
import { useApi } from '../lib/hooks.js'
import { series as SERIES, chart } from '../theme.js'
import Cur from './Cur.jsx'
import CurrencyPicker from './CurrencyPicker.jsx'
import Toggle from './Toggle.jsx'

// Categorical hues + chart chrome come from the shared theme (single source of truth,
// enforced by `npm run lint:style`). SERIES is validated colorblind-safe — see theme.js.
const AXIS = { fill: chart.axis, fontSize: 11 }
const GRID = chart.grid
const CURSOR = { stroke: chart.cursor, strokeWidth: 1, strokeDasharray: '3 3', strokeOpacity: 0.5 }
const day = fmt.hourLabel

// Dark, elevated tooltip: rows sorted by value, each with its series dot — reads like
// the rest of the app instead of Recharts' default white box.
function ChartTooltip({ active, payload, label, labelFmt, valueFmt, nameFmt }) {
  if (!active || !payload || !payload.length) return null
  const rows = payload.filter(p => p.value != null).sort((a, b) => b.value - a.value)
  return (
    <div className="chart-tip">
      <div className="chart-tip-label">{labelFmt ? labelFmt(label) : label}</div>
      {rows.map(p => (
        <div key={p.dataKey} className="chart-tip-row">
          <span className="chart-tip-dot" style={{ background: p.color }} />
          <span className="chart-tip-name">{nameFmt ? nameFmt(p.dataKey) : p.name}</span>
          <span className="chart-tip-val">{valueFmt ? valueFmt(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  )
}

// Fold a list of series (each {points:[...]}) into row-per-x objects for Recharts.
// meta(series) -> {id, ...} identifies the line; optional filter(point) drops points.
function mergeSeries(list, { x, val, meta, filter }) {
  const byX = new Map()
  const keys = []
  for (const s of list) {
    const m = meta(s)
    keys.push(m)
    for (const p of s.points) {
      if (filter && !filter(p)) continue
      const row = byX.get(p[x]) || { [x]: p[x] }
      row[m.id] = p[val]
      byX.set(p[x], row)
    }
  }
  return { rows: [...byX.values()].sort((a, b) => a[x] - b[x]), keys }
}

// The two age-aligned multi-league charts (cross-league inflation + economy size)
// are the same chart bar the y-scale and reference line; one component serves both.
function LeagueAgeChart({ rows, keys, scale, refLine, valueFmt }) {
  return (
    <ResponsiveContainer>
      <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="age" type="number" domain={['dataMin', 'dataMax']} tick={AXIS} axisLine={{ stroke: GRID }} tickLine={false}
          tickFormatter={d => `d${d}`} label={{ value: 'day of league', position: 'insideBottom', offset: -2, ...AXIS }} />
        <YAxis scale={scale || 'auto'} domain={['auto', 'auto']} tick={AXIS} width={54} axisLine={false} tickLine={false} tickFormatter={v => fmt.n(v, 0)} />
        <Tooltip cursor={CURSOR} content={<ChartTooltip labelFmt={d => `day ${d}`} valueFmt={v => fmt.n(v, 0)} />} />
        {refLine != null && <ReferenceLine y={refLine} stroke={chart.refLine} strokeDasharray="3 3" />}
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {keys.map((k, i) => (
          <Line key={k.id} type="monotone" dataKey={k.id} name={k.id + (k.current ? ' (current)' : '')}
            stroke={SERIES[i % SERIES.length]} strokeWidth={k.current ? 2.8 : 1.4}
            dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--panel)' }} isAnimationActive={false} connectNulls />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

export default function InflationView({ league }) {
  const [anchor, setAnchor] = useState('lock')
  const [hidden, setHidden] = useState(() => new Set())   // currencies toggled off the inflation graph only
  const toggleCur = (id) => setHidden(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const { data, err, busy } = useApi(() => api.inflation(anchor), [anchor, league])

  const { rows, keys } = useMemo(() =>
    mergeSeries(data?.currencies ?? [], { x: 't', val: 'v', meta: c => ({ id: c.id, name: c.name }) }), [data])
  const nameOf = (id) => keys.find(k => k.id === id)?.name || id

  const b = data?.basket
  const vel = b?.velocity_pct_per_day
  const anchors = data?.anchors ?? []   // the backend's anchor table (see /api/currencies)

  return (
    <div className="single infl">
      <div className="board-bar">
        <h2 style={{ margin: 0 }}>Inflation <span className="muted" style={{ fontWeight: 400 }}>· soft currencies priced in a hard asset, indexed to 100 at league start</span></h2>
        <span className="spacer" />
        <label className="hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>Hard-asset anchor
          <CurrencyPicker value={anchor} onChange={setAnchor} options={anchors} placeholder="anchor…" />
        </label>
      </div>

      {err && <div className="notice error">{err}</div>}

      {b && (
        <div className="infl-stats">
          <div className="stat">
            <div className="stat-label">Basket inflation vs {data.anchor_name}</div>
            <div className={`stat-val ${(b.since_base_pct ?? 0) >= 0 ? 'loss' : 'gain'}`}>{b.since_base_pct == null ? '–' : fmt.pct(b.since_base_pct)}</div>
            <div className="stat-sub">since data start</div>
          </div>
          <div className="stat">
            <div className="stat-label">Inflation velocity</div>
            <div className={`stat-val ${(vel ?? 0) >= 0 ? 'loss' : 'gain'}`}>{vel == null ? '–' : `${vel >= 0 ? '+' : ''}${vel}%/day`}</div>
            <div className="stat-sub">last 24h trend — rising = dump soft, hold hard</div>
          </div>
          <div className="stat">
            <div className="stat-label">Last 24h</div>
            <div className={`stat-val ${(b.change_24h_pct ?? 0) >= 0 ? 'loss' : 'gain'}`}>{b.change_24h_pct == null ? '–' : fmt.pct(b.change_24h_pct)}</div>
            <div className="stat-sub">{data.hours_covered}h of data</div>
          </div>
        </div>
      )}

      <div className="chart-box" style={{ height: 360 }}>
        {busy && !data ? <div className="empty">Loading…</div>
          : rows.length < 2 ? <div className="empty">Not enough {data?.anchor_name} trades captured yet to chart inflation. Try the Divine anchor (denser), or let more hours accrue.</div>
          : (
            <ResponsiveContainer>
              <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="t" tickFormatter={day} tick={AXIS} minTickGap={48} axisLine={{ stroke: GRID }} tickLine={false} />
                <YAxis domain={['auto', 'auto']} tick={AXIS} width={44} axisLine={false} tickLine={false} tickFormatter={v => v.toFixed(0)} />
                <Tooltip cursor={CURSOR} content={<ChartTooltip labelFmt={day} valueFmt={v => v.toFixed(1)} nameFmt={nameOf} />} />
                <ReferenceLine y={100} stroke={chart.refLine} strokeDasharray="3 3" label={{ value: 'league start', position: 'insideTopRight', fill: chart.axis, fontSize: 10 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} formatter={nameOf} />
                {keys.map((k, i) => hidden.has(k.id) ? null : (
                  <Line key={k.id} type="monotone" dataKey={k.id} stroke={SERIES[i % SERIES.length]}
                    dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--panel)' }} strokeWidth={1.8} isAnimationActive={false} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
      </div>

      <div className="infl-table">
        <table>
          <thead><tr><th title="Show this currency's line in the graph above">Graph</th><th>Currency</th><th className="num">Index now</th><th className="num">Inflation since start</th><th className="num">Hours</th></tr></thead>
          <tbody>
            {(data?.currencies ?? []).map((cur, i) => {
              const on = !hidden.has(cur.id)
              return (
                <tr key={cur.id} style={{ opacity: on ? 1 : 0.45 }}>
                  <td><Toggle checked={on} onChange={() => toggleCur(cur.id)} title={`${on ? 'Hide' : 'Show'} ${cur.name} in the graph`} /></td>
                  <td><span className="dot-key" style={{ background: SERIES[i % SERIES.length] }} /> <Cur name={cur.name} text /></td>
                  <td className="num">{cur.current}</td>
                  <td className={`num ${cur.since_base_pct >= 0 ? 'loss' : 'gain'}`}>{fmt.pct(cur.since_base_pct)}</td>
                  <td className="num muted">{cur.coverage}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>


      <CrossLeague league={league} />
      <MarketCap league={league} />
    </div>
  )
}

// Economy market cap: total value TRADED per day across all currencies, in Mirrors
// (Σ volume × price ÷ mirror price). Traded throughput, not supply — labelled as such.
// Which league to highlight/stat across the cross-league charts: the user's SELECTED league if it
// has data, else the newest-STARTED still-active league, else the newest overall. The backend can
// flag several leagues 'current' at once (a lingering old league alongside the new one, both crawled
// to today), so we can't take the first current — that showed a dead league's 0-mir/day stats — nor
// the most-recent last-day (concurrent live leagues tie). The active challenge league is the one that
// began most recently, i.e. the latest day-0. `day` is a sortable YYYY-MM-DD string.
function firstDay(l) { const p = l.points; return (p && p.length) ? (p[0].day || '') : '' }
function pickLeague(leagues, selected) {
  if (!leagues || !leagues.length) return null
  const newestStart = (a, b) => (firstDay(b) < firstDay(a) ? -1 : firstDay(b) > firstDay(a) ? 1 : 0)
  return leagues.find(l => l.league === selected)
    || leagues.filter(l => l.current).slice().sort(newestStart)[0]
    || leagues.slice().sort(newestStart)[0]
}

// The most recent day present anywhere is TODAY's in-progress crawl — a partial day whose throughput
// is a fraction of a full day's, which made "traded today" read ~0 and the current league's line
// plunge at the right edge. Drop it (and recompute each league's latest/total/days from the trimmed
// series). Ended leagues don't have today, so they're untouched.
function trimPartialDay(leagues) {
  if (!leagues || !leagues.length) return leagues
  const today = leagues.reduce((m, l) => {
    const d = l.points?.length ? l.points[l.points.length - 1].day : ''
    return d > m ? d : m
  }, '')
  return leagues.map(l => {
    const points = (l.points || []).filter(p => p.day !== today)
    if (!points.length) return { ...l, points }
    const last = points[points.length - 1]
    return { ...l, points, latest_mirrors: last.mirrors, total_mirrors: last.cum, days: last.age + 1 }
  }).filter(l => l.points.length)
}

function MarketCap({ league }) {
  const { data, err, busy } = useApi(() => api.inflationMarketcap(), [])

  const leagues = useMemo(() => trimPartialDay(data?.leagues ?? []), [data])
  const cur = useMemo(() => pickLeague(leagues, league), [leagues, league])
  const { rows, keys } = useMemo(() =>   // log scale needs positive values; bold the selected league
    mergeSeries(leagues, { x: 'age', val: 'mirrors', meta: lg => ({ id: lg.league, current: lg.league === cur?.league }), filter: p => p.mirrors > 0 }), [leagues, cur])

  return (
    <div style={{ marginTop: 28 }}>
      <h2 style={{ margin: 0 }}>Economy size <span className="muted" style={{ fontWeight: 400 }}>· total value traded per day, in Mirrors (all currencies), aligned by day-of-league</span></h2>
      {err && <div className="notice error">{err}</div>}
      {data?.building && <div className="notice" style={{ marginTop: 10 }}>Building economy history from poe2scout — check back in a minute.</div>}
      {cur && (
        <div className="infl-stats" style={{ marginTop: 12 }}>
          <div className="stat">
            <div className="stat-label">{cur.league} — traded today</div>
            <div className="stat-val">{fmt.n(cur.latest_mirrors, 0)}<span className="pt-unit"> mir/day</span></div>
            <div className="stat-sub">value changing hands per day</div>
          </div>
          <div className="stat">
            <div className="stat-label">{cur.league} — traded so far</div>
            <div className="stat-val">{fmt.n(cur.total_mirrors, 0)}<span className="pt-unit"> mir</span></div>
            <div className="stat-sub">cumulative over {cur.days} days</div>
          </div>
        </div>
      )}
      <div className="chart-box" style={{ height: 320, marginTop: 12 }}>
        {busy && !data ? <div className="empty">Loading…</div>
          : rows.length < 2 ? <div className="empty">Economy history is still building — check back shortly.</div>
          : <LeagueAgeChart rows={rows} keys={keys} scale="log" valueFmt={(v) => [`${fmt.n(v, 0)} mir/day`]} />}
      </div>
    </div>
  )
}

// Cross-league inflation: Divine-in-Exalted per league, each rebased to its own
// day-0 = 100 and plotted by day-of-league, so the current league's inflation can
// be read against past leagues at the same age. Data via poe2scout history.
function CrossLeague({ league }) {
  const [item, setItem] = useState(291)   // Divine (densest, all leagues) by default
  const { data, err, busy } = useApi(() => api.inflationCross(item), [item])
  const items = data?.items ?? []

  const leagues = data?.leagues ?? []
  const cur = useMemo(() => pickLeague(leagues, league), [leagues, league])
  const { rows, keys } = useMemo(() =>   // bold the selected league (else freshest active), not an arbitrary current
    mergeSeries(leagues, { x: 'age', val: 'index', meta: lg => ({ id: lg.league, current: lg.league === cur?.league }) }), [leagues, cur])

  return (
    <div style={{ marginTop: 28 }}>
      <div className="board-bar">
        <h2 style={{ margin: 0 }}>Across leagues <span className="muted" style={{ fontWeight: 400 }}>· {data?.item_name || 'Divine'} priced in Exalted, each league rebased to day-0 = 100 and aligned by day-of-league</span></h2>
        <span className="spacer" />
        <label className="hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>Anchor
          <CurrencyPicker value={item} onChange={setItem} options={items} placeholder="anchor…" />
        </label>
      </div>
      {err && <div className="notice error">{err}</div>}
      <div className="chart-box" style={{ height: 340 }}>
        {busy && !data ? <div className="empty">Loading past-league history…</div>
          : rows.length < 2 ? <div className="empty">No cross-league history yet.</div>
          : <LeagueAgeChart rows={rows} keys={keys} refLine={100} />}
      </div>
    </div>
  )
}
