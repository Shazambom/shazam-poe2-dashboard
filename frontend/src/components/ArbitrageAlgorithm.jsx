import React, { useEffect, useState } from 'react'
import { useAutosave } from '../lib/hooks.js'
import { useStatus } from '../lib/statusStore.js'

// The route-search knobs, on the page they affect: loop length, how much capital a loop may
// commit, the ranking blend, and the two pacing inputs. Collapsed by default under Filters — the
// user tweaks them here instead of walking to Settings. Same settings blob, same debounced save.
const WEIGHTS = [['velocity', 'Velocity'], ['margin_per_1k_gold', 'Gold efficiency'], ['margin_ref', 'Margin value'], ['volume', 'Traded volume']]
const num = (v, fb) => { const n = Number(v); return Number.isFinite(n) ? n : fb }

// One bounded slider: label with the current value, the range, and what its two ends mean.
function Knob({ label, value, min, max, step, ends, fmt, title, onChange }) {
  return (
    <div className="gold-slider-wrap" title={title}>
      <div className="gold-slider-label">{label} <b>{fmt(value)}</b></div>
      <input className="gold-slider" type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} />
      <div className="gold-slider-ends"><span>{ends[0]}</span><span>{ends[1]}</span></div>
    </div>
  )
}

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
      {/* Sliders, not number boxes (owner, 2026-09-23): the only values on offer are the ones that
          mean anything. Each reuses the gold slider's classes; no new CSS. */}
      <Knob label="Maximum steps per loop" value={num(s.max_steps, 3)} min="2" max="5" step="1" ends={['short', 'long']}
            fmt={v => `${v}`} onChange={v => set('max_steps', v)} />
      <Knob label="Fraction of held capital to commit" value={num(s.max_start_fraction, 1)} min="0.05" max="1" step="0.05" ends={['a little', 'all of it']}
            fmt={v => `${Math.round(v * 100)}%`} onChange={v => set('max_start_fraction', v)} />
      <Knob label="Minutes per exchange step" value={num(s.step_overhead_min, 2)} min="0" max="15" step="0.5" ends={['instant', 'slow']}
            fmt={v => `${v.toFixed(1)} min`} onChange={v => set('step_overhead_min', v)} />
      <Knob label="Volume window, hours" value={num(s.volume_window_h, 24)} min="1" max="168" step="1" ends={['1h', '7d']}
            fmt={v => `${v}h`} onChange={v => set('volume_window_h', v)} />
      <Knob label="Inactive market, prices apart by" value={num(s.wide_spread, 2)} min="1" max="5" step="0.5" ends={['strict', 'lenient']}
            title="A market whose traded prices over the window disagree by this much is treated as inactive: you buy at its dearest and sell at its cheapest, never the average."
            fmt={v => `${v.toFixed(1)}×`} onChange={v => set('wide_spread', v)} />
      <p className="hint">Ranking weights — the default sort blends these; velocity leads.</p>
      {WEIGHTS.map(([k, l]) => (
        <Knob key={k} label={l} value={num(s.rank_weights?.[k], 0)} min="0" max="1" step="0.05" ends={['ignore', 'decides']}
              fmt={v => v.toFixed(2)} onChange={v => setWeight(k, v)} />
      ))}
    </details>
  )
}
