// The renderer's ONE narrow path to diagnostics telemetry: poe2desktop.diag.log(marker, line) →
// ipcMain 'diag:log' → this bridge → telemetry.installLog (which is itself gated on the beta/dev
// channel). Allow-listed markers only, a 300-char clamp, and a 30-lines-per-minute budget so a
// renderer bug can never flood the server. Never pass q, raw clipboard, or a full slug.
'use strict'

const DIAG_MARKERS = ['ee2', 'ws', 'sales']
const MAX_LINE = 300
const BUDGET = 30          // lines per window
const WINDOW_MS = 60_000

function makeDiagBridge({ installLog, now = Date.now }) {
  let windowStart = now(), used = 0
  return function log(marker, line) {
    if (!DIAG_MARKERS.includes(marker) || typeof line !== 'string') return false
    const t = now()
    if (t - windowStart >= WINDOW_MS) { windowStart = t; used = 0 }
    if (used >= BUDGET) return false
    used++
    installLog(marker, line.slice(0, MAX_LINE))
    return true
  }
}

module.exports = { DIAG_MARKERS, MAX_LINE, BUDGET, makeDiagBridge }
