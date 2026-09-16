import { bus } from './api.js'
import { useStatus } from './statusStore.js'
import { playPing, DEFAULT_TONE } from './ping-sound.js'

// THE notification dispatcher. Two families (live trade pings, market signals) × three channels
// (in-app banner in the toast stack, the ping sound, an OS notification). What fires is decided
// by settings.notifications (Settings → Notifications): banner + sound on by default, OS off.
// Everything that wants to alert the user calls notify(family, …) — never a channel directly.
export const DEFAULT_NOTIFICATIONS = {
  volume: 0.5,
  live: { banner: true, sound: true, os: false, tone: DEFAULT_TONE },
  signals: { banner: true, sound: true, os: false, tone: 'coin' },
}

export function notifyPrefs() {
  const n = useStatus.getState().settings?.notifications || {}
  return {
    volume: typeof n.volume === 'number' ? n.volume : DEFAULT_NOTIFICATIONS.volume,
    live: { ...DEFAULT_NOTIFICATIONS.live, ...(n.live || {}) },
    signals: { ...DEFAULT_NOTIFICATIONS.signals, ...(n.signals || {}) },
  }
}

// OS-level notification. On desktop it is delivered by the Electron MAIN process (shows as
// "Arbiter" in the system's notification center; a click raises the window and echoes the tag
// back so the right onClick runs). On the web it is the browser's Notification API. Never throws.
const clicks = new Map()   // tag -> onClick, for desktop click echoes
let clickSub = false
export function osNotify(title, body, { tag, onClick } = {}) {
  try {
    if (typeof window === 'undefined') return null
    const bridge = window.poe2desktop
    if (bridge?.notify) {
      const t = tag || `n${Date.now()}`
      if (onClick) clicks.set(t, onClick)
      if (!clickSub && bridge.onNotifyClick) { clickSub = true; bridge.onNotifyClick((k) => { const fn = clicks.get(k); clicks.delete(k); fn?.() }) }
      bridge.notify({ title, body, tag: t })
      return true
    }
    if (!('Notification' in window)) return null
    if (Notification.permission === 'default') Notification.requestPermission().catch?.(() => {})
    const n = new Notification(title, { body, tag, silent: true })
    if (onClick) n.onclick = () => { onClick(); try { window.focus?.() } catch {} }
    return n
  } catch { return null }
}

let channels = { sound: (volume, tone) => playPing(volume, tone), os: osNotify }
export function setChannels(patch) { channels = { ...channels, ...patch } }   // tests

// family: 'live' | 'signals'. `node` is the banner's React node (rendered in the toast stack under
// `id`, replacing the previous banner of that family); `ttl` its lifetime; `onOpen` the OS click.
export function notify(family, { title, body, node, id = family, ttl = 10000, tag, onOpen } = {}) {
  const p = notifyPrefs()[family] || DEFAULT_NOTIFICATIONS.live
  if (p.banner && node) bus.emit({ id, ttl, node })
  if (p.sound) channels.sound(notifyPrefs().volume, p.tone)
  if (p.os) channels.os(title, body, { tag, onClick: onOpen })
}
