import React, { useEffect, useState } from 'react'
import { useAutosave } from '../lib/hooks.js'
import { useStatus } from '../lib/statusStore.js'

// The route-search knobs, on the page they affect: loop length, how much capital a loop may
// commit, the ranking blend, and the two pacing inputs. Collapsed by default under Filters — the
// user tweaks them here instead of walking to Settings. Same settings blob, same debounced save.
const WEIGHTS = [['velocity', 'Velocity'], ['margin_per_1k_gold', 'Gold efficiency'], ['margin_ref', 'Margin value'], ['volume', 'Traded volume']]
const num = (v, fb) => { const n = Number(v); return Number.isFinite(n) ? n : fb }

export default function ArbitrageAlgorithm({ onSaved }) {
  const [s, setS] = useState(null)
  const { save, arm } = useAutosave(async (next) => {
    await useStatus.getState().saveSettings({
      max_steps: num(next.max_steps, 3), max_start_fraction: num(next.max_start_fraction, 1),
      rank_weights: next.rank_weights, step_overhead_min: num(next.step_overhead_min, 2),
      volume_window_h: num(next.volume_window_h, 24), wide_spread: num(next.wide_spread, 2),
    })
    onSaved?.()
  }, 800)
  useEffect(() => { useStatus.getState().loadSettings().then(x => { setS(x); arm() }).catch(() => {}) }, []) // eslint-disable-line
  if (!s) return null
  const set = (k, v) => setS(x => { const n = { ...x, [k]: v }; save(n); return n })
  const setWeight = (k, v) => setS(x => { const n = { ...x, rank_weights: { ...x.rank_weights, [k]: Number(v) } }; save(n); return n })
  return (
    <details className="adv">
      <summary>Arbitrage algorithm</summary>
      <div className="field"><label>Maximum steps per loop</label><input type="number" min="2" max="5" value={s.max_steps} onChange={e => set('max_steps', e.target.value)} /></div>
      <div className="field"><label>Fraction of held capital to commit</label><input type="number" min="0.05" max="1" step="0.05" value={s.max_start_fraction} onChange={e => set('max_start_fraction', e.target.value)} /></div>
      <div className="field"><label>Minutes per exchange step</label><input type="number" min="0" step="0.5" value={s.step_overhead_min ?? 2} onChange={e => set('step_overhead_min', e.target.value)} /></div>
      <div className="field"><label>Volume window, hours</label><input type="number" min="1" value={s.volume_window_h ?? 24} onChange={e => set('volume_window_h', e.target.value)} /></div>
      <div className="field"><label title="A market whose traded prices over the window disagree by this much is treated as inactive: you buy at its dearest and sell at its cheapest, never the average.">Inactive market, prices apart by</label>
        <input type="number" min="1" step="0.5" value={s.wide_spread ?? 2} onChange={e => set('wide_spread', e.target.value)} /></div>
      <p className="hint">Ranking weights — the default sort blends these; velocity leads.</p>
      {WEIGHTS.map(([k, l]) => (
        <div className="field" key={k}><label>{l}</label>
          <input type="number" step="0.05" min="0" value={s.rank_weights?.[k] ?? 0} onChange={e => setWeight(k, e.target.value)} /></div>
      ))}
    </details>
  )
}
