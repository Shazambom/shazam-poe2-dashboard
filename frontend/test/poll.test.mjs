// startPoll: run now, then every `ms` while the window is visible; skip ticks while it is hidden, and
// run at once when the user comes back to it (focus / visibility). The Board refetched its heavy Hold
// leaderboard and Movers every 30s even when hidden (audit 2026-09-29, U4); owner: refresh on focus.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { startPoll } from '../src/lib/poll.js'

function env(visible = true) {
  const listeners = {}, timers = []
  let t = 0
  const target = (name) => ({ addEventListener: (ev, fn) => { (listeners[`${name}:${ev}`] ||= []).push(fn) },
    removeEventListener: (ev, fn) => { listeners[`${name}:${ev}`] = (listeners[`${name}:${ev}`] || []).filter(f => f !== fn) } })
  const e = {
    visible, timers, listeners,
    doc: { ...target('doc'), get visibilityState() { return e.visible ? 'visible' : 'hidden' } },
    win: target('win'),
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearInterval: (id) => { timers[id - 1].cleared = true },
    fire: (key) => (listeners[key] || []).forEach(f => f()),
    now: () => t, advance: (ms) => { t += ms },
  }
  return e
}

test('runs now, then on each visible tick, never while hidden', () => {
  const e = env(); let runs = 0
  startPoll(() => { runs++ }, 300000, e)
  assert.equal(runs, 1)
  assert.equal(e.timers[0].ms, 300000)
  e.advance(300000); e.timers[0].fn(); assert.equal(runs, 2)
  e.visible = false; e.timers[0].fn(); assert.equal(runs, 2)
})

test('coming back to the window refreshes at once, once (focus and visibility fire together)', () => {
  const e = env(); let runs = 0
  startPoll(() => { runs++ }, 300000, e)
  e.advance(60000)
  e.visible = false; e.fire('doc:visibilitychange'); assert.equal(runs, 1)
  e.visible = true; e.fire('doc:visibilitychange'); e.fire('win:focus'); assert.equal(runs, 2)
  e.advance(10000); e.fire('win:focus'); assert.equal(runs, 3)
})

test('stop clears the timer and the listeners', () => {
  const e = env(); let runs = 0
  const stop = startPoll(() => { runs++ }, 1000, e)
  stop(); e.advance(60000)
  assert.ok(e.timers[0].cleared)
  e.fire('win:focus'); e.fire('doc:visibilitychange'); assert.equal(runs, 1)
})

test('the Board polls Hold and Movers every 5 minutes through startPoll', () => {
  const src = readFileSync(new URL('../src/components/BoardView.jsx', import.meta.url), 'utf8')
  assert.ok(!/setInterval\(load, 30000\)/.test(src), 'no blind 30s intervals left')
  assert.match(src, /usePoll\(loadPulse, 5 \* 60 \* 1000/)
  assert.match(src, /usePoll\(load, 30000/, "the tiles keep their 30s refresh, paused while hidden")
})
