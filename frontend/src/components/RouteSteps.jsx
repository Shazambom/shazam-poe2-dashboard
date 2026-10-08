import React from 'react'
import { fmt } from '../lib/api.js'
import Cur from './Cur.jsx'
import Wealth from './Wealth.jsx'

// Shared route-path renderers, extracted from RoutesView so the Convert tool renders a
// conversion exactly like an arbitrage loop (same visual vocabulary). `Loop` works for any
// route-shaped dict (loops AND open conversion paths): it reads path/path_names/kinds/steps.
const RECIPE_GLYPH = { disenchant: '⊖', combine: '⊕', reforge: '⟳', vendor: '⇄' }

export function Loop({ r }) {
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

// The expanded row is the trade list (first-contact audit, 2026-10-08): each step as a sentence a player would say,
// where it happens and what it costs. The engine's figures (score parts, quote ages, loop value) stay in the engine.
const stepText = (s) => {
  const amt = (n, id, name) => <><b>{fmt.n(n, 2)}</b> <Cur id={id} name={name} size={16} /></>
  if (s.kind === 'recipe') return <>{s.meta?.name || 'Recipe'}: {amt(s.in, s.from, s.from_name)} → {amt(s.out, s.to, s.to_name)}</>
  return <>Buy {amt(s.out, s.to, s.to_name)} with {amt(s.in, s.from, s.from_name)}</>
}

export function Detail({ r, refCur }) {
  return (
    <div className="detail">
      <div className="row hint">
        <span>Needs <b>{fmt.n(r.start_amount)}</b> <Cur id={r.start} name={r.start_name} size={16} />
          {r.cycle_unit > 1 && <span className="muted"> ({fmt.n(r.cycles)} × {fmt.n(r.cycle_unit)} per run)</span>}</span>
        <span>· ends with <b>{fmt.n(r.end_amount)}</b></span>
        {r.profit_per_hour != null && <span>· earns <Wealth v={r.profit_per_hour} cur={refCur} suffix="/h" /></span>}
        <span className="spacer" />
      </div>
      {/* Owner, 2026-10-08: the where/offer columns said the same thing on every row (no live book any more); cut. */}
      <table>
        <thead>
          <tr>
            <th>Step</th><th className="num">Rate</th><th className="num">Gold</th><th className="num" title="units of the input currency the market trades per hour">Traded / h</th>
          </tr>
        </thead>
        <tbody>
          {r.steps.map((s, i) => (
            <tr key={i}>
              <td>{i + 1} · {stepText(s)}{s.unconverted > 0.5 && <span className="muted"> (+{fmt.n(s.unconverted)} left over)</span>}</td>
              <td className="num">{fmt.rate(s.rate)}</td>
              <td className="num">{s.gold ? fmt.n(s.gold) : <span className="muted">free</span>}</td>
              <td className="num">{s.kind === 'recipe' ? <span className="muted">n/a</span> : s.vol_in_per_h == null ? '–' : fmt.n(s.vol_in_per_h, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
