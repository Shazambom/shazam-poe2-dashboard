import React, { useState } from 'react'
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

export function Detail({ r, refCur }) {
  const [copied, setCopied] = useState(null)
  const copy = async (text, i) => {
    try { await navigator.clipboard.writeText(text); setCopied(i); setTimeout(() => setCopied(null), 1500) } catch {}
  }
  return (
    <div className="detail">
      <div className="row hint">
        <span>Commit <b>{fmt.n(r.start_amount)}</b> <Cur id={r.start} name={r.start_name} size={16} />
          {r.cycle_unit > 1 && <span className="muted"> ({fmt.n(r.cycles)} × {fmt.n(r.cycle_unit)}/cycle)</span>}
          , hold {fmt.n(r.capital_held)}</span>
        <span>· ends with <b>{fmt.n(r.end_amount)}</b></span>
        <span>· value through loop <Wealth v={r.value_ref} cur={refCur} /></span>
        <span>· oldest quote {fmt.age(r.max_age_s)}</span>
        {r.profit_per_hour != null && <span>· earns <Wealth v={r.profit_per_hour} cur={refCur} suffix="/h" /></span>}
        {r.score != null && r.score_parts && <span>· score {r.score} (velocity {r.score_parts.velocity}, efficiency {r.score_parts.efficiency}, value {r.score_parts.value}, volume {r.score_parts.volume})</span>}
        <span className="spacer" />
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
                  ) : <span className="muted">{s.kind === 'digest' ? 'exchange rate, place at market' : '–'}</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
