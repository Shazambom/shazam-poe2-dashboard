import React from 'react'

// Exact numbers, not sliders (owner, 2026-09-24): people are precise about the mods they want.
// Clamped to its range; blank means the minimum, or "any" when a placeholder says so.
export default function Num({ label, value, min, max, onChange, placeholder, step = 1 }) {
  const clamp = (raw) => { if (raw === '') return min; const n = Math.floor(Number(raw)); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min }
  const onKey = (e) => {
    // Shift+↑/↓ steps by ten: a level box is scrubbed, not typed, when checking a craft.
    if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); onChange(clamp(Number(value || min) + (e.key === 'ArrowUp' ? 10 : -10))) }
  }
  return (
    <div className="field rx-num">
      <label>{label}</label>
      <input type="number" inputMode="numeric" min={min} max={max} step={step} value={value === 0 && placeholder ? '' : value} placeholder={placeholder}
             onChange={e => onChange(clamp(e.target.value))} onKeyDown={onKey} onFocus={e => e.target.select()} />
    </div>
  )
}
