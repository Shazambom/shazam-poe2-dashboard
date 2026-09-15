import React, { useEffect, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts'
import { api, fmt } from '../lib/api.js'
import { color, chart } from '../theme.js'
import Cur from './Cur.jsx'

const AXIS = { fill: chart.axis, fontSize: 11 }
const TIP = { background: chart.tooltipBg, border: `1px solid ${chart.tooltipBorder}` }
const hourLabel = (h) => new Date(h * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' })

export default function MarketView({ currencies }) {
  const [edges, setEdges] = useState([])
  const [top, setTop] = useState([])
  const [pair, setPair] = useState({ a: 'divine', b: 'exalted' })
  const [hist, setHist] = useState(null)
  const [q, setQ] = useState('')

  useEffect(() => {
    api.edges().then(setEdges).catch(console.error)
    api.topMarkets().then(setTop).catch(console.error)
  }, [])
  useEffect(() => { api.history(pair.a, pair.b).then(setHist).catch(console.error) }, [pair])

  const names = Object.fromEntries((currencies?.currencies ?? []).map(c => [c.id, c.name]))
  const list = (currencies?.currencies ?? []).map(c => c.id)
  const shown = edges.filter(e => !q || `${e.from_name} ${e.to_name} ${e.from} ${e.to}`.toLowerCase().includes(q.toLowerCase()))
  const digestSeries = (hist?.digest ?? []).map(p => ({ t: hourLabel(p.hour), rate: p.rate, vol: p.volume_a }))
  const liveSeries = (hist?.live ?? []).map(p => ({ t: hourLabel(p.fetched_at), rate: p.best_rate, stock: p.best_stock }))

  return (
    <div className="single">
      <div className="two-col">
        <div>
          <h2>Pair history</h2>
          <div className="row" style={{ marginBottom: 10 }}>
            <select value={pair.a} onChange={e => setPair(p => ({ ...p, a: e.target.value }))} className="btn">
              {list.map(c => <option key={c} value={c}>{names[c]}</option>)}
            </select>
            <span className="muted">priced in</span>
            <select value={pair.b} onChange={e => setPair(p => ({ ...p, b: e.target.value }))} className="btn">
              {list.map(c => <option key={c} value={c}>{names[c]}</option>)}
            </select>
          </div>
          <div className="chart-box">
            {digestSeries.length === 0 && liveSeries.length === 0 ? (
              <div className="empty">No history for this pair yet. The hourly digest fills in as it syncs; live points appear once the order-book sweep has run.</div>
            ) : (
              <ResponsiveContainer>
                <LineChart data={digestSeries.length ? digestSeries : liveSeries}>
                  <XAxis dataKey="t" tick={AXIS} minTickGap={40} />
                  <YAxis domain={['auto', 'auto']} tick={AXIS} width={60} tickFormatter={fmt.rate} />
                  <Tooltip contentStyle={TIP} formatter={(v) => fmt.rate(v)} />
                  <Line type="monotone" dataKey="rate" stroke={color.digest} dot={false} strokeWidth={1.5} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
          <p className="hint">Digest rate is executed volume of {names[pair.b] ?? pair.b} divided by executed volume of {names[pair.a] ?? pair.a} for the hour, i.e. the cleared VWAP.</p>
          {digestSeries.length > 0 && (
            <div className="chart-box" style={{ height: 140, marginTop: 10 }}>
              <ResponsiveContainer>
                <BarChart data={digestSeries}>
                  <XAxis dataKey="t" hide />
                  <YAxis tick={AXIS} width={60} />
                  <Tooltip contentStyle={TIP} />
                  <Bar dataKey="vol" fill={color.goldDim} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div>
          <h2>Busiest markets, last 24h</h2>
          {top.length === 0 ? <p className="hint">Nothing yet — the digest hasn't synced for this league.</p> : (
            <table>
              <thead><tr><th>Market</th><th className="num">Volume</th><th className="num">Hours active</th></tr></thead>
              <tbody>
                {top.slice(0, 15).map((m, i) => (
                  <tr key={i} style={{ cursor: 'pointer' }} onClick={() => setPair({ a: m.a, b: m.b })}>
                    <td><Cur id={m.a} name={names[m.a]} /> / <Cur id={m.b} name={names[m.b]} /></td>
                    <td className="num">{fmt.n(m.volume_a)} / {fmt.n(m.volume_b)}</td>
                    <td className="num">{m.hours_active}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <h2 style={{ marginTop: 28 }}>Edges in the current graph</h2>
      <div className="row" style={{ marginBottom: 8 }}>
        <input className="btn" placeholder="Filter by currency" value={q} onChange={e => setQ(e.target.value)} style={{ width: 240 }} />
        <span className="hint">{shown.length} edges</span>
      </div>
      <table>
        <thead><tr><th>From</th><th>To</th><th>Source</th><th className="num">Rate</th><th className="num">Depth</th><th className="num">Capacity (from units)</th><th className="num">Age</th></tr></thead>
        <tbody>
          {shown.map((e, i) => (
            <tr key={i}>
              <td><Cur id={e.from} name={e.from_name} /></td><td><Cur id={e.to} name={e.to_name} /></td>
              <td><i className={`k ${e.kind}`} style={{ display: 'inline-block', marginRight: 6 }} />{e.kind}{e.kind === 'recipe' && <span className="muted"> {e.meta?.name}</span>}</td>
              <td className="num">{fmt.rate(e.rate)}</td>
              <td className="num">{e.depth}</td>
              <td className="num">{e.capacity_in == null ? '∞' : fmt.n(e.capacity_in)}</td>
              <td className="num muted">{fmt.age(e.age_s)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
