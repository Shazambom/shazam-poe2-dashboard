import React, { useMemo, useState } from 'react'
import { api, cleanErr, fmt, toast } from '../lib/api.js'
import Cur from './Cur.jsx'
import CurrencyPicker from './CurrencyPicker.jsx'
import { Loop } from './RouteSteps.jsx'

// "Convert": cheapest way to turn one currency into another across the exchange graph — an
// OPEN path, not a profit loop. Lives as a compact panel on the Arbitrage page (its sibling:
// loops vs directed conversion), and reuses the same route renderer (Loop) so a conversion
// reads like a loop.
//
// React.memo: the parent RoutesView re-renders on every streamed route (dozens of times as
// loops land), which would otherwise re-render this panel + its pickers and make the boxes
// flicker while you're typing. Its props (currencies/capital) are stable across those
// streams, so memo isolates it from the stream entirely.
function ConvertView({ currencies, capital }) {
  const opts = currencies?.currencies ?? []
  const held = useMemo(() => Object.fromEntries((capital?.rows ?? []).map(r => [r.currency, r.qty])), [capital])
  const [have, setHave] = useState('chaos')
  const [want, setWant] = useState('divine')
  const [amount, setAmount] = useState('')
  const [res, setRes] = useState(null)
  const [busy, setBusy] = useState(false)

  // Effective amount: what the user typed, else what they hold, else 1 (base unit).
  const effAmount = Number(amount) || held[have] || 1

  const run = async () => {
    if (!have || !want || have === want) { toast('Pick two different currencies', false); return }
    setBusy(true)
    try {
      setRes(await api.convert(have, want, effAmount))
    } catch (e) {
      setRes(null); toast(cleanErr(e), false)
    } finally { setBusy(false) }
  }

  const best = res?.best
  const direct = res?.direct
  // How much better the best route is than dumping into the direct market (if a direct exists
  // and the best route isn't itself the direct one).
  const beatsDirect = useMemo(() => {
    if (!best || !direct || best.id === direct.id) return null
    return best.out - direct.out
  }, [best, direct])

  return (
    <div className="convert-panel">
      <div className="convert-head">
        <h3>Convert</h3>
        <span className="hint">Cheapest way to turn one currency into another — an open path, not a loop.</span>
      </div>
      <div className="convert-form">
        <label className="convert-field">Have<CurrencyPicker value={have} onChange={setHave} options={opts} placeholder="have…" /></label>
        <span className="convert-arrow">→</span>
        <label className="convert-field">Want<CurrencyPicker value={want} onChange={setWant} options={opts} placeholder="want…" /></label>
        <label className="convert-field amount">Amount<input type="number" min="0" placeholder={String(held[have] || 1)}
          value={amount} onChange={e => setAmount(e.target.value)} /></label>
        <button className="btn primary" disabled={busy} onClick={run}>{busy ? 'Finding…' : 'Find route'}</button>
      </div>

      {res && !best && <p className="muted">{res.direct
        ? 'That amount is too small — it buys less than one of what you want. Try a larger amount.'
        : 'No conversion route found between those currencies.'}</p>}

      {best && (
        <div className="convert-result">
          <div className="row hint">
            <b>{fmt.n(best.in)}</b> <Cur id={have} name={best.path_names?.[0]} size={16} />
            {' → '}<b>{fmt.n(best.out)}</b> <Cur id={want} name={best.path_names?.slice(-1)[0]} size={16} />
            <span>· {Math.abs(best.loss_pct) <= 0.05 ? 'at market' : best.loss_pct < 0 ? `${fmt.n(-best.loss_pct, 1)}% over market` : `${fmt.n(best.loss_pct, 1)}% under market`}</span>
            {best.gold > 0 && <span>· {fmt.n(best.gold)} gold</span>}
            {beatsDirect != null && beatsDirect > 0 &&
              <span className="gain">· +{fmt.n(beatsDirect)} vs the direct market</span>}
          </div>
          <Loop r={best} />
          {direct && best.id !== direct.id && (
            <p className="muted small">Direct market: {fmt.n(direct.out)} {' '}
              <Cur id={want} size={14} />{direct.loss_pct > 0.05 ? ` (${fmt.n(direct.loss_pct, 1)}% lost to rounding)` : ''}.</p>
          )}
          {res.alternatives?.length > 1 && (
            <details className="convert-alts">
              <summary>{res.alternatives.length - 1} other route{res.alternatives.length - 1 === 1 ? '' : 's'}</summary>
              {res.alternatives.filter(a => a.id !== best.id).slice(0, 5).map(a => (
                <div key={a.id} className="row"><span className="muted">{fmt.n(a.out)} out ·</span><Loop r={a} /></div>
              ))}
            </details>
          )}
        </div>
      )}
    </div>
  )
}

export default React.memo(ConvertView)
