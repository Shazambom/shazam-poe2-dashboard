import React, { useEffect, useMemo, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from 'recharts'
import { api, fmt } from '../lib/api.js'

// Fixed categorical hues (assigned in order, never cycled) — distinct in the app's
// dark theme. Identity is carried by the legend, never colour alone.
const SERIES = ['#7fb4d9', '#6fb98f', '#c9a24a', '#b39ddb', '#d2705f', '#5fc8c0', '#e0b866', '#9aa0b5']
const day = (h) => new Date(h * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' })

export default function InflationView({ league }) {
  const [anchor, setAnchor] = useState('hinekora')
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(true)

  useEffect(() => {
    setBusy(true)
    api.inflation(anchor).then(d => { setData(d); setErr(null) }).catch(e => setErr(String(e.message || e))).finally(() => setBusy(false))
  }, [anchor, league])

  // Merge per-currency point arrays into one row-per-hour dataset for the chart.
  const { rows, keys } = useMemo(() => {
    const byHour = new Map()
    const ks = []
    for (const cur of data?.currencies ?? []) {
      ks.push({ id: cur.id, name: cur.name })
      for (const p of cur.points) {
        const row = byHour.get(p.t) || { t: p.t }
        row[cur.id] = p.v
        byHour.set(p.t, row)
      }
    }
    return { rows: [...byHour.values()].sort((a, b) => a.t - b.t), keys: ks }
  }, [data])

  const b = data?.basket
  const vel = b?.velocity_pct_per_day
  const anchors = data?.anchors ?? [{ id: 'hinekora', name: "Hinekora's Lock" }, { id: 'mirror', name: 'Mirror of Kalandra' }, { id: 'divine', name: 'Divine Orb' }]

  return (
    <div className="single infl">
      <div className="board-bar">
        <h2 style={{ margin: 0 }}>Inflation <span className="muted" style={{ fontWeight: 400 }}>· soft currencies priced in a hard asset, indexed to 100 at league start</span></h2>
        <span className="spacer" />
        <label className="hint">Hard-asset anchor&nbsp;
          <select value={anchor} onChange={e => setAnchor(e.target.value)}>
            {anchors.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
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
                <XAxis dataKey="t" tickFormatter={day} tick={{ fill: '#8f95a5', fontSize: 11 }} minTickGap={48} />
                <YAxis domain={['auto', 'auto']} tick={{ fill: '#8f95a5', fontSize: 11 }} width={44} tickFormatter={v => v.toFixed(0)} />
                <Tooltip contentStyle={{ background: '#20232c', border: '1px solid #464b5c', fontSize: 12 }}
                  labelFormatter={day} formatter={(v, id) => [v?.toFixed?.(1), keys.find(k => k.id === id)?.name || id]} />
                <ReferenceLine y={100} stroke="#464b5c" strokeDasharray="3 3" />
                <Legend wrapperStyle={{ fontSize: 12 }} formatter={(id) => keys.find(k => k.id === id)?.name || id} />
                {keys.map((k, i) => (
                  <Line key={k.id} type="monotone" dataKey={k.id} stroke={SERIES[i % SERIES.length]}
                    dot={false} strokeWidth={1.8} isAnimationActive={false} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
      </div>

      <div className="infl-table">
        <table>
          <thead><tr><th>Currency</th><th className="num">Index now</th><th className="num">Inflation since start</th><th className="num">Hours</th></tr></thead>
          <tbody>
            {(data?.currencies ?? []).map((cur, i) => (
              <tr key={cur.id}>
                <td><span className="dot-key" style={{ background: SERIES[i % SERIES.length] }} /> {cur.name}</td>
                <td className="num">{cur.current}</td>
                <td className={`num ${cur.since_base_pct >= 0 ? 'loss' : 'gain'}`}>{fmt.pct(cur.since_base_pct)}</td>
                <td className="num muted">{cur.coverage}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="hint" style={{ marginTop: 14 }}>
        Rising index = the currency buys less {data?.anchor_name} than at the start of captured data — i.e. it's inflating.
        {data?.base_note ? ` ${data.base_note[0].toUpperCase()}${data.base_note.slice(1)}.` : ''}
        {' '}Mirror and Hinekora trade thinly, so their lines have gaps; Divine is the densest anchor.
        {' '}Cross-league age-aligned comparison needs historical backfill from an economy archive — not built yet.
      </p>
    </div>
  )
}
