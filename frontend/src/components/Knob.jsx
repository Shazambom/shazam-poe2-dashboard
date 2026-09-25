import React from 'react'

// One bounded slider: label with the current value, the range, and what its two ends mean.
// Sliders, not number boxes (owner, 2026-09-23): the only values on offer are the ones that mean
// anything. Reuses the gold slider's classes; no CSS of its own.
export default function Knob({ label, value, min, max, step, ends, fmt, title, onChange }) {
  return (
    <div className="gold-slider-wrap" title={title}>
      <div className="gold-slider-label">{label} <b>{fmt(value)}</b></div>
      <input className="gold-slider" type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} />
      <div className="gold-slider-ends"><span>{ends[0]}</span><span>{ends[1]}</span></div>
    </div>
  )
}
