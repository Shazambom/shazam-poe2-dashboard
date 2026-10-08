// Knobs are for tweakers (owner, 2026-10-08): numeric arbitrage controls and the Settings plumbing show on beta and
// dev clients only; a stable client shows presets. The desktop answers `getChannel()` with `tweaks`, the one
// beta-or-dev gate it already keeps for diagnostics (diagTelemetryOn); the web test env has no bridge and is the
// staging surface, so it shows them. Not a setting: the existing channel gate. The Beta toggle hands its answer to
// `refreshTweaks`, so the knobs follow it at once.
import { useEffect, useState } from 'react'
import { isDesktop } from './session.js'

export const tweaksOn = ({ desktop, channel }) => (desktop ? !!channel?.tweaks : true)

let cached = null
const subs = new Set()
export const currentTweaks = () => cached
export function refreshTweaks(channel) {   // the desktop's own answer: it is a desktop
  cached = tweaksOn({ desktop: true, channel })
  subs.forEach(fn => fn(cached))
  return channel
}
const ask = async () => {
  if (cached != null) return cached
  if (!isDesktop) return (cached = true)
  try { refreshTweaks(await window.poe2desktop.getChannel?.()) } catch { cached = false }
  return cached
}

// False until the desktop answers; a stable client never flashes the knobs.
export function useTweaks() {
  const [on, setOn] = useState(cached ?? false)
  useEffect(() => {
    let live = true
    const fn = (v) => { if (live) setOn(v) }
    subs.add(fn)
    ask().then(fn)
    return () => { live = false; subs.delete(fn) }
  }, [])
  return on
}
