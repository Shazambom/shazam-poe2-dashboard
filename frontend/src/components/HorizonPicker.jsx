import React from 'react'
import { useHorizon, HORIZONS } from '../lib/horizonStore.js'

// The app-wide time-horizon picker (was per-view). Reuses the shared .seg segmented control.
// Sets the global horizon every view respects; persists across sessions.
export default function HorizonPicker() {
  const hours = useHorizon(s => s.hours)
  const setHours = useHorizon(s => s.setHours)
  return (
    <div className="seg horizon-seg" title="Time window — applies across the app">
      {HORIZONS.map(([label, h]) => (
        <button key={h} className={`seg-btn ${hours === h ? 'on' : ''}`} onClick={() => setHours(h)}>{label}</button>
      ))}
    </div>
  )
}
