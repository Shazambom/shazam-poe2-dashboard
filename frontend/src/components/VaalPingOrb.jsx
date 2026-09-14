import React, { useEffect, useState } from 'react'
import { usePings } from '../lib/pingStore.js'
import { useIcons, lookup } from '../lib/icons.js'

// The live-ping alert: a corrupted-red Vaal Orb that materialises on the Trading tab when
// watched items ping, echoing BrandOrb's spinning-currency aesthetic. Intensity encodes
// urgency and is derived from ping STATE + timestamps (never a rAF loop), so it's correct
// even after the tab was backgrounded (Chrome freezes hidden-tab animations). Respects
// prefers-reduced-motion (CSS swaps spin/pulse for a static glow).
export default function VaalPingOrb({ onClick }) {
  useIcons()
  const unseen = usePings(s => s.unseen)
  const newest = usePings(s => s.pings[0] || null)
  const [, tick] = useState(0)

  // Re-evaluate intensity as the token ages (1s interval, not rAF — hidden-tab safe).
  useEffect(() => {
    if (!newest) return
    const t = setInterval(() => tick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [newest])

  if (unseen <= 0 && !newest) return null

  const vaal = lookup({ id: 'vaal' })?.icon
  const intensity = computeIntensity(newest)

  return (
    <button className={`vaal-orb ${intensity}`} onClick={onClick}
      title={newest ? `Live ping: ${newest.item?.name || 'item'} — click to view` : 'Live pings'}
      aria-label={`${unseen} live ping${unseen === 1 ? '' : 's'}`}>
      {vaal
        ? <img className="vaal-orb-img" src={vaal} alt="" width="20" height="20" />
        : <span className="vaal-orb-glyph">◈</span>}
      {unseen > 0 && <span className="vaal-orb-badge">{unseen > 99 ? '99+' : unseen}</span>}
    </button>
  )
}

// hot = fresh + seller online; cooling = token nearing ~5min expiry; shatter = sold/gone.
function computeIntensity(p) {
  if (!p) return 'idle'
  if (p.flags?.gone) return 'shatter'
  const msLeft = p.tokenExp ? p.tokenExp - Date.now() : Infinity
  if (msLeft <= 0) return 'cold'
  if (msLeft < 90_000) return 'cooling'
  return p.online === 'online' ? 'hot' : p.online === 'afk' ? 'warm' : 'cool'
}
