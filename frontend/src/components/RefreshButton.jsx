import React, { useState } from 'react'

// The app's single refresh control: an icon-only button (no "Refresh"/"Live" text) that
// spins on activation. One mechanism covers both cases via an infinite spin that self-stops
// after a whole rotation: a quick one-shot for instant actions, and continuous spin while a
// parent-driven `busy` load is in flight (it keeps spinning until busy clears, then finishes
// the current rotation cleanly — never a jarring mid-spin stop). Reduced-motion slows it.
export default function RefreshButton({ onClick, busy = false, title = 'Refresh', className = '', disabled = false }) {
  const [spin, setSpin] = useState(false)
  const activate = (e) => { setSpin(true); onClick?.(e) }
  // End the one-shot after a full turn — unless a busy load is still running (keep spinning).
  const onIter = () => { if (!busy) setSpin(false) }
  return (
    <button type="button" className={`refresh-btn ${busy || spin ? 'spinning' : ''} ${className}`.trim()}
      title={title} aria-label={title} disabled={disabled || busy} onClick={activate} onAnimationIteration={onIter}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
        <path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      </svg>
    </button>
  )
}
