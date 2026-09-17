import React from 'react'

// The app's only on/off control — a themed slider switch. Raw checkbox inputs are
// BANNED (enforced by npm run lint:style); use this everywhere instead. It's a single
// role="switch" button (track + thumb + optional label) so clicking anywhere toggles, with
// keyboard + aria-checked support. onChange receives the NEW boolean value.
export default function Toggle({ checked, onChange, label, title, disabled = false, ariaLabel = null }) {
  return (
    <button type="button" role="switch" aria-checked={!!checked} aria-label={ariaLabel || undefined} disabled={disabled} title={title}
      className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="toggle-track"><span className="toggle-thumb" /></span>
      {label != null && <span className="toggle-label">{label}</span>}
    </button>
  )
}
