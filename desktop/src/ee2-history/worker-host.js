// Hosts worker.js as an Electron utilityProcess (roadmap §4.3): off the UI thread, off main's event
// loop, crash-isolated. spawn() returns { build(raw, prefs), warm(), kill() }; builds time out at
// 3 s + a little; the process exits itself after 10 idle minutes and is re-spawned on the next use
// by the consumer (which also throttles restarts after a failure).
'use strict'
const path = require('path')

const IDLE_EXIT_MS = 10 * 60 * 1000
const BUILD_TIMEOUT_MS = 3500

// The worker and the vendored port are asarUnpack'ed (package.json): a utility process must run a
// real file, and the port's data (an ES-module client_strings.mjs, ndjson, index bins) is read from
// disk. Inside a packaged app __dirname still says app.asar — point at the unpacked twin.
const unpacked = (p) => p.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')

function spawnWorker({ onExit } = {}) {
  const { utilityProcess } = require('electron')
  const child = utilityProcess.fork(unpacked(path.join(__dirname, 'worker.js')), [], { serviceName: 'arbiter-ee2-query', stdio: 'ignore' })
  const pending = new Map()
  let seq = 0, idle = null, ready = null, dead = false

  const fail = (err) => { dead = true; clearTimeout(idle); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err) } pending.clear(); try { onExit?.() } catch {} }
  child.on('exit', () => fail(new Error('worker exited')))
  child.on('message', (m) => {
    if (!m || typeof m !== 'object') return
    if (m.t === 'ready') { readyResolve?.(m); return }
    if (m.t === 'error' && m.id == null) { readyReject?.(new Error(`init: ${m.message || 'failed'}`)); return }
    const p = pending.get(m.id); if (!p) return
    pending.delete(m.id); clearTimeout(p.timer)
    if (m.t === 'built') { const { t, id, ...rest } = m; p.resolve(rest) }
    else if (m.t === 'parsed') p.resolve(m.item)
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
  // One request to the worker: a 'build' (the query) or a 'parse' (the Mods tab's compact parse).
  const request = async (msg) => {
    if (dead) throw new Error('worker exited')
    // The timeout covers init too: a worker that never reports ready must not hang the caller.
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('build timeout')), BUILD_TIMEOUT_MS + 5000).unref?.())
    await Promise.race([warm(), timeout])
    touch()
    const id = ++seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('build timeout')) }, BUILD_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      child.postMessage({ ...msg, id })
    })
  }
  const build = (raw, prefs) => request({ t: 'build', raw, prefs })
  const parse = (raw) => request({ t: 'parse', raw })
  const kill = () => { if (dead) return; try { child.kill() } catch {} }
  return { build, parse, warm, kill }
}

module.exports = { spawnWorker, unpacked, IDLE_EXIT_MS, BUILD_TIMEOUT_MS }
