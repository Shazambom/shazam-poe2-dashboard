import React, { useEffect, useState } from 'react'
import { api, surface, toast } from '../lib/api.js'
import { useAutosave } from '../lib/hooks.js'
import { useStatus } from '../lib/statusStore.js'
import { isDesktop } from '../lib/session.js'
import AccountsPanel from './AccountsPanel.jsx'
import RecipesView from './RecipesView.jsx'
import TradingSettings from './TradingSettings.jsx'
import NotificationsPanel from './NotificationsPanel.jsx'
import CurrencyPicker from './CurrencyPicker.jsx'
import RefreshButton from './RefreshButton.jsx'
import Toggle from './Toggle.jsx'
import { THEMES, useTheme } from '../lib/themeStore.js'
import ThemeBuilder from './ThemeBuilder.jsx'

// Everything auto-saves (debounced) — there is no Save button. The league lives
// in the top bar; essentials are visible; the rest sits behind "Advanced".
export default function SettingsView({ currencies, status, onSaved }) {
  const [s, setS] = useState(null)
  const [mapTo, setMapTo] = useState({})
  const [fees, setFees] = useState(null)
  const [busy, setBusy] = useState(false)

  // The PUT payload: the editable subset, numbers coerced (blank → the default).
  const num = (v, fb) => { const n = Number(v); return Number.isFinite(n) ? n : fb }
  const payload = (next) => ({
    reference: next.reference,
    allow_digest_edges: next.allow_digest_edges, allow_recipe_edges: next.allow_recipe_edges,
    max_steps: num(next.max_steps, 3), max_start_fraction: num(next.max_start_fraction, 1),
    live_max_age_s: num(next.live_max_age_s, 1800),
    min_edge_depth: num(next.min_edge_depth, 2),
    gold_model: next.gold_model,
    live_top_n: num(next.live_top_n, 5), live_min_age_s: num(next.live_min_age_s, 300),
    min_refetch_s: num(next.min_refetch_s, 300),
    background_sweep: !!next.background_sweep, batch_pad: !!next.batch_pad,
    batch_max_have: num(next.batch_max_have, 10),
    rank_weights: next.rank_weights, volume_window_h: num(next.volume_window_h, 24),
    step_overhead_min: num(next.step_overhead_min, 2),
  })
  const { state, save, arm } = useAutosave(async (next) => {
    await useStatus.getState().saveSettings(payload(next))
    onSaved?.()
  }, 800)

  useEffect(() => {
    useStatus.getState().loadSettings().then(x => { setS(x); arm() })
    api.goldFees().then(setFees).catch(() => {})
  }, []) // eslint-disable-line
  if (!s) return <div className="single hint">Loading settings…</div>

  const opts = currencies?.currencies ?? []
  const set = (k, v) => setS(x => { const n = { ...x, [k]: v }; save(n); return n })
  const setGold = (k, v) => setS(x => { const n = { ...x, gold_model: { ...x.gold_model, [k]: v } }; save(n); return n })
  const setWeight = (k, v) => setS(x => { const n = { ...x, rank_weights: { ...x.rank_weights, [k]: Number(v) } }; save(n); return n })
  const perUnitText = Object.entries(s.gold_model.per_unit).map(([k, v]) => `${k}=${v}`).join(', ')

  return (
    <div className="single">
      <p className="hint save-state" style={{ minHeight: 18 }} aria-live="polite">{state === 'saving' ? 'saving…' : state === 'saved' ? 'saved ✓' : ''}</p>
      <div className="two-col">
        <div>
          <AccountsPanel onChange={onSaved} />

          <NotificationsPanel />
          <TradingSettings />

          <h2 style={{ marginTop: 28 }}>Appearance</h2>
          <ThemeRow />
          <ThemeBuilder />

          <h2 style={{ marginTop: 28 }}>Market</h2>
          <p className="hint">The league is set from the dropdown in the top bar.</p>
          <div className="field"><label>Reference currency for values</label>
            <CurrencyPicker value={s.reference} onChange={id => set('reference', id)} options={opts} placeholder="reference currency…" />
          </div>
          <div className="check"><Toggle checked={s.allow_digest_edges} onChange={v => set('allow_digest_edges', v)} label="Fill missing pairs from hourly market data" /></div>
          <div className="check"><Toggle checked={s.allow_recipe_edges} onChange={v => set('allow_recipe_edges', v)} label="Use recipe steps" /></div>

          <details className="adv" style={{ marginTop: 18 }}>
            <summary>Advanced — route search</summary>
            <div className="field"><label>Maximum steps per loop</label><input type="number" min="2" max="5" value={s.max_steps} onChange={e => set('max_steps', e.target.value)} /></div>
            <div className="field"><label>Fraction of held capital to commit</label><input type="number" min="0.05" max="1" step="0.05" value={s.max_start_fraction} onChange={e => set('max_start_fraction', e.target.value)} /></div>

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
            <BetaChannelToggle />
            <DiagPanel />
          </details>
        </div>
      </div>
    </div>
  )
}

// Beta (dev) update channel opt-in — desktop only. On beta, the app auto-updates to pre-release
// `-beta.N` builds AND enables diagnostics telemetry so we can debug packaged behavior remotely.
// Stable users never see beta releases (they're GitHub pre-releases). No-op in the web build.
function BetaChannelToggle() {
  const desk = isDesktop ? window.poe2desktop : null
  const [st, setSt] = useState(null)
  useEffect(() => { desk?.getChannel?.().then(setSt).catch(() => {}) }, [])
  if (!desk?.getChannel) return null
  const toggle = async (v) => {
    try { setSt(await desk.setChannel(v)); toast(v ? 'Beta channel on — checking for updates…' : 'Back on stable channel') } catch {}
  }
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="check">
        <Toggle checked={!!st?.beta} onChange={toggle} disabled={st?.locked}
                label="Beta updates (dev channel + diagnostics telemetry)" />
      </div>
      <p className="hint">
        {st?.locked
          ? 'This is a beta build — reinstall a stable release to leave the beta channel.'
          : 'Opt in to pre-release builds and send diagnostics so issues can be debugged remotely.'}
      </p>
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
          <p className="hint">{Object.entries(d.connectivity || {}).map(([k, v]) => <span key={k} className="feed" style={{ marginRight: 12 }}><span className={`dot ${String(v).startsWith('ERR') ? 'off' : 'ok'}`} />{k}</span>)}</p>
          <details className="adv"><summary>Raw report</summary><pre className="diag-pre">{text}</pre></details>
        </>
      )}
    </div>
  )
}

// The theme presets + the user's custom themes (listed after, marked ·): the same dropdown as every
// other picker, applied instantly, saved as a setting.
function ThemeRow() {
  const id = useTheme(s => s.id)
  const apply = useTheme(s => s.apply)
  const customs = useTheme(s => s.customs)
  const options = [...THEMES, ...customs.map(t => ({ id: t.id, name: `${t.name} ·` }))]
  return (
    <div className="field"><label>Theme</label>
      <CurrencyPicker value={id} onChange={apply} options={options} placeholder="theme…" renderIcon={null} />
    </div>
  )
}
