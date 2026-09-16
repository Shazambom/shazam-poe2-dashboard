import React, { useEffect, useState } from 'react'
import { useStatus, ensureSettings } from '../lib/statusStore.js'
import { DEFAULT_NOTIFICATIONS, notify } from '../lib/notifications.js'
import { playPing } from '../lib/ping-sound.js'
import { isDesktop } from '../lib/session.js'
import Toggle from './Toggle.jsx'

const FAMILIES = [
  ['live', 'Live trade pings', 'a watched search finds a listing'],
  ['signals', 'Market signals', "the analytics sidecar flags something 'about to move'"],
]
const CHANNELS = [
  ['banner', 'In-app banner', 'a card in the top-right stack with an Open action'],
  ['sound', 'Sound', 'the ping chime (also when the window is hidden)'],
  ['os', 'OS notification', isDesktop ? 'a native system notification' : 'a browser notification (needs permission)'],
]

// Settings → Notifications: every alert the app can raise, per family and per channel, plus the
// shared volume. Persists into settings.notifications (the only thing notify() consults).
export default function NotificationsPanel() {
  const [n, setN] = useState(null)
  useEffect(() => { ensureSettings().then(s => setN(merge(s?.notifications))).catch(() => setN(merge())) }, [])
  if (!n) return null
  const save = (next) => { setN(next); useStatus.getState().saveSettings({ notifications: next }).catch(() => {}) }
  const setFlag = (fam, ch, v) => save({ ...n, [fam]: { ...n[fam], [ch]: v } })
  const test = (fam) => notify(fam, { title: `Test: ${fam === 'live' ? 'live ping' : 'market signal'}`, body: 'Notification test', id: `test-${fam}`, ttl: 4000,
    node: <div className="ping-banner"><span className="pb-dot online" /><div className="pb-main"><div className="pb-name">Test notification</div><div className="pb-sub muted">{fam === 'live' ? 'a live trade ping would look like this' : 'a market signal would look like this'}</div></div></div> })
  return (
    <section className="settings-section">
      <h3>Notifications</h3>
      <table className="notif-table">
        <thead><tr><th></th>{CHANNELS.map(([k, label, hint]) => <th key={k} title={hint}>{label}</th>)}<th></th></tr></thead>
        <tbody>
          {FAMILIES.map(([fam, label, hint]) => (
            <tr key={fam}>
              <td><b>{label}</b><div className="muted" style={{ fontSize: 12 }}>{hint}</div></td>
              {CHANNELS.map(([ch]) => <td key={ch}><Toggle checked={!!n[fam][ch]} onChange={v => setFlag(fam, ch, v)} /></td>)}
              <td><button className="btn small" onClick={() => test(fam)}>Test</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="set-row">
        <span style={{ width: 120 }}>Ping volume</span>
        <input type="range" min="0" max="1" step="0.05" value={n.volume} onChange={e => save({ ...n, volume: Number(e.target.value) })} />
        <button className="btn small" onClick={() => playPing(n.volume)}>Play</button>
      </div>
      {!isDesktop && (n.live.os || n.signals.os) && typeof Notification !== 'undefined' && Notification.permission !== 'granted' && (
        <p className="hint">Your browser has not granted notification permission — <button className="link-btn" onClick={() => Notification.requestPermission()}>allow</button>.</p>
      )}
    </section>
  )
}

function merge(n) {
  return {
    volume: typeof n?.volume === 'number' ? n.volume : DEFAULT_NOTIFICATIONS.volume,
    live: { ...DEFAULT_NOTIFICATIONS.live, ...(n?.live || {}) },
    signals: { ...DEFAULT_NOTIFICATIONS.signals, ...(n?.signals || {}) },
  }
}
