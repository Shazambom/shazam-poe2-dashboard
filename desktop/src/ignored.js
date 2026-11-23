// The one handler for errors the desktop runtime deliberately carries on past: a send to a window
// that has closed, a kill of a process that is already gone, a best-effort cleanup at quit. Every
// such catch calls ignored(scope, err) instead of staying empty, so the failure reaches the
// "Report a problem" log ring: the first failure of each scope is written with console.log (main.js
// feeds every console.log line into the ring), later ones are only counted, so a loop that fails on
// every tick cannot flood the ring. It stays on this machine (no telemetry), and it never throws,
// whatever the error value is and even when the console is broken (a closed stdout at quit), so
// adding it to a catch never changes what the code around it does.
'use strict'

const counts = new Map()   // scope → how many times it was ignored
let unwritten = 0          // first failures whose line could not be written

function describe(err) {
  try {
    if (err instanceof Error) return err.message || err.name
    return String(err)
  } catch {
    return Object.prototype.toString.call(err)
  }
}

/**
 * @param {string} scope where it happened, e.g. 'trade:send' (one log line per scope)
 * @param {unknown} err what was thrown
 */
function ignored(scope, err) {
  try {
    const n = (counts.get(scope) || 0) + 1
    counts.set(scope, n)
    if (n === 1) console.log(`[ignored] ${scope}: ${describe(err)}`)
  } catch {
    unwritten++
  }
}

/** How often each scope was ignored (for tests and diagnostics). */
const ignoredCounts = () => new Map(counts)
const unwrittenCount = () => unwritten

module.exports = { ignored, ignoredCounts, unwrittenCount }
