import React, { useEffect, useState } from 'react'
import { useStatus, ensureSettings } from '../lib/statusStore.js'
import { lookup, useIcons } from '../lib/icons.js'
import Cur from './Cur.jsx'
import { useAutosave } from '../lib/hooks.js'

// How much a Divine is worth in gold shifts across a league, so the player sets it. The slider
// axis is gold-per-Divine on a log scale from 1k → 1M; the stored setting is its inverse,
// gold_value_per_1k (Divine per 1000 gold), which feeds Convert's net-value ranking, Arbitrage
// velocity AND the cash-out (ghost) figures. The thumb is the Divine icon for a bit of flair.
const GPD_MIN = 20_000       // gold per Divine — gold precious end
const GPD_MAX = 10_000_000   // gold per Divine — gold cheap end
const LOG_MIN = Math.log10(GPD_MIN)
const LOG_MAX = Math.log10(GPD_MAX)
const fmtGpd = (g) => g >= 1e6 ? `${(g / 1e6).toFixed(g >= 1e7 ? 0 : 1)}M` : g >= 1e3 ? `${Math.round(g / 1e3)}k` : `${Math.round(g)}`

export default function GoldValueSlider({ onCommit }) {
  useIcons()                                   // re-render once icons load (for the thumb url)
  const [gpd, setGpd] = useState(100000)       // gold per Divine (default gold_value_per_1k 0.01 → 100k)
  // Debounced save, and a value still waiting when the slider goes away (an Arbitrage preset pick redraws it) is sent
  // then, not later: the shared autosave (lib/hooks.js). Then re-rank routes; the cash-out (ghost) is net of gold too.
  const { save, arm } = useAutosave(async (nextGpd) => {
    await useStatus.getState().saveSettings({ gold_value_per_1k: 1000 / nextGpd })
    onCommit?.()
    useStatus.getState().refresh()
  }, 350)

  useEffect(() => {
    arm()                                      // armed at once: a drag before the settings load still saves
    ensureSettings().then(s => {
      const gv = Number(s.gold_value_per_1k) || 0.01
      setGpd(Math.min(GPD_MAX, Math.max(GPD_MIN, Math.round(1000 / gv))))
    }).catch(() => {})
  }, []) // eslint-disable-line

  const commit = (nextGpd) => { setGpd(nextGpd); save(nextGpd) }

  const thumb = lookup({ id: 'divine' })?.icon
  return (
    <div className="gold-slider-wrap">
      <div className="gold-slider-label">
        1 <Cur id="divine" size={16} /> = <b>{fmtGpd(gpd)}</b> gold
      </div>
      <input className="gold-slider" type="range" min={LOG_MIN} max={LOG_MAX} step="0.01"
        value={Math.log10(gpd)}
        style={thumb ? { '--thumb': `url(${thumb})` } : undefined}
        onChange={e => commit(Math.round(10 ** Number(e.target.value)))} />
      <div className="gold-slider-ends"><span>gold precious</span><span>gold cheap</span></div>
    </div>
  )
}
