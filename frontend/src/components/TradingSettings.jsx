import React, { useEffect, useState } from 'react'
import { toast } from '../lib/api.js'
import { useStatus } from '../lib/statusStore.js'
import { getSoundPrefs, setSoundPrefs, playPing } from '../lib/ping-sound.js'
import Toggle from './Toggle.jsx'
import { isDesktop } from '../lib/session.js'


// Trading settings: live-ping sound + the global focus hotkey. Self-persisting.
export default function TradingSettings() {
  const [prefs, setPrefs] = useState(getSoundPrefs())
  const [hotkey, setHotkey] = useState('CommandOrControl+G')
  const [capturing, setCapturing] = useState(false)

  useEffect(() => {
    if (window.poe2desktop?.hotkey) window.poe2desktop.hotkey.get().then(r => setHotkey(r?.combo || 'CommandOrControl+G')).catch(() => {})
  }, [])

  const save = (patch) => {
    const next = { ...prefs, ...patch }
    setPrefs(next); setSoundPrefs(next)
    useStatus.getState().saveSettings({ ping_sound: next.on, ping_volume: next.volume }).catch(() => {})
  }

  // Capture a key combo for the hotkey (desktop).
  const onKey = (e) => {
    if (!capturing) return
    e.preventDefault()
    const mods = []
    if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl')
    if (e.altKey) mods.push('Alt')
    if (e.shiftKey) mods.push('Shift')
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return
    const combo = [...mods, key].join('+')
    setCapturing(false)
    window.poe2desktop.hotkey.set(combo).then(r => {
      if (r?.ok) { setHotkey(combo); toast(`Hotkey set to ${combo}`) }
      else toast(`${combo} is taken by another app — pick another`, false)
    })
  }

  return (
    <section className="settings-section">
      <h3>Trading</h3>
      <div className="set-row">
        <Toggle checked={prefs.on} onChange={v => save({ on: v })} label="Play a sound on each live-search ping" />
      </div>
      <div className="set-row">
        <span style={{ width: 120 }}>Ping volume</span>
        <input type="range" min="0" max="1" step="0.05" value={prefs.volume}
          onChange={e => save({ volume: Number(e.target.value) })} disabled={!prefs.on} />
        <button className="btn small" onClick={playPing} disabled={!prefs.on}>Test</button>
      </div>
      {isDesktop ? (
        <div className="set-row">
          <span style={{ width: 120 }}>Focus hotkey</span>
          <button className="btn small" tabIndex={0} onKeyDown={onKey} onClick={() => setCapturing(true)}>
            {capturing ? 'Press a combo…' : hotkey.replace('CommandOrControl', '⌘/Ctrl')}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>raises Arbiter to Trading → Live</span>
        </div>
      ) : (
        <div className="set-row muted" style={{ fontSize: 12 }}>Global focus hotkey is available in the desktop app.</div>
      )}
    </section>
  )
}
