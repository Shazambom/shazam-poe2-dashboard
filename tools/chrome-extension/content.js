// Bridge between the dashboard page and the extension background worker.
// The page can't read the HttpOnly POESESSID; this relay can ask the background
// worker (which has the cookies permission) to fetch it and hand it to the
// dashboard's own /api/session endpoint.

// Announce the extension so the page can show the one-click button.
const announce = () => window.postMessage({ source: 'poe2arb-ext', cmd: 'hello' }, window.location.origin)
announce()
document.addEventListener('DOMContentLoaded', announce)

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return
  const m = event.data
  if (!m || m.source !== 'poe2arb') return
  if (m.cmd === 'ping') { announce(); return }   // the app mounts after our announce
  if (m.cmd !== 'connect') return
  chrome.runtime.sendMessage({ cmd: 'connect', origin: window.location.origin }, (resp) => {
    window.postMessage({ source: 'poe2arb-ext', cmd: 'connect-result', ...(resp || { ok: false, message: 'extension error' }) }, window.location.origin)
  })
})

// Background pushes a result here after a deferred connect (login-first flow).
chrome.runtime.onMessage.addListener((m) => {
  if (m && m.cmd === 'connect-result') {
    window.postMessage({ source: 'poe2arb-ext', cmd: 'connect-result', ok: m.ok, message: m.message }, window.location.origin)
  }
})
