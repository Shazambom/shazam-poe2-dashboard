import React, { useEffect, useState } from 'react'
import { useStatus, ensureSettings } from '../lib/statusStore.js'
import { DEFAULT_NOTIFICATIONS, notify, osNotify } from '../lib/notifications.js'
import { playPing, TONES } from '../lib/ping-sound.js'
import { isDesktop } from '../lib/session.js'
import Toggle from './Toggle.jsx'

const FAMILIES = [
  ['live', 'Live trade pings', 'a watched search finds a listing'],
  ['signals', 'Market signals', "the analytics sidecar flags something 'about to move'"],
]
const CHANNELS = [
  ['banner', 'In-app banner', 'a card in the top-right stack with an Open action'],
  ['sound', 'Sound', 'a chime (also when the window is hidden) — pick which one per row'],
  ['os', 'OS notification', isDesktop ? 'a native system notification' : 'a browser notification (needs permission)'],
]

// Settings → Notifications: every alert the app can raise, per family and per channel, plus the
// shared volume. Persists into settings.notifications (the only thing notify() consults).
export default function NotificationsPanel() {
  const [n, setN] = useState(null)
  useEffect(() => { ensureSettings().then(s => setN(merge(s?.notifications))).catch(() => setN(merge())) }, [])
  if (!n) return null
  const save = (next) => { setN(next); useStatus.getState().saveSettings({ notifications: next }).catch(() => {}) }
  const setFlag = (fam, ch, v) => {
    save({ ...n, [fam]: { ...n[fam], [ch]: v } })
    // Turning OS notifications on sends a sample immediately, so the system's allow prompt (and
    // where the notification lands) is visible right here rather than on the first real alert.
    if (ch === 'os' && v) osNotify('Arbiter notifications are on', fam === 'live' ? 'Live trade pings will appear here.' : 'Market signals will appear here.', { tag: `enable-${fam}` })
  }
  const test = (fam) => notify(fam, { title: `Test: ${fam === 'live' ? 'live ping' : 'market signal'}`, body: 'Notification test', id: `test-${fam}`, ttl: 4000,
    node: <div className="ping-banner"><span className="pb-dot online" /><div className="pb-main"><div className="pb-name">Test notification</div><div className="pb-sub muted">{fam === 'live' ? 'a live trade ping would look like this' : 'a market signal would look like this'}</div></div></div> })
  return (
    <section className="settings-section">
      <h3>Notifications</h3>
      <table className="notif-table">
        <thead><tr><th></th>{CHANNELS.map(([k, label, hint]) => <React.Fragment key={k}><th title={hint}>{label}</th>{k === 'sound' && <th title="which chime this family plays">Tone</th>}</React.Fragment>)}<th></th></tr></thead>
        <tbody>
          {FAMILIES.map(([fam, label, hint]) => (
            <tr key={fam}>
              <td><b>{label}</b><div className="muted" style={{ fontSize: 12 }}>{hint}</div></td>
              {CHANNELS.map(([ch]) => (
                <React.Fragment key={ch}>
                  <td><Toggle checked={!!n[fam][ch]} onChange={v => setFlag(fam, ch, v)} /></td>
                  {ch === 'sound' && (
                    <td className="notif-tone">
                      <select className="league-select" value={n[fam].tone || 'vaal'} disabled={!n[fam].sound}
                        onChange={e => { setFlag(fam, 'tone', e.target.value); playPing(n.volume, e.target.value, { preview: true }) }}>
                        {Object.entries(TONES).map(([id, t]) => <option key={id} value={id}>{t.label}</option>)}
                      </select>
                      <button className="btn small" title="Preview this tone" disabled={!n[fam].sound}
                        onClick={() => playPing(n.volume, n[fam].tone, { preview: true })}>▶</button>
                    </td>
                  )}
                </React.Fragment>))}
              <td><button className="btn small" title="Fires this row's enabled channels" onClick={() => test(fam)}>Test</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="set-row">
        <span style={{ width: 120 }}>Ping volume</span>
        <input type="range" min="0" max="1" step="0.05" value={n.volume} onChange={e => save({ ...n, volume: Number(e.target.value) })} />
        <button className="btn small" onClick={() => playPing(n.volume, n.live.tone, { preview: true })}>Play</button>
      </div>
      {!isDesktop && (n.live.os || n.signals.os) && typeof Notification !== 'undefined' && Notification.permission !== 'granted' && (
        <p className="hint">Your browser has not granted notification permission — <button className="link-btn" onClick={() => Notification.requestPermission()}>allow</button>.</p>
      )}
    </section>
  )
}

function merge(n) {
  const fam = (k) => {
    const f = { ...DEFAULT_NOTIFICATIONS[k], ...(n?.[k] || {}) }
    if (!(f.tone in TONES)) f.tone = DEFAULT_NOTIFICATIONS[k].tone   // a retired tone id → the default
    return f
  }
  return { volume: typeof n?.volume === 'number' ? n.volume : DEFAULT_NOTIFICATIONS.volume, live: fam('live'), signals: fam('signals') }
}
