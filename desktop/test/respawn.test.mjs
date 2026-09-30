// Pins desktop/src/respawn.js — the bundled backend is restarted when it dies on its own, backing off
// while it keeps crashing, and never when we stopped it (quit / update install). Before this, a
// backend crash left every /api call failing until the user relaunched (audit 2026-09-29, S3).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const { createRespawner, onceGone } = await import('../src/respawn.js')
const { EventEmitter } = await import('node:events')

function harness() {
  let t = 0
  const timers = [], starts = []
  const r = createRespawner({ start: () => starts.push(t), schedule: (fn, ms) => timers.push(ms), now: () => t })
  return { r, timers, starts, advance: (ms) => { t += ms } }
}

test('a crash restarts it, backing off 1s, 2s, 4s … to 60s while it keeps dying', () => {
  const h = harness()
  for (let i = 0; i < 8; i++) { h.r.started(); h.advance(500); h.r.exited({ requested: false }) }
  assert.deepEqual(h.timers, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000])
})

test('a backend that ran a minute or more is restarted quickly again', () => {
  const h = harness()
  for (let i = 0; i < 3; i++) { h.r.started(); h.advance(500); h.r.exited({ requested: false }) }
  h.r.started(); h.advance(10 * 60 * 1000); h.r.exited({ requested: false })
  assert.deepEqual(h.timers, [1000, 2000, 4000, 1000])
})

test('an exit we asked for (quit, update) is never restarted', () => {
  const h = harness()
  h.r.started(); h.advance(500)
  assert.equal(h.r.exited({ requested: true }), null)
  assert.deepEqual(h.timers, [])
})

test('quitting cancels a restart that is waiting, and nothing restarts after it', () => {
  let cleared = null, fired = 0
  const r = createRespawner({ start: () => { fired++ }, schedule: (fn, ms) => ({ fn, ms }), cancel: (h) => { cleared = h }, now: () => 0 })
  r.started(); r.exited({ requested: false })
  r.stop()
  assert.equal(cleared?.ms, 1000, 'the pending timer was cancelled')
  assert.equal(r.exited({ requested: false }), null, 'no restart after stop')
  assert.equal(fired, 0)
})

test('a child that never started (spawn error, no exit event) still counts as gone, once', () => {
  // Node emits 'error' then 'close' — never 'exit' — when the binary is missing (ENOENT, e.g.
  // quarantined by antivirus), so a respawn keyed on 'exit' alone stopped for good (code review 2026-09-29).
  const child = Object.assign(new EventEmitter(), { pid: undefined })
  const gone = []
  onceGone(child, (why) => gone.push(why))
  child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
  child.emit('close', -2, null)
  assert.deepEqual(gone, [{ code: null, signal: null, error: 'ENOENT' }])
})

test('a normal exit counts once, and a later error or close adds nothing', () => {
  const child = Object.assign(new EventEmitter(), { pid: 42 })
  const gone = []
  onceGone(child, (why) => gone.push(why))
  child.emit('exit', 1, null); child.emit('close', 1, null); child.emit('error', new Error('late'))
  assert.deepEqual(gone, [{ code: 1, signal: null, error: null }])
})

test('main.js restarts the backend through the respawner and stops it on quit', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  assert.ok(main.includes("require('./respawn.js')"))
  assert.match(main, /exited\(\{ requested: backendStopping \}\)/)
  assert.ok(main.includes('onceGone(backendProc'), 'a failed spawn restarts too, not only an exit')
  assert.match(main, /try \{ launch\(\) \} catch/, 'a spawn that throws is retried, not an uncaught exception')
  const stop = main.slice(main.indexOf('function stopBackend()'), main.indexOf('function stopBackend()') + 400)
  assert.ok(stop.includes('backendRespawner?.stop()'), 'stopBackend cancels a pending restart')
})
