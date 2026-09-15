import React, { useEffect, useRef, useState } from 'react'
import { api, surface, toast } from '../lib/api.js'
import AccountsPanel from './AccountsPanel.jsx'
import RecipesView from './RecipesView.jsx'
import TradingSettings from './TradingSettings.jsx'
import CurrencyPicker from './CurrencyPicker.jsx'
import RefreshButton from './RefreshButton.jsx'
import Toggle from './Toggle.jsx'

// Everything auto-saves (debounced) — there is no Save button. The league lives
// in the top bar; essentials are visible; the rest sits behind "Advanced".
export default function SettingsView({ currencies, status, onSaved }) {
  const [s, setS] = useState(null)
  const [state, setState] = useState('')
  const [mapTo, setMapTo] = useState({})
  const [fees, setFees] = useState(null)
  const [busy, setBusy] = useState(false)
  const timer = useRef(null)
  const loaded = useRef(false)

  useEffect(() => {
    api.settings().then(x => { setS(x); setTimeout(() => { loaded.current = true }, 0) })
    api.goldFees().then(setFees).catch(() => {})
    return () => clearTimeout(timer.current)
  }, [])

  const persist = (next) => {
    if (!loaded.current) return
    clearTimeout(timer.current)
    setState('saving')
    timer.current = setTimeout(async () => {
      const num = (v, fb) => { const n = Number(v); return Number.isFinite(n) ? n : fb }
      try {
        await surface(api.putSettings({
          reference: next.reference, watchlist: next.watchlist,
          allow_digest_edges: next.allow_digest_edges, allow_recipe_edges: next.allow_recipe_edges,
          max_steps: num(next.max_steps, 3), max_start_fraction: num(next.max_start_fraction, 1),
          live_max_age_s: num(next.live_max_age_s, 1800), digest_max_age_h: num(next.digest_max_age_h, 6),
          min_edge_volume_ref_per_h: num(next.min_edge_volume_ref_per_h, 1),
          min_edge_depth: num(next.min_edge_depth, 2),
          gold_model: next.gold_model,
          live_top_n: num(next.live_top_n, 5), live_min_age_s: num(next.live_min_age_s, 300),
          min_refetch_s: num(next.min_refetch_s, 300), routes_cache_s: num(next.routes_cache_s, 300),
          background_sweep: !!next.background_sweep, batch_pad: !!next.batch_pad,
          batch_max_have: num(next.batch_max_have, 12),
          rank_weights: next.rank_weights, volume_window_h: num(next.volume_window_h, 24),
          step_overhead_min: num(next.step_overhead_min, 2),
        }))
        setState('saved'); onSaved?.()
        setTimeout(() => setState(x => x === 'saved' ? '' : x), 1500)
      } catch { setState('') }
    }, 800)
  }
  if (!s) return <div className="single hint">Loading settings…</div>

  const opts = currencies?.currencies ?? []
  const set = (k, v) => setS(x => { const n = { ...x, [k]: v }; persist(n); return n })
  const setGold = (k, v) => setS(x => { const n = { ...x, gold_model: { ...x.gold_model, [k]: v } }; persist(n); return n })
  const setWeight = (k, v) => setS(x => { const n = { ...x, rank_weights: { ...x.rank_weights, [k]: Number(v) } }; persist(n); return n })
  const perUnitText = Object.entries(s.gold_model.per_unit).map(([k, v]) => `${k}=${v}`).join(', ')

  return (
    <div className="single">
      <p className="hint save-state" style={{ minHeight: 18 }}>{state === 'saving' ? 'saving…' : state === 'saved' ? 'saved ✓' : 'Changes save automatically.'}</p>
      <div className="two-col">
        <div>
          <AccountsPanel onChange={onSaved} />

          <TradingSettings />

          <h2 style={{ marginTop: 28 }}>Market</h2>
          <p className="hint">The league is set from the dropdown in the top bar.</p>
          <div className="field"><label>Reference currency for values</label>
            <CurrencyPicker value={s.reference} onChange={id => set('reference', id)} options={opts} placeholder="reference currency…" />
          </div>
          <div className="field"><label>Live watchlist (every ordered pair is fetched each sweep)</label>
            <textarea rows={3} defaultValue={s.watchlist.join(', ')} onBlur={e => set('watchlist', e.target.value.split(/[\s,]+/).filter(Boolean))} />
            <span className="hint">{s.watchlist.length} currencies. Keep it under ~50 to stay clear of the exchange rate limit.</span>
          </div>
          <div className="check"><Toggle checked={s.allow_digest_edges} onChange={v => set('allow_digest_edges', v)} label="Fill missing pairs from hourly market data" /></div>
          <div className="check"><Toggle checked={s.allow_recipe_edges} onChange={v => set('allow_recipe_edges', v)} label="Use recipe steps" /></div>

          <details className="adv" style={{ marginTop: 18 }}>
            <summary>Advanced — route search &amp; fetch policy</summary>
            <div className="field"><label>Maximum steps per loop</label><input type="number" min="2" max="5" value={s.max_steps} onChange={e => set('max_steps', e.target.value)} /></div>
            <div className="field"><label>Fraction of held capital to commit</label><input type="number" min="0.05" max="1" step="0.05" value={s.max_start_fraction} onChange={e => set('max_start_fraction', e.target.value)} /></div>
            <div className="field"><label>Ignore live quotes older than (seconds)</label><input type="number" value={s.live_max_age_s} onChange={e => set('live_max_age_s', e.target.value)} /></div>
            <div className="field"><label>Ignore market data older than (hours)</label><input type="number" value={s.digest_max_age_h} onChange={e => set('digest_max_age_h', e.target.value)} /></div>
            <div className="field"><label>Cull markets trading less than ({s.reference}/hour)</label><input type="number" min="0" step="0.5" value={s.min_edge_volume_ref_per_h ?? 1} onChange={e => set('min_edge_volume_ref_per_h', e.target.value)} /></div>
            <div className="field"><label>Cull live markets with fewer listings than</label><input type="number" min="0" value={s.min_edge_depth ?? 2} onChange={e => set('min_edge_depth', e.target.value)} /></div>
            <div className="field"><label>Refresh pairs behind the top N loops</label><input type="number" min="1" value={s.live_top_n} onChange={e => set('live_top_n', e.target.value)} /></div>
            <div className="field"><label>Only if the pair's quote is older than (seconds)</label><input type="number" value={s.live_min_age_s} onChange={e => set('live_min_age_s', e.target.value)} /></div>
            <div className="field"><label>Never refetch the same pair sooner than (seconds)</label><input type="number" value={s.min_refetch_s} onChange={e => set('min_refetch_s', e.target.value)} /></div>
            <div className="field"><label>Serve identical route queries from memory for (seconds)</label><input type="number" value={s.routes_cache_s} onChange={e => set('routes_cache_s', e.target.value)} /></div>
            <div className="field"><label>Haves per exchange request</label><input type="number" min="1" max="20" value={s.batch_max_have} onChange={e => set('batch_max_have', e.target.value)} /></div>
            <div className="check"><Toggle checked={!!s.batch_pad} onChange={v => set('batch_pad', v)} label="Fill spare request slots with likely-useful pairs" /></div>
            <div className="check"><Toggle checked={!!s.background_sweep} onChange={v => set('background_sweep', v)} label="Background sweep of the whole watchlist" /></div>

            <h2>Ranking weights</h2>
            <p className="hint">The default sort blends these; velocity (profit per hour per gold) leads.</p>
            <div className="row" style={{ marginBottom: 12 }}>
              {[['velocity', 'Velocity'], ['margin_per_1k_gold', 'Gold efficiency'], ['margin_ref', 'Margin value'], ['volume', 'Traded volume']].map(([k, l]) => (
                <div className="field" key={k} style={{ marginBottom: 0, width: 150 }}><label>{l}</label>
                  <input type="number" step="0.05" min="0" value={s.rank_weights?.[k] ?? 0} onChange={e => setWeight(k, e.target.value)} /></div>
              ))}
              <div className="field" style={{ marginBottom: 0, width: 150 }}><label>Minutes per exchange step</label><input type="number" min="0" step="0.5" value={s.step_overhead_min ?? 2} onChange={e => set('step_overhead_min', e.target.value)} /></div>
              <div className="field" style={{ marginBottom: 0, width: 150 }}><label>Volume window, hours</label><input type="number" min="1" value={s.volume_window_h ?? 24} onChange={e => set('volume_window_h', e.target.value)} /></div>
            </div>
          </details>
        </div>

        <div>
          <details className="adv" open={false}>
            <summary>Gold fees (automatic — from game data)</summary>
            <p className="hint">
              Per-unit fees come from the game's own <code>CurrencyExchange</code> table via ggpk.exposed; nothing needs typing in.
              {fees?.state?.loaded_at
                ? <> Loaded <b>{Object.keys(fees.by_meta ?? {}).length}</b> items{fees.state.version ? ` from patch ${fees.state.version}` : ''}.</>
                : <> Not loaded yet{fees?.state?.last_error ? ` — ${fees.state.last_error}` : ''}.</>}
            </p>
            <div className="row" style={{ marginBottom: 12 }}>
              <RefreshButton busy={busy} onClick={async () => { setBusy(true); try { setFees(await surface(api.refreshGoldFees(), 'Gold fees refreshed')) } catch {} finally { setBusy(false) } }} title="Refresh gold fees from game data" />
              <span className="hint">Gold fees from game data</span>
              <span className="spacer" />
              <button className="btn" onClick={() => surface(api.syncDigest(), 'Market sync started').catch(() => {})}>Sync market data now</button>
            </div>
            <div className="field"><label>Fee applies to</label>
              <select value={s.gold_model.fee_side ?? 'buy'} onChange={e => setGold('fee_side', e.target.value)}>
                <option value="buy">units received (buy side)</option>
                <option value="sell">units given (sell side)</option>
              </select>
            </div>
            <div className="field"><label>Extra gold per order (usually 0)</label><input type="number" value={s.gold_model.base_per_order} onChange={e => setGold('base_per_order', Number(e.target.value))} /></div>
            <div className="field"><label>Manual overrides (id=gold, comma separated)</label>
              <input defaultValue={perUnitText} onBlur={e => {
                const m = {}; e.target.value.split(',').forEach(p => { const [k, v] = p.split('='); if (k && v && !isNaN(Number(v))) m[k.trim()] = Number(v) }); setGold('per_unit', m)
              }} />
            </div>
            <div className="field"><label>Fallback: gold per 1 {s.reference} of value</label><input type="number" value={s.gold_model.per_ref_unit} onChange={e => setGold('per_ref_unit', Number(e.target.value))} /></div>
          </details>

          <details className="adv">
            <summary>Recipes (disenchant / combine)</summary>
            <RecipesView currencies={currencies} embedded />
          </details>

          {(currencies?.unmapped_metadata_ids ?? []).length > 0 && (
            <details className="adv">
              <summary>Unmapped currencies ({currencies.unmapped_metadata_ids.length})</summary>
              <p className="hint">These item ids appeared in market data but couldn't be matched to a trade id automatically. Link them so their markets join the graph.</p>
              <table>
                <tbody>
                  {currencies.unmapped_metadata_ids.map(m => (
                    <tr key={m}>
                      <td><code>{m.split('/').pop()}</code></td>
                      <td><input className="btn" list="cur-ids-2" placeholder="trade id" value={mapTo[m] ?? ''} onChange={e => setMapTo(x => ({ ...x, [m]: e.target.value }))} /></td>
                      <td><button className="btn small" disabled={!mapTo[m]} onClick={() => surface(api.mapCurrency(m, mapTo[m]), 'Linked').then(onSaved).catch(() => {})}>Link</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <datalist id="cur-ids-2">{opts.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</datalist>
            </details>
          )}

          <details className="adv">
            <summary>Diagnostics</summary>
            <DiagPanel />
          </details>
        </div>
      </div>
    </div>
  )
}

// Local self-diagnostics (no data leaves the machine): backend health, DB row counts,
// backfill/digest state, and a live connectivity probe — to see why prices are/aren't
// flowing on the self-contained desktop build.
function DiagPanel() {
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true); setErr(null)
    try { setD(await api.diag()) } catch (e) { setErr(String(e.message || e)) }
    setBusy(false)
  }
  useEffect(() => { run() }, [])
  const text = d ? JSON.stringify(d, null, 2) : ''
  return (
    <div>
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <RefreshButton className="small" busy={busy} onClick={run} title="Refresh diagnostics" />
        <button className="btn small" disabled={!text} onClick={() => { navigator.clipboard?.writeText(text); toast('Diagnostics copied') }}>Copy</button>
      </div>
      {err && <div className="notice error">{err}</div>}
      {d && (
        <>
          <p className="hint">league <b>{d.settings?.league}</b> · league_daily rows for it: <b>{d.db_counts?.['league_daily[current_league]'] ?? '–'}</b> · registry {d.registry?.count}.
            Connectivity: {Object.entries(d.connectivity || {}).map(([k, v]) => <span key={k} style={{ marginRight: 10 }}>{k}=<b className={String(v).startsWith('ERR') ? 'loss' : 'gain'}>{String(v)}</b></span>)}</p>
          <pre style={{ maxHeight: 260, overflow: 'auto', fontSize: 11, background: 'rgba(0,0,0,.25)', padding: 8, borderRadius: 6 }}>{text}</pre>
        </>
      )}
    </div>
  )
}
