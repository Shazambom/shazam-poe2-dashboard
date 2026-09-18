import React from 'react'
import { api } from '../lib/api.js'
import { useApi } from '../lib/hooks.js'

// Phase 3 — the league-arc overlay inside CardDetail: the item's price history so far ('you are
// here at day N'), a forward projected band, and buy/sell window chips, DTW-weighted toward the
// past league the current run resembles. Priced in Divine (the app's held-value numeraire). Reads
// /api/arc; renders nothing when there's no projection (young data / no history) so it's additive.

// The arc chart: solid history (colored by direction, matching Spark) → dashed gold projection with
// a shaded dispersion band, and a 'you are here' marker at the current league-day. Self-contained
// geometry (no shared-layout math), themed via tokens.
function ArcSpark({ history, arc, w = 560, h = 150 }) {
  const cur = history[history.length - 1]
  const curPrice = cur.price
  const proj = arc.map(a => ({
    age: a.age,
    mid: curPrice * (1 + a.pred_pct / 100),
    lo: curPrice * (1 + a.lo_pct / 100),
    hi: curPrice * (1 + a.hi_pct / 100),
  }))
  const xs = [...history.map(p => p.age), ...proj.map(p => p.age)]
  const ys = [...history.map(p => p.price), ...proj.flatMap(p => [p.lo, p.hi, p.mid])]
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
  const pad = 6
  const sx = a => pad + (x1 === x0 ? 0 : (a - x0) / (x1 - x0)) * (w - 2 * pad)
  const sy = v => (h - pad) - (y1 === y0 ? 0.5 : (v - y0) / (y1 - y0)) * (h - 2 * pad)
  const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.age).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' ')

  const hist = path(history.map(p => ({ age: p.age, v: p.price })))
  const mid = path([{ age: cur.age, v: curPrice }, ...proj.map(p => ({ age: p.age, v: p.mid }))])
  const band = path([{ age: cur.age, v: curPrice }, ...proj.map(p => ({ age: p.age, v: p.hi })),
    ...proj.map(p => ({ age: p.age, v: p.lo })).reverse()]) + ' Z'
  const up = history[history.length - 1].price >= history[0].price
  const hcol = up ? 'var(--gain)' : 'var(--loss)'
  const mx = sx(cur.age)

  return (
    <svg className="arc-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"
      aria-hidden="true" style={{ width: '100%' }}>
      <path d={band} fill="var(--gold)" opacity="0.13" />
      <path d={hist} fill="none" stroke={hcol} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <path d={mid} fill="none" stroke="var(--gold)" strokeWidth="2" strokeDasharray="4 3"
        strokeLinejoin="round" strokeLinecap="round" />
      <line x1={mx} y1={pad} x2={mx} y2={h - pad} stroke="var(--line-strong)" strokeWidth="1" strokeDasharray="2 3" />
      <circle cx={mx} cy={sy(curPrice)} r="3.5" fill="var(--gold)" />
    </svg>
  )
}

export default function LeagueArcSection({ name }) {
  const { data: arc } = useApi(() => api.arc(name, 'divine'), [name])
  if (!arc || !(arc.arc && arc.arc.length) || !(arc.history && arc.history.length >= 2)) return null

  const windows = arc.windows || []
  return (
    <>
      <div className="cd-section" title="Daily poe2scout closes (item ÷ numeraire), aligned by day-of-league">League arc
        <span className="muted" style={{ fontWeight: 400 }}>
          {' · '}day {arc.cur_age}{arc.numeraire !== 'divine' ? ` · in ${arc.numeraire_name}` : ''}{arc.weighted && arc.resembles ? ` · resembles ${arc.resembles}` : ''}
        </span>
      </div>
      <div className="cd-arc"><ArcSpark history={arc.history} arc={arc.arc} /></div>
      <div className="cd-chips">
        {windows.length === 0 && <span className="cd-chip muted">no clear buy/sell window ahead</span>}
        {windows.map(wd => (
          <span key={wd.kind} className={`arc-win ${wd.kind}`}
            title={wd.kind === 'buy' ? 'projected trough — a good time to buy' : 'projected peak — a good time to sell'}>
            {wd.kind} · day {wd.age} <b>{wd.ret_pct >= 0 ? '+' : ''}{wd.ret_pct}%</b>
          </span>
        ))}
        {!arc.weighted && (
          <span className="cd-chip muted" title="league-similarity weights unavailable — projecting from recency">
            recency
          </span>
        )}
      </div>
    </>
  )
}
