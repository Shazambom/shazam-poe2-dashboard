import React, { useEffect, useMemo, useState } from 'react'
import { api, fmt } from '../lib/api.js'
import Cur from './Cur.jsx'

// "What to hold" leaderboard: assets ranked by how well they retain/gain value in
// Divine over a horizon, with a cross-league forward-return prediction. Surfaces the
// obscure winners (omens, liquid emotions, essences…), not just Mirror/Divine.
const HORIZONS = [['short', 'Short · 7d'], ['med', 'Medium · 30d'], ['long', 'Whole league']]

function ConfBadge({ c }) {
  const level = c >= 0.66 ? 'hi' : c >= 0.33 ? 'mid' : 'lo'
  return <span className={`conf conf-${level}`} title={`confidence ${c} (data depth × liquidity)`}>{Math.round(c * 100)}</span>
}

const NUMERAIRES = [['divine', 'vs Divine'], ['mirror', 'vs Mirror'], ['lock', 'vs Lock']]

export default function HoldView() {
  const [horizon, setHorizon] = useState('long')
  const [category, setCategory] = useState('all')
  const [numeraire, setNumeraire] = useState('divine')
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(true)

  useEffect(() => {
    setBusy(true)
    api.hold(horizon, category, numeraire).then(d => { setData(d); setErr(null) }).catch(e => setErr(String(e.message || e))).finally(() => setBusy(false))
  }, [horizon, category, numeraire])

  const cats = data?.categories ?? ['all']
  const rows = useMemo(() => data?.assets ?? [], [data])
  const delta = data?.delta_days ?? 30
  const numName = data?.numeraire_name ?? 'Divine'
  const unit = { divine: 'Div', mirror: 'Mir', lock: 'Lock' }[numeraire] || 'Div'

  return (
    <div className="single hold">
      <div className="board-bar">
        <h2 style={{ margin: 0 }}>What to hold <span className="muted" style={{ fontWeight: 400 }}>· ranked by value retained/gained vs {numName}{data?.league ? ` · ${data.league}` : ''}</span></h2>
        <span className="spacer" />
        <div className="seg" title="Hard-asset numeraire — what 'holds value' is measured against">
          {NUMERAIRES.map(([k, label]) => (
            <button key={k} className={`seg-btn ${numeraire === k ? 'on' : ''}`} onClick={() => setNumeraire(k)}>{label}</button>
          ))}
        </div>
        <div className="seg">
          {HORIZONS.map(([k, label]) => (
            <button key={k} className={`seg-btn ${horizon === k ? 'on' : ''}`} onClick={() => setHorizon(k)}>{label}</button>
          ))}
        </div>
        <label className="hint">Category&nbsp;
          <select value={category} onChange={e => setCategory(e.target.value)}>
            {cats.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>

      {err && <div className="notice error">{err}</div>}
      {data?.building && <div className="notice">Building the asset history from poe2scout (all currency categories × past leagues) — this takes a while on first run; the board fills in and improves as it crawls.</div>}

      {!busy && rows.length === 0 && !data?.building && <div className="empty">No assets scored yet — the backfill may still be running.</div>}

      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>#</th><th>Asset</th><th>Category</th>
              <th className="num" title={`Return in ${numName} over the selected horizon`}>Return ({unit})</th>
              <th className="num" title="Worst peak-to-trough drop over the league (holding risk)">Max drawdown</th>
              <th className="num" title="Return × confidence — the ranking score">Hold score</th>
              <th className="num" title={`Predicted return over the next ${delta}d, from how this asset behaved at the same league-day in past leagues`}>Predicted +{delta}d</th>
              <th className="num" title="Data depth × liquidity (0–100). Low = thin/obscure, treat with caution">Conf.</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id}>
                <td className="muted">{i + 1}</td>
                <td><Cur name={r.name} text /></td>
                <td className="muted">{r.category}</td>
                <td className={`num ${r.ret_pct >= 0 ? 'gain' : 'loss'}`}>{fmt.pct(r.ret_pct)}</td>
                <td className="num loss">{r.mdd_pct == null ? '–' : `${r.mdd_pct}%`}</td>
                <td className="num mpg">{r.hold >= 0 ? '+' : ''}{r.hold}</td>
                <td className="num">
                  {r.pred_pct == null ? <span className="muted" title="needs ≥2 past leagues with this asset">–</span>
                    : <span className={r.pred_pct >= 0 ? 'gain' : 'loss'} title={`${r.pred_leagues} past leagues, ±${r.pred_band_pct}%`}>
                        {fmt.pct(r.pred_pct)} <span className="muted">±{r.pred_band_pct}</span>
                      </span>}
                </td>
                <td className="num"><ConfBadge c={r.confidence} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="hint" style={{ marginTop: 12 }}>
        Everything is priced in <b>{numName}</b> (holding value = beating it, not the inflating Exalted). Mirror &amp; Lock trade thinly, so their coverage/confidence is lower than Divine. Hold score = return × confidence;
        max drawdown is the worst dip you'd have sat through. <b>Predicted</b> averages how each asset moved from this same league-day in past
        leagues (recency-weighted, ±dispersion) — needs ≥2 past leagues. Low-confidence rows are thin/obscure markets; weight them cautiously.
        Late-league note: supply-throttled crafting mats (omens, top essences, refined catalysts) tend to hold; bulk-farmed commodities drift down.
      </p>
    </div>
  )
}
