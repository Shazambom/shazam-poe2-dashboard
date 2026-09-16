import React, { useEffect, useState } from 'react'
import { toast } from '../lib/api.js'
import { isDesktop } from '../lib/session.js'


// Trading settings: the global focus hotkey (desktop). Notifications live in NotificationsPanel.
export default function TradingSettings() {
  const [hotkey, setHotkey] = useState('CommandOrControl+G')
  const [capturing, setCapturing] = useState(false)

  useEffect(() => {
    if (window.poe2desktop?.hotkey) window.poe2desktop.hotkey.get().then(r => setHotkey(r?.combo || 'CommandOrControl+G')).catch(() => {})
  }, [])

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
