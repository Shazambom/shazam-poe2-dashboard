import React, { useMemo, useState } from 'react'
import { api, fmt } from '../lib/api.js'
import { useApi } from '../lib/hooks.js'
import Cur from './Cur.jsx'
import Wealth from './Wealth.jsx'
import { useAssetModal } from './CardDetail.jsx'
import { useHorizon } from '../lib/horizonStore.js'
import CautionSlider from './CautionSlider.jsx'
import { arrowCell } from '../lib/arrows.js'

// "What to hold" leaderboard: assets ranked by how well they retain/gain value in
// Divine over a horizon, with a cross-league forward-return prediction. Surfaces the
// obscure winners (omens, liquid emotions, essences…), not just Mirror/Divine.
// Horizon is the app-wide one (topbar), sent as hours; the backend maps it to Hold's day
// horizon (daily poe2scout data can't resolve sub-day) and clamps it to 7d, reporting the
// effective `horizon` back. Numeraires come from the response (the backend's anchor table).
const MOVERS_N = 50  // "all of the top movers" — a full leaderboard, not the board's top-3 pulse

function PredArrows({ code }) {
  const { text, cls } = arrowCell(code)
  return <span className={cls}>{text}</span>
}

function ConfBadge({ c }) {
  const level = c >= 0.66 ? 'hi' : c >= 0.33 ? 'mid' : 'lo'
  return <span className={`conf conf-${level}`} title={`confidence ${c} (data depth × liquidity)`}>{Math.round(c * 100)}</span>
}

