// Hosts worker.js as an Electron utilityProcess (roadmap §4.3): off the UI thread, off main's event
// loop, crash-isolated. spawn() returns { build(raw, prefs), warm(), kill() }; builds time out at
// 3 s + a little; the process exits itself after 10 idle minutes and is re-spawned on the next use
// by the consumer (which also throttles restarts after a failure).
'use strict'
const path = require('path')

const IDLE_EXIT_MS = 10 * 60 * 1000
const BUILD_TIMEOUT_MS = 3500

function spawnWorker({ onExit } = {}) {
  const { utilityProcess } = require('electron')
  const child = utilityProcess.fork(path.join(__dirname, 'worker.js'), [], { serviceName: 'arbiter-ee2-query', stdio: 'ignore' })
  const pending = new Map()
  let seq = 0, idle = null, ready = null, dead = false

  const fail = (err) => { dead = true; clearTimeout(idle); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err) } pending.clear(); try { onExit?.() } catch {} }
  child.on('exit', () => fail(new Error('worker exited')))
  child.on('message', (m) => {
    if (!m || typeof m !== 'object') return
    if (m.t === 'ready') { readyResolve?.(m); return }
    if (m.t === 'error' && m.id == null) { readyReject?.(new Error(m.message || 'init failed')); return }
    const p = pending.get(m.id); if (!p) return
    pending.delete(m.id); clearTimeout(p.timer)
    if (m.t === 'built') { const { t, id, ...rest } = m; p.resolve(rest) }
    else p.resolve({ error: { stage: m.stage, message: m.message } })
  })
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => { if (!pending.size) kill() }, IDLE_EXIT_MS); if (idle.unref) idle.unref() }
  let readyResolve, readyReject
  const warm = () => {
    if (ready) return ready
    ready = new Promise((res, rej) => { readyResolve = (m) => res({ ms: m.ms, items: m.items, stats: m.stats }); readyReject = rej })
    child.postMessage({ t: 'init' })
    touch()
    return ready
  }
  const build = async (raw, prefs) => {
    if (dead) throw new Error('worker exited')
    await warm()
    touch()
    const id = ++seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('build timeout')) }, BUILD_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      child.postMessage({ t: 'build', id, raw, prefs })
    })
  }
  const kill = () => { if (dead) return; try { child.kill() } catch {} }
  return { build, warm, kill }
}

module.exports = { spawnWorker, IDLE_EXIT_MS, BUILD_TIMEOUT_MS }
