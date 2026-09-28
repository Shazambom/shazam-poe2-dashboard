import React, { useEffect, useRef, useState } from 'react'
import { useStatus, ensureSettings } from '../lib/statusStore.js'

// CAUTION: how much a steady price is worth to you. The board ranks kept value, steadiness, a
// steady climb and price (holdscore.hold_rank); this sets steadiness's weight (k / default). At 0
// a dip doesn't count; turned up, an asset that never dipped wins over one that recovered.
//
// Range and default come from the backend (`k_range`, `k`) so there is one source of truth —
// see docs/bugs/2026-09-20-hold-ranks-against-its-own-forecast.md for why it stops at 6.
// Reuses the gold slider's presentation classes; no new CSS.
export default function CautionSlider({ value, range, onChange }) {
  const [lo, hi] = range || [0, 6]
  const [k, setK] = useState(value ?? 2)
  const timer = useRef(null)
  const dragging = useRef(false)

  // Follow the server's value until the user touches it (it owns the default).
  useEffect(() => { if (!dragging.current && value != null) setK(value) }, [value])
  useEffect(() => { ensureSettings().catch(() => {}) }, [])

  const commit = (next) => {
    dragging.current = true
    setK(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      dragging.current = false
      onChange?.(next)                                     // re-rank now
      useStatus.getState().saveSettings({ hold_caution: next }).catch(() => {})
    }, 350)                                                // debounce the drag, then persist
  }

  return (
    <div className="gold-slider-wrap" title="How cautious the board is: how much a steady price counts against a bigger gain">
      <div className="gold-slider-label">Caution <b>{k.toFixed(1)}</b></div>
      <input className="gold-slider" type="range" min={lo} max={hi} step="0.1" value={k}
        onChange={e => commit(Number(e.target.value))} />
      <div className="gold-slider-ends"><span>chase gains</span><span>hold value</span></div>
    </div>
  )
}
