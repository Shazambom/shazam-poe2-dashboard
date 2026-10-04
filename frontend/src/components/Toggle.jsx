import React from 'react'

// The app's only on/off control — a themed slider switch. Raw checkbox inputs are
// BANNED (enforced by npm run lint:style); use this everywhere instead. It's a single
// role="switch" button (track + thumb + optional label) so clicking anywhere toggles, with
// keyboard + aria-checked support. onChange receives the NEW boolean value.
// `checked="some"` is the half state of a switch that sets a group (some members on): it is announced
// as a mixed checkbox (a switch has no mixed state) and turns everything on. `size="sm"` is the compact switch for dense rows.
export default function Toggle({ checked, onChange, label, title, disabled = false, ariaLabel = null, size = null }) {
  const on = checked !== 'some' && !!checked
  return (
    <button type="button" role={checked === 'some' ? 'checkbox' : 'switch'} aria-checked={checked === 'some' ? 'mixed' : on} aria-label={ariaLabel || undefined} disabled={disabled} title={title}
      className={`toggle ${on ? 'on' : checked === 'some' ? 'some' : ''} ${size === 'sm' ? 'sm' : ''}`} onClick={() => onChange(!on)}>
      <span className="toggle-track"><span className="toggle-thumb" /></span>
      {label != null && <span className="toggle-label">{label}</span>}
    </button>
  )
}
