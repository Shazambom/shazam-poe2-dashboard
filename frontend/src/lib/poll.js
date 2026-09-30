// Run `run` now, then every `ms` while the window is visible (a hidden window skips its ticks), and
// at once when the user comes back to it (focus / visibility). Coming back fires both events, so runs
// closer than MIN_GAP_MS count as one. Returns stop().
const MIN_GAP_MS = 5000

export function startPoll(run, ms, env = {}) {
  const doc = env.doc || document
  const win = env.win || window
  const every = env.setInterval || setInterval
  const clear = env.clearInterval || clearInterval
  const now = env.now || Date.now
  let last = -Infinity
  const go = () => { last = now(); run() }
  const refresh = () => { if (doc.visibilityState !== 'hidden' && now() - last >= MIN_GAP_MS) go() }
  go()
  const id = every(refresh, ms)
  doc.addEventListener('visibilitychange', refresh)
  win.addEventListener('focus', refresh)
  return () => {
    clear(id)
    doc.removeEventListener('visibilitychange', refresh)
    win.removeEventListener('focus', refresh)
  }
}