export default function HoldView() {
  const [view, setView] = useState('hold')   // 'hold' (primary) | 'movers' (positive swings, secondary)
  const hours = useHorizon(s => s.hours)      // app-wide horizon (topbar)
  const [category, setCategory] = useState('all')
  const [numeraire, setNumeraire] = useState('divine')
  const [k, setK] = useState(null)             // stability dial; null = use the saved setting
  const assetModal = useAssetModal()          // click any row → the SAME zoom modal the Board uses
  const zoom = (name) => assetModal.open(name, numeraire)

  const hold = useApi(() => api.hold(hours, category, numeraire, k), [hours, category, numeraire, k])
  // Positive-movers board (secondary view): full-universe upward swings over the same window.
  const mv = useApi(() => view === 'movers' ? api.movers(hours, MOVERS_N, 'up') : Promise.resolve(null), [view, hours])
  const data = hold.data, movers = mv.data
  const err = hold.err || mv.err
  const busy = view === 'movers' ? mv.busy : hold.busy

  const cats = data?.categories ?? ['all']
  const rows = useMemo(() => data?.assets ?? [], [data])
  const mvRows = useMemo(() => movers?.assets ?? [], [movers])
  const delta = data?.delta_days ?? 30
  const horizon = data?.horizon ?? '3d'       // the EFFECTIVE hold horizon (backend-clamped)
  const numeraires = data?.numeraires ?? [{ id: 'divine', name: 'Divine Orb' }]
  const numName = data?.numeraire_name ?? 'Divine'
  const unit = { divine: 'Div', mirror: 'Mir', lock: 'Lock' }[numeraire] || 'Div'
  const isMovers = view === 'movers'
  const showPred = !!data?.pred_shown          // the backend drops the forecast past the league-day it stops being true

  return (
    <div className="single hold">
      <div className="board-bar">
        {isMovers
          ? <h2 style={{ margin: 0 }}>Positive movers <span className="muted" style={{ fontWeight: 400 }}>· biggest upward swings across all currencies over {horizon}{movers?.league ? ` · ${movers.league}` : ''}</span></h2>
          : <h2 style={{ margin: 0 }}>What to hold <span className="muted" style={{ fontWeight: 400 }}>· ranked by value retained/gained vs {numName}{data?.league ? ` · ${data.league}` : ''}</span></h2>}
        <span className="spacer" />
        {/* Hold is the primary board; Positive movers is the secondary alternate view. */}
        <div className="seg" title="Hold = stores of value; Movers = biggest upward price swings">
          <button className={`seg-btn ${!isMovers ? 'on' : ''}`} onClick={() => setView('hold')}>Hold</button>
          <button className={`seg-btn ${isMovers ? 'on' : ''}`} onClick={() => setView('movers')}>Positive movers</button>
        </div>
        {/* Numeraire + Category apply only to Hold, but stay rendered (disabled/dimmed) in the
            Movers view so switching doesn't collapse the bar and jump the layout. */}
        <div className={`seg ${isMovers ? 'hold-inactive' : ''}`} title="Hard-asset numeraire — what 'holds value' is measured against.">
          {numeraires.map(({ id: k, name }) => (
            <button key={k} disabled={isMovers} className={`seg-btn ${!isMovers && numeraire === k ? 'on' : ''}`} title={name} onClick={() => setNumeraire(k)}>vs {k[0].toUpperCase() + k.slice(1)}</button>
          ))}
        </div>
        {!isMovers && <CautionSlider value={data?.k} range={data?.k_range} onChange={setK} />}
        <label className={`hint ${isMovers ? 'hold-inactive' : ''}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>Category
          <select className="league-select" value={category} disabled={isMovers} onChange={e => setCategory(e.target.value)}>
            {cats.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>

      {err && <div className="notice error">{err}</div>}
      {data?.building && <div className="notice">Building the asset history from poe2scout (all currency categories × past leagues) — this takes a while on first run; the board fills in and improves as it crawls.</div>}

      {/* ---- Hold leaderboard (primary) ---- */}
      {!isMovers && <>
        {busy && rows.length === 0 && <table><tbody>{Array.from({ length: 6 }).map((_, i) => <tr key={i}><td colSpan={8}><div className="sk sk-row" /></td></tr>)}</tbody></table>}
        {!busy && rows.length === 0 && !data?.building && <div className="empty">No assets scored yet — the backfill may still be running.</div>}
        {rows.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>#</th><th>Asset</th><th>Category</th>
                <th className="num" title={`Return in ${numName} over the past ${delta}d`}>Past {delta}d ({unit})</th>
                <th className="num" title="Worst peak-to-trough drop over the league (holding risk)">Max drawdown</th>
                <th className="num" title="Past return weighed against max drawdown — higher ranks first. Caution sets the weight.">Hold score</th>
                {showPred && <th className="num" title={`Likely direction over the next ${delta}d — more arrows, stronger`}>Predicted +{delta}d</th>}
                <th className="num" title="Data depth × liquidity (0–100). Low = thin/obscure, treat with caution">Conf.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} className="route" title={`Expand ${r.name}`} onClick={() => zoom(r.name)}>
                  <td className="muted">{i + 1}</td>
                  <td><Cur name={r.name} text /></td>
                  <td className="muted">{r.category}</td>
                  <td className={`num ${r.ret_pct >= 0 ? 'gain' : 'loss'}`}>{fmt.pct(r.ret_pct)}</td>
                  <td className="num loss">{r.mdd_pct == null ? '–' : `${r.mdd_pct}%`}</td>
                  <td className="num mpg">{r.hold >= 0 ? '+' : ''}{r.hold}</td>
                  {showPred && <td className="num"><PredArrows code={r.pred_arrows} /></td>}
                  <td className="num"><ConfBadge c={r.confidence} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>}

      {/* ---- Positive movers leaderboard (secondary) ---- */}
      {isMovers && <>
        {!busy && mvRows.length === 0 && <div className="empty">No upward movers over {horizon} yet.</div>}
        {mvRows.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>#</th><th>Asset</th><th>Category</th>
                <th className="num" title={`% change over ${horizon}`}>Change</th>
                <th className="num" title="Median daily traded value (Exalted/day) — liquidity">Volume</th>
              </tr>
            </thead>
            <tbody>
              {mvRows.map((r, i) => (
                <tr key={r.id} className="route" title={`Expand ${r.name}`} onClick={() => assetModal.open(r.name, r.num)}>
                  <td className="muted">{i + 1}</td>
                  <td><Cur name={r.name} text /></td>
                  <td className="muted">{r.category}</td>
                  <td className="num gain">{fmt.pct(r.change_pct)}</td>
                  <td className="num muted"><Wealth v={r.medvol} cur="exalted" size={12} suffix="/day" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>}

      {assetModal.node}
    </div>
  )
}
