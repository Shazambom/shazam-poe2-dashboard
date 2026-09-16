// OS-level notification, one home for both ping families (live trade pings, market signals).
// Electron routes renderer Notifications to the native notifier (survives a hidden window);
// permission is effectively granted there. A plain browser may refuse — never throw.
export function osNotify(title, body, { tag, onClick } = {}) {
  try {
    if (typeof window === 'undefined' || !('Notification' in window)) return null
    const n = new Notification(title, { body, tag, silent: true })
    if (onClick) n.onclick = () => { onClick(); try { window.focus?.() } catch {} }
    return n
  } catch { return null }
}
