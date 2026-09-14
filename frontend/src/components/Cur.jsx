import React, { useState } from 'react'
import { useIcons, lookup } from '../lib/icons.js'

// Render a currency as its CDN icon, with the name shown on hover (native title).
// Falls back to text when no icon is known or the image fails to load.
//   <Cur id="exalted" />            icon only, name on hover
//   <Cur name="Divine Orb" />       resolve by name
//   <Cur id="chaos" text />         icon + name inline
export default function Cur({ id, name, size = 18, text = false, className = '' }) {
  const idx = useIcons()                 // re-render once the index loads
  const [broken, setBroken] = useState(false)
  const rec = lookup({ id, name })
  const label = rec?.name || name || id || '?'
  const icon = rec?.icon

  if (!icon || broken) {
    return <span className={`cur cur-text ${className}`} title={label}>{label}</span>
  }
  return (
    <span className={`cur ${className}`} title={label}>
      <img className="cur-img" src={icon} alt={label} width={size} height={size}
        loading="lazy" onError={() => setBroken(true)} />
      {text && <span className="cur-name">{label}</span>}
    </span>
  )
}
