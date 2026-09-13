// One place that knows how to connect the PoE trade session, whichever shell
// we're running in. Both the top-bar button and the Settings panel use it.
//
//   * desktop app  → window.poe2desktop.connectSession() (Electron opens the
//                    login window and reads the HttpOnly cookie natively)
//   * browser + extension → postMessage handshake with the content script
//   * plain browser → no bridge; caller falls back to paste/helper
import { toast } from './api.js'

let extReady = false
if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    if (e.source === window && e.origin === window.location.origin &&
        e.data && e.data.source === 'poe2arb-ext' && e.data.cmd === 'hello') extReady = true
  })
  // Prod the content script to re-announce (the app mounts after its first hello).
  try { window.postMessage({ source: 'poe2arb', cmd: 'ping' }, window.location.origin) } catch {}
}

export function connectBridge() {
  if (typeof window === 'undefined') return null
  if (window.poe2desktop) return 'desktop'
  if (extReady) return 'extension'
  return null
}

// Returns a promise resolving to { ok, message }. Never rejects.
export function connectSession() {
  const bridge = connectBridge()
  if (bridge === 'desktop') {
    return window.poe2desktop.connectSession()
      .then(r => r || { ok: false, message: 'no response' })
      .catch(e => ({ ok: false, message: String(e.message || e) }))
  }
  if (bridge === 'extension') {
    return new Promise((resolve) => {
      const onMsg = (e) => {
        if (e.source !== window || e.origin !== window.location.origin) return
        const m = e.data
        if (!m || m.source !== 'poe2arb-ext' || m.cmd !== 'connect-result') return
        window.removeEventListener('message', onMsg)
        clearTimeout(timer)
        resolve({ ok: !!m.ok, message: m.message })
      }
      window.addEventListener('message', onMsg)
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg)
        resolve({ ok: false, message: 'No answer from the extension — reload it on chrome://extensions and refresh.' })
      }, 10000)
      window.postMessage({ source: 'poe2arb', cmd: 'connect' }, window.location.origin)
    })
  }
  return Promise.resolve({ ok: false, message: 'no bridge' })
}

// Convenience for the top bar: connect, toast the result, run onDone on success.
export async function connectSessionWithToast(onDone) {
  const r = await connectSession()
  toast(r.message, r.ok !== false)
  if (r.ok) onDone?.()
  return r
}
