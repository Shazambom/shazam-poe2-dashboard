import React, { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import AccountsPanel from './AccountsPanel.jsx'

export default function SettingsView({ currencies, status, onSaved }) {
  const [s, setS] = useState(null)
  const [saved, setSaved] = useState(false)
  const [mapTo, setMapTo] = useState({})
  const [fees, setFees] = useState(null)
  const [leagues, setLeagues] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.settings().then(setS); api.goldFees().then(setFees).catch(() => {}); api.leagues().then(setLeagues).catch(() => setLeagues([])) }, [])
  if (!s) return <div className="single hint">Loading settings</div>

  const opts = currencies?.currencies ?? []
  const set = (k, v) => setS(x => ({ ...x, [k]: v }))
  const setGold = (k, v) => setS(x => ({ ...x, gold_model: { ...x.gold_model, [k]: v } }))
  const perUnitText = Object.entries(s.gold_model.per_unit).map(([k, v]) => `${k}=${v}`).join(', ')

  const save = async () => {
    await api.putSettings({
      league: s.league, reference: s.reference, watchlist: s.watchlist, max_steps: Number(s.max_steps),
      max_start_fraction: Number(s.max_start_fraction), live_max_age_s: Number(s.live_max_age_s), max_steps: Number(s.max_steps),
      digest_max_age_h: Number(s.digest_max_age_h), allow_digest_edges: s.allow_digest_edges,
      allow_recipe_edges: s.allow_recipe_edges, gold_model: s.gold_model,
      live_top_n: Number(s.live_top_n), live_min_age_s: Number(s.live_min_age_s), min_refetch_s: Number(s.min_refetch_s),
      routes_cache_s: Number(s.routes_cache_s), background_sweep: !!s.background_sweep,
      batch_pad: !!s.batch_pad, batch_max_have: Number(s.batch_max_have),
      rank_weights: s.rank_weights, volume_window_h: Number(s.volume_window_h ?? 24), step_overhead_min: Number(s.step_overhead_min ?? 2),
    })
    setSaved(true); setTimeout(() => setSaved(false), 1500); onSaved?.()
  }

  return (
    <div className="single">
      <div className="two-col">
        <div>
          <AccountsPanel onChange={onSaved} />
          <h2 style={{ marginTop: 28 }}>Market</h2>
          <div className="field"><label>League</label>
            {leagues && leagues.length > 0 ? (
              <select value={s.league} onChange={e => set('league', e.target.value)}>
                {!leagues.some(l => l.id === s.league) && <option value={s.league}>{s.league}</option>}
                {leagues.map(l => <option key={l.id} value={l.id}>{l.text}</option>)}
              </select>
            ) : <input value={s.league} onChange={e => set('league', e.target.value)} placeholder="exact trade-site league id" />}
          </div>
          <div className="field"><label>Reference currency for values</label>
            <select value={s.reference} onChange={e => set('reference', e.target.value)}>{opts.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          </div>
          <div className="field"><label>Live watchlist (every ordered pair is fetched each sweep)</label>
            <textarea rows={3} value={s.watchlist.join(', ')} onChange={e => set('watchlist', e.target.value.split(/[\s,]+/).filter(Boolean))} />
            <span className="hint">{s.watchlist.length} currencies = {s.watchlist.length * (s.watchlist.length - 1)} requests per sweep. Keep it under ~50 to stay clear of the exchange rate limit.</span>
          </div>

          <h2>Route search</h2>
          <div className="field"><label>Maximum steps per loop</label><input type="number" min="2" max="5" value={s.max_steps} onChange={e => set('max_steps', e.target.value)} /></div>
          <div className="field"><label>Fraction of held capital to commit</label><input type="number" min="0.05" max="1" step="0.05" value={s.max_start_fraction} onChange={e => set('max_start_fraction', e.target.value)} /></div>
          <div className="field"><label>Ignore live quotes older than (seconds)</label><input type="number" value={s.live_max_age_s} onChange={e => set('live_max_age_s', e.target.value)} /></div>
          <div className="field"><label>Ignore digest rates older than (hours)</label><input type="number" value={s.digest_max_age_h} onChange={e => set('digest_max_age_h', e.target.value)} /></div>
          <h2>Ranking weights</h2>
          <p className="hint">The default sort is a rank-normalised blend led by velocity — margin ÷ (fill time × gold), i.e. profit per hour per gold. The other terms break ties.</p>
          <div className="row" style={{ marginBottom: 12 }}>
            {[['velocity', 'Velocity'], ['margin_per_1k_gold', 'Gold efficiency'], ['margin_ref', 'Margin value'], ['volume', 'Traded volume']].map(([k, l]) => (
              <div className="field" key={k} style={{ marginBottom: 0, width: 150 }}><label>{l}</label>
                <input type="number" step="0.05" min="0" value={s.rank_weights?.[k] ?? 0} onChange={e => setS(x => ({ ...x, rank_weights: { ...x.rank_weights, [k]: Number(e.target.value) } }))} /></div>
            ))}
            <div className="field" style={{ marginBottom: 0, width: 150 }}><label>Minutes per exchange step</label><input type="number" min="0" step="0.5" value={s.step_overhead_min ?? 2} onChange={e => set('step_overhead_min', e.target.value)} /></div>
            <div className="field" style={{ marginBottom: 0, width: 150 }}><label>Volume window, hours</label><input type="number" min="1" value={s.volume_window_h ?? 24} onChange={e => set('volume_window_h', e.target.value)} /></div>
          </div>
          <h2>Live fetch policy</h2>
          <div className="field"><label>Default: refresh pairs behind the top N loops</label><input type="number" min="1" value={s.live_top_n} onChange={e => set('live_top_n', e.target.value)} /></div>
          <div className="field"><label>Only if the pair's quote is older than (seconds)</label><input type="number" value={s.live_min_age_s} onChange={e => set('live_min_age_s', e.target.value)} /></div>
          <div className="field"><label>Never refetch the same pair sooner than (seconds)</label><input type="number" value={s.min_refetch_s} onChange={e => set('min_refetch_s', e.target.value)} /></div>
          <div className="field"><label>Serve identical route queries from memory for (seconds)</label><input type="number" value={s.routes_cache_s} onChange={e => set('routes_cache_s', e.target.value)} /></div>
          <label className="check"><input type="checkbox" checked={!!s.batch_pad} onChange={e => set('batch_pad', e.target.checked)} /> Fill spare slots of each request with other pairs (requested first, then pairs from the best loops, then most-traded)</label>
          <div className="field"><label>Haves per request (the response caps around 100 listings; 12 is a good ceiling)</label><input type="number" min="1" max="20" value={s.batch_max_have} onChange={e => set('batch_max_have', e.target.value)} /></div>
          <label className="check"><input type="checkbox" checked={!!s.background_sweep} onChange={e => set('background_sweep', e.target.checked)} /> Background sweep of the whole watchlist (low priority; off by default)</label>
          <label className="check"><input type="checkbox" checked={s.allow_digest_edges} onChange={e => set('allow_digest_edges', e.target.checked)} /> Fill missing pairs from the hourly digest</label>
          <label className="check"><input type="checkbox" checked={s.allow_recipe_edges} onChange={e => set('allow_recipe_edges', e.target.checked)} /> Use recipe steps</label>
        </div>

        <div>
          <h2>Gold fees</h2>
          <p className="hint">
            Per-unit fees are read from the game's own <code>CurrencyExchange</code> table (<code>GoldPurchaseFee</code>) via ggpk.exposed, so nothing needs typing in.
            {fees?.state?.loaded_at
              ? <> Loaded <b>{Object.keys(fees.by_meta ?? {}).length}</b> items{fees.state.version ? ` from patch ${fees.state.version}` : ''}; {Object.keys(fees.by_trade ?? {}).length} linked to trade ids.</>
              : <> Not loaded yet{fees?.state?.last_error ? ` — ${fees.state.last_error}` : ''}.</>}
          </p>
          <div className="row" style={{ marginBottom: 12 }}>
            <button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { setFees(await api.refreshGoldFees()) } finally { setBusy(false) } }}>{busy ? 'Fetching' : 'Refresh from game data'}</button>
            {fees?.unmapped?.length > 0 && <span className="hint">{fees.unmapped.length} fee rows have no trade id yet; link them below.</span>}
          </div>
          {fees?.by_trade && s.watchlist.length > 0 && (
            <table style={{ marginBottom: 14 }}>
              <thead><tr><th>Watchlist currency</th><th className="num">Gold per unit</th></tr></thead>
              <tbody>{s.watchlist.map(c => <tr key={c}><td>{opts.find(o => o.id === c)?.name ?? c}</td><td className="num">{fees.by_trade[c] ?? <span className="muted">not in table</span>}</td></tr>)}</tbody>
            </table>
          )}
          <div className="field"><label>Fee applies to</label>
            <select value={s.gold_model.fee_side ?? 'buy'} onChange={e => setGold('fee_side', e.target.value)}>
              <option value="buy">units received (buy side)</option>
              <option value="sell">units given (sell side)</option>
            </select>
            <span className="hint">Check one real order in game: if the fee matches the item you receive, keep "buy".</span>
          </div>
          <div className="field"><label>Extra gold per order (usually 0)</label><input type="number" value={s.gold_model.base_per_order} onChange={e => setGold('base_per_order', Number(e.target.value))} /></div>
          <div className="field"><label>Manual overrides, if the table is wrong for something (id=gold, comma separated)</label>
            <input defaultValue={perUnitText} onBlur={e => {
              const m = {}; e.target.value.split(',').forEach(p => { const [k, v] = p.split('='); if (k && v && !isNaN(Number(v))) m[k.trim()] = Number(v) }); setGold('per_unit', m)
            }} />
          </div>
          <div className="field"><label>Fallback for items missing from the table: gold per 1 {s.reference} of value</label><input type="number" value={s.gold_model.per_ref_unit} onChange={e => setGold('per_ref_unit', Number(e.target.value))} /></div>

          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn primary" onClick={save}>{saved ? 'Saved' : 'Save settings'}</button>
            <button className="btn" onClick={() => api.syncDigest()}>Sync digest now</button>
          </div>

          <h2 style={{ marginTop: 28 }}>Unmapped digest currencies</h2>
          {(currencies?.unmapped_metadata_ids ?? []).length === 0 ? <p className="hint">Every digest currency seen so far is linked to a trade id.</p> : (
            <>
              <p className="hint">These GGG item ids appeared in the digest but couldn't be matched to a trade-site id automatically. Link them so their markets join the graph.</p>
              <table>
                <tbody>
                  {currencies.unmapped_metadata_ids.map(m => (
                    <tr key={m}>
                      <td><code>{m.split('/').pop()}</code></td>
                      <td><input className="btn" list="cur-ids-2" placeholder="trade id" value={mapTo[m] ?? ''} onChange={e => setMapTo(x => ({ ...x, [m]: e.target.value }))} /></td>
                      <td><button className="btn small" disabled={!mapTo[m]} onClick={() => api.mapCurrency(m, mapTo[m]).then(onSaved)}>Link</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <datalist id="cur-ids-2">{opts.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</datalist>
            </>
          )}

        </div>
      </div>
    </div>
  )
}
