import React, { useEffect, useState } from 'react'
import { useIcons, lookup, iconFailed, iconLoaded, useIconEpoch } from '../lib/icons.js'

// Render a currency as its CDN icon, with the name shown on hover (native title).
// Falls back to text when no icon is known or the image fails to load — and tries the image again
// on the shared backoff (icons.js), so a CDN hiccup at launch doesn't mean text until restart.
//   <Cur id="exalted" />            icon only, name on hover
//   <Cur name="Divine Orb" />       resolve by name
//   <Cur id="chaos" text />         icon + name inline
export default function Cur({ id, name, size = 18, text = false, className = '' }) {
  const idx = useIcons()                 // re-render once the index loads
  const [broken, setBroken] = useState(false)
  const epoch = useIconEpoch()
  useEffect(() => { setBroken(false) }, [epoch])
  const rec = lookup({ id, name })
  const label = rec?.name || name || id || '?'
  const icon = rec?.icon

  if (!icon || broken) {
    return <span className={`cur cur-text ${className}`} title={label}>{label}</span>
  }
  return (
    <span className={`cur ${className}`} title={label}>
      <img key={epoch} className="cur-img" src={icon} alt={label} width={size} height={size}
        loading="lazy" onLoad={iconLoaded} onError={() => { setBroken(true); iconFailed() }} />
      {text && <span className="cur-name">{label}</span>}
    </span>
  )
}
