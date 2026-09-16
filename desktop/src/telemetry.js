// The ONE sender for every diagnostic POST from the desktop app to the shazam dev server.
//
// Desktop contract (CLAUDE.md): the packaged app calls the server for updates only. Telemetry is
// the sanctioned diagnostic exception and is BETA/DEV-ONLY IN EVERY CASE (owner directive
// 2026-09-16) — `configure({ enabled })` is wired to the beta-channel gate in main.js, and every
// sender (backend spawn/exit, updater, login window, EE2 hooks) goes through installLog(), so
// there is exactly one place that decides whether anything leaves the machine. Bodies are plain
// text: never secrets, keystrokes, or raw clipboard.
'use strict'

const SHAZAM = 'http://192.168.1.250:8080'

let _enabled = () => false
let _version = () => '?'

// enabled(): boolean — the gate. version(): string — prefixed onto every line.
function configure({ enabled, version }) {
  if (enabled) _enabled = enabled
  if (version) _version = version
}

// marker = the `?p=` tag the server files the line under (backend | update | login | ee2 | sidecar).
function installLog(marker, body, { max = 4000 } = {}) {
  try {
    if (!_enabled()) return
    const text = `v${_version()} ${process.platform} ${String(Array.isArray(body) ? body.join('\n') : body)}`.slice(0, max)
    fetch(`${SHAZAM}/api/installlog?p=${encodeURIComponent(marker)}`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text,
    }).catch(() => {})
  } catch {}
}

module.exports = { SHAZAM, configure, installLog }
