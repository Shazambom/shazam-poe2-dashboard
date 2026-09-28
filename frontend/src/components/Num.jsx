import React, { useState } from 'react'
import { typed, settle } from '../lib/numInput.js'

// Exact numbers, not sliders (owner, 2026-09-24): people are precise about the mods they want.
// While focused the box holds what was typed: a number in range applies at once, a blank or
// out-of-range one waits and settles (clamped; blank means the minimum, or "any" when a
// placeholder says so) when the box loses focus (lib/numInput.js).
export default function Num({ label, value, min, max, onChange, placeholder, step = 1 }) {
  const [draft, setDraft] = useState(null)
  const onKey = (e) => {
    // Shift+↑/↓ steps by ten: a level box is scrubbed, not typed, when checking a craft.
    if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      setDraft(null)
      onChange(settle(Number(value || min) + (e.key === 'ArrowUp' ? 10 : -10), min, max))
    }
    if (e.key === 'Enter') e.target.blur()
  }
  const onType = (e) => {
    setDraft(e.target.value)
    const n = typed(e.target.value, min, max)
    if (n != null) onChange(n)
  }
  const onBlur = () => {
    if (draft == null) return
    onChange(settle(draft, min, max))
    setDraft(null)
  }
  const shown = draft ?? (value === 0 && placeholder ? '' : value)
  return (
    <div className="field rx-num">
      <label>{label}</label>
      <input type="number" inputMode="numeric" min={min} max={max} step={step} value={shown} placeholder={placeholder}
             onChange={onType} onBlur={onBlur} onKeyDown={onKey} onFocus={e => e.target.select()} />
    </div>
  )
}
