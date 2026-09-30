// Restart policy for the bundled backend. An exit we did not ask for (a crash, the OS killing it) is
// followed by a restart, 1s after the first crash and doubling to 60s while it keeps dying; a backend
// that ran for a minute or more earns a quick restart again. An exit we asked for (quit, update
// install) is never restarted. Without this a backend crash left every /api call failing until the
// user relaunched (audit 2026-09-29).
const FIRST_MS = 1000
const MAX_MS = 60 * 1000
const HEALTHY_MS = 60 * 1000

function createRespawner({ start, schedule = setTimeout, cancel = clearTimeout, now = Date.now }) {
  let delay = FIRST_MS
  let startedAt = 0
  let pending = null
  let stopped = false
  return {
    started() { startedAt = now() },
    // Returns the delay before the restart, or null when none is scheduled.
    exited({ requested }) {
      if (requested || stopped) return null
      if (now() - startedAt >= HEALTHY_MS) delay = FIRST_MS
      const wait = delay
      delay = Math.min(MAX_MS, delay * 2)
      pending = schedule(() => { pending = null; start() }, wait)
      return wait
    },
    // Quit / update install: cancel a restart that is waiting and never restart again.
    stop() {
      stopped = true
      if (pending) cancel(pending)
      pending = null
    },
  }
}

// Call `cb` once when a child is gone: it exited, or it never started. Node emits 'error' then 'close'
// but never 'exit' when the binary cannot be spawned (ENOENT: quarantined by antivirus, EACCES), so a
// restart keyed on 'exit' alone stopped for good.
function onceGone(child, cb) {
  let done = false
  const fire = (why) => { if (!done) { done = true; cb(why) } }
  child.on('exit', (code, signal) => fire({ code, signal, error: null }))
  child.on('error', (e) => { if (!child.pid) fire({ code: null, signal: null, error: (e && e.code) || String(e && e.message || e) }) })
}

module.exports = { createRespawner, onceGone }
