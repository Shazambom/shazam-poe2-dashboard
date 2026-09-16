import { bus } from './api.js'
import { useStatus } from './statusStore.js'
import { playPing } from './ping-sound.js'

// THE notification dispatcher. Two families (live trade pings, market signals) × three channels
// (in-app banner in the toast stack, the ping sound, an OS notification). What fires is decided
// by settings.notifications (Settings → Notifications): banner + sound on by default, OS off.
// Everything that wants to alert the user calls notify(family, …) — never a channel directly.
export const DEFAULT_NOTIFICATIONS = {
  volume: 0.5,
  live: { banner: true, sound: true, os: false },
  signals: { banner: true, sound: true, os: false },
}

export function notifyPrefs() {
  const n = useStatus.getState().settings?.notifications || {}
  return {
    volume: typeof n.volume === 'number' ? n.volume : DEFAULT_NOTIFICATIONS.volume,
    live: { ...DEFAULT_NOTIFICATIONS.live, ...(n.live || {}) },
    signals: { ...DEFAULT_NOTIFICATIONS.signals, ...(n.signals || {}) },
  }
}

// OS-level notification. Electron routes renderer Notifications to the native notifier (survives
// a hidden window; permission is effectively granted); a plain browser may refuse — never throw.
function osNotify(title, body, { tag, onClick } = {}) {
  try {
    if (typeof window === 'undefined' || !('Notification' in window)) return null
    const n = new Notification(title, { body, tag, silent: true })
    if (onClick) n.onclick = () => { onClick(); try { window.focus?.() } catch {} }
    return n
  } catch { return null }
}

let channels = { sound: (volume) => playPing(volume), os: osNotify }
export function setChannels(patch) { channels = { ...channels, ...patch } }   // tests

// family: 'live' | 'signals'. `node` is the banner's React node (rendered in the toast stack under
// `id`, replacing the previous banner of that family); `ttl` its lifetime; `onOpen` the OS click.
export function notify(family, { title, body, node, id = family, ttl = 10000, tag, onOpen } = {}) {
  const p = notifyPrefs()[family] || DEFAULT_NOTIFICATIONS.live
  if (p.banner && node) bus.emit({ id, ttl, node })
  if (p.sound) channels.sound(notifyPrefs().volume)
  if (p.os) channels.os(title, body, { tag, onClick: onOpen })
}
