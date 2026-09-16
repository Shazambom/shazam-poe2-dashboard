import React, { useEffect, useRef, useState } from 'react'
import { useSignals, sigKey } from '../lib/signalStore.js'
import { useIcons, lookup } from '../lib/icons.js'
import Cur from './Cur.jsx'

// The market-signal inbox: a golden Divine Orb that appears in the topbar when the sidecar has
// fired 'about to move' signals — the wealth/economy counterpart to the red Vaal trade-ping orb.
// Global (economy-wide, not tied to any tab). Click → a small inbox popover; a row opens the SAME
// CardDetail the dashboard uses everywhere (no bespoke page). Intensity is derived from the unseen
// count, not a rAF loop, so it's correct after a backgrounded tab; CSS handles reduced-motion.
export default function DivinePingOrb({ onOpenSignal }) {
  useIcons()
  const signals = useSignals(s => s.signals)
  const unseen = useSignals(s => s.unseen)
  const ack = useSignals(s => s.ack)
  const ackAll = useSignals(s => s.ackAll)
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [open])

  if (!signals.length) return null            // nothing fired → no orb (graceful, uncluttered)
  const divine = lookup({ id: 'divine' })?.icon
  const intensity = unseen <= 0 ? 'idle' : unseen >= 3 ? 'hot' : 'warm'

  return (
    <div className="divine-orb-wrap" ref={ref}>
      <button className={`divine-orb ${intensity}`} onClick={() => setOpen(o => !o)}
        title="Market signals — what's about to move"
        aria-label={`${unseen} market signal${unseen === 1 ? '' : 's'}`} aria-expanded={open}>
        {divine
          ? <img className="divine-orb-img" src={divine} alt="" width="20" height="20" />
          : <span className="divine-orb-glyph">◆</span>}
        {unseen > 0 && <span className="divine-orb-badge">{unseen > 99 ? '99+' : unseen}</span>}
      </button>
      {open && (
        <div className="signal-inbox" role="menu">
          <div className="signal-inbox-head">
            <span>What's about to move</span>
            {unseen > 0 && <button className="link-btn" onClick={() => ackAll()}>dismiss all</button>}
          </div>
          <ul className="signal-list">
            {signals.map(s => (
              <li key={sigKey(s)} className={`signal-row ${s.acked ? 'acked' : ''}`}>
                <button className="signal-main" onClick={() => { onOpenSignal(s); setOpen(false) }}
                  title="Open detail">
                  <Cur name={s.name} size={18} />
                  <span className="signal-name">{s.name}</span>
                  <span className="signal-vz" title="volume-confirmed strength (robust z-score)">
                    ×{Number(s.vol_z).toFixed(1)}</span>
                </button>
                {!s.acked && (
                  <button className="signal-x" title="Dismiss" aria-label="Dismiss signal"
                    onClick={() => ack([sigKey(s)])}>×</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
