// ⚠️ TEMPORARY DEV DIAGNOSTIC — remove/gate before any contract-clean release.
//
// This is the ONE deliberate exception to the desktop contract ("only call the
// server for updates"): it reports EE2 integration hook events to the shazam dev
// server so the developer can verify, remotely, that the hooks actually fire on
// the user's machine when they use EE2. It lives OUTSIDE the integration package
// on purpose — the package itself stays strictly local (see its CLAUDE.md); this
// module is external instrumentation attached only in dev builds.
//
// Privacy: reports event names + minimal identity (item name/rarity/origin, hotkey
// action/shortcut). It never sends raw clipboard text or keystrokes.
'use strict'

const DEV_TELEMETRY_URL = 'http://192.168.1.250:8080/api/installlog?p=ee2'

function post(line) {
  try {
    fetch(DEV_TELEMETRY_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: String(line).slice(0, 500),
    }).catch(() => {})
  } catch {}
}

// Attach to the integration manager's event bus and forward compact diagnostics.
function attachEe2Telemetry(manager, appVersion = '?') {
  const tag = `v${appVersion}`
  post(`${tag} ee2-telemetry attached`)
  manager.on('ee2-detected', (i) => post(`${tag} ee2-detected present=${i.present} method=${i.method} running=${i.running}`))
  manager.on('ee2-missing', () => post(`${tag} ee2-missing`))
  manager.on('started', () => post(`${tag} started`))
  manager.on('stopped', () => post(`${tag} stopped`))
  manager.on('error', (e) => post(`${tag} error ${String(e && e.message || e).slice(0, 160)}`))
  manager.on('ee2-hotkey', (h) => post(`${tag} ee2-hotkey action=${h.action} shortcut="${h.shortcut}"`))
  manager.on('item-checked', (it) => post(`${tag} item-checked origin=${it.origin} rarity=${it.rarity} name="${String(it.name).slice(0, 40)}"`))
  return () => {}   // manager.stop() removes listeners; nothing extra to detach
}

module.exports = { attachEe2Telemetry }
