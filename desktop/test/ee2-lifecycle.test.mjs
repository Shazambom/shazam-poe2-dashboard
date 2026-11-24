// ExiledExchangeIntegration's start/stop lifecycle (desktop/src/integrations/exiled-exchange/index.js)
// while EE2 detection is still out. Detection is async (detectEE2 → findConfig / ps), so stop() can run
// while a detection started by start() or by a redetect poll has not come back yet. Whatever that
// detection finds, a stopped integration must hold nothing: no keyboard hook, no clipboard poll, no
// config watch, no timer. Every collaborator is a fake (the real uIOhook is never started), and the
// integration's timers are counted through wrapped setInterval/setTimeout.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const DIR = '../src/integrations/exiled-exchange/'

// One fake per collaborator, recording what is live.
function fakes() {
  const live = { hotkeys: new Set(), clips: new Set(), configWatches: 0, detections: [], bursts: [] }
  class HotkeyWatcher {
    constructor(opts) { this.opts = opts }
    start() { live.hotkeys.add(this); return true }
    stop() { live.hotkeys.delete(this) }
    setShortcuts() {}
  }
  class ClipboardWatcher {
    constructor(opts) { this.opts = opts }
    start() { live.clips.add(this) }
    stop() { live.clips.delete(this) }
    setIntervalMs() {}
  }
  const detectEE2 = () => new Promise((resolve) => { live.detections.push(resolve) })
  const watchConfig = () => { live.configWatches += 1; return () => { live.configWatches -= 1 } }
  const captureItemBurst = ({ onItem }) => { live.bursts.push(onItem); return () => {} }
  return {
    live,
    modules: {
      'detect.js': { detectEE2 },
      'hotkey-watcher.js': { HotkeyWatcher },
      'clipboard-watcher.js': { ClipboardWatcher, captureItemBurst },
      'ee2-config.js': { readShortcuts: async () => [], watchConfig },
    },
  }
}

// Load index.js fresh against the fakes, restoring the module cache afterwards.
function loadIntegration(modules) {
  const index = require.resolve(DIR + 'index.js')
  const saved = new Map()
  for (const [name, exports] of Object.entries(modules)) {
    const file = require.resolve(DIR + name)
    saved.set(file, require.cache[file])
    require.cache[file] = /** @type {any} */ ({ id: file, filename: file, loaded: true, exports })
  }
  saved.set(index, require.cache[index])
  delete require.cache[index]
  try { return require(index).ExiledExchangeIntegration } finally {
    for (const [file, mod] of saved) { if (mod) require.cache[file] = mod; else delete require.cache[file] }
  }
}

// Wrap the global timers so the test sees every interval/timeout the integration leaves running, and can
// fire the redetect interval by hand. macOS is forced so the Accessibility health timer is armed too.
function harness(t) {
  const { live, modules } = fakes()
  const Integration = loadIntegration(modules)
  const timers = new Map()   // handle -> { kind, fn, ms }
  const real = { setInterval, clearInterval, setTimeout, clearTimeout }
  const track = (kind) => (fn, ms) => {
    const h = real[kind === 'interval' ? 'setInterval' : 'setTimeout'](() => {}, 1e9)
    h.unref()
    timers.set(h, { kind, fn, ms })
    return h
  }
  const untrack = (h) => { if (timers.has(h)) { timers.delete(h); real.clearTimeout(h) } }
  globalThis.setInterval = /** @type {any} */ (track('interval'))
  globalThis.setTimeout = /** @type {any} */ (track('timeout'))
  globalThis.clearInterval = /** @type {any} */ (untrack)
  globalThis.clearTimeout = /** @type {any} */ (untrack)
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  t.after(() => {
    Object.assign(globalThis, real)
    Object.defineProperty(process, 'platform', platform)
    for (const h of timers.keys()) real.clearTimeout(h)
  })
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate) }
  const intervals = () => [...timers.values()].filter(x => x.kind === 'interval')
  const held = () => ({ hotkeys: live.hotkeys.size, clips: live.clips.size, configWatches: live.configWatches, timers: timers.size })
  return { Integration, live, timers, intervals, held, flush }
}

const NONE = { hotkeys: 0, clips: 0, configWatches: 0, timers: 0 }
const PRESENT = { present: true, method: 'config-dir', dir: '/x', config: null, running: false }
const ABSENT = { present: false, method: 'none', dir: null, config: null, running: false }

test('a normal start with EE2 present runs one active session, and stop releases all of it', async (t) => {
  const h = harness(t)
  const integ = new h.Integration()
  const events = []
  for (const e of ['started', 'stopped', 'ee2-detected', 'ee2-missing']) integ.on(e, () => events.push(e))
  const started = integ.start()
  h.live.detections[0](PRESENT)
  await started
  assert.equal(integ.isActive(), true)
  // one hotkey hook, one clipboard poll, one config watch; the redetect interval and the health timeout
  assert.deepEqual(h.held(), { hotkeys: 1, clips: 1, configWatches: 1, timers: 2 })
  integ.stop()
  assert.deepEqual(h.held(), NONE)
  assert.equal(integ.isRunning(), false)
  assert.deepEqual(events, ['ee2-detected', 'started', 'stopped'])
})

test('stop during the initial detection activates nothing and leaves nothing running', async (t) => {
  const h = harness(t)
  const integ = new h.Integration()
  const events = []
  for (const e of ['started', 'stopped', 'ee2-detected', 'ee2-missing']) integ.on(e, () => events.push(e))
  const started = integ.start()
  integ.stop()
  h.live.detections[0](PRESENT)
  await started
  await h.flush()
  assert.deepEqual(h.held(), NONE)
  assert.equal(integ.isActive(), false)
  assert.equal(integ.isRunning(), false)
  assert.deepEqual(events, ['stopped'])
})

test('stop during a redetect poll activates nothing and leaves nothing running', async (t) => {
  const h = harness(t)
  const integ = new h.Integration()
  const started = integ.start()
  h.live.detections[0](ABSENT)
  await started
  assert.equal(h.intervals().length, 1)
  h.intervals()[0].fn()   // the 30 s poll fires; EE2 was installed meanwhile
  assert.equal(h.live.detections.length, 2)
  integ.stop()
  h.live.detections[1](PRESENT)
  await h.flush()
  assert.deepEqual(h.held(), NONE)
  assert.equal(integ.isActive(), false)
})

test('stop then start again while the old detection is out: exactly one run, the new one', async (t) => {
  const h = harness(t)
  const integ = new h.Integration()
  let startedEvents = 0
  integ.on('started', () => { startedEvents += 1 })
  const first = integ.start()
  integ.stop()
  const second = integ.start()
  h.live.detections[1](PRESENT)   // the new run's detection comes back first
  await second
  h.live.detections[0](ABSENT)    // then the old one, which must neither tear the new run down nor add to it
  await first
  await h.flush()
  assert.equal(integ.isActive(), true)
  assert.equal(h.intervals().length, 1)
  assert.deepEqual(h.held(), { hotkeys: 1, clips: 1, configWatches: 1, timers: 2 })
  assert.equal(startedEvents, 1)
  integ.stop()
  assert.deepEqual(h.held(), NONE)
})

test('an old detection that finds EE2 does not activate a new run that has not been told yet', async (t) => {
  const h = harness(t)
  const integ = new h.Integration()
  const first = integ.start()
  integ.stop()
  const second = integ.start()
  h.live.detections[0](PRESENT)   // the old run's answer arrives while the new run's is still out
  await first
  await h.flush()
  assert.equal(integ.isActive(), false)
  assert.deepEqual(h.held(), NONE)
  h.live.detections[1](ABSENT)
  await second
  assert.equal(integ.isActive(), false)
  assert.deepEqual(h.held(), { hotkeys: 0, clips: 0, configWatches: 0, timers: 1 })   // the redetect interval only
  integ.stop()
  assert.deepEqual(h.held(), NONE)
})

test('stop is idempotent', async (t) => {
  const h = harness(t)
  const integ = new h.Integration()
  let stopped = 0
  integ.on('stopped', () => { stopped += 1 })
  const started = integ.start()
  h.live.detections[0](PRESENT)
  await started
  integ.stop()
  integ.stop()
  assert.equal(stopped, 1)
  assert.deepEqual(h.held(), NONE)
})

test('an item a hotkey burst captures after stop is not emitted', async (t) => {
  const h = harness(t)
  const integ = new h.Integration()
  const items = []
  integ.on('item-checked', (i) => items.push(i))
  const started = integ.start()
  h.live.detections[0](PRESENT)
  await started
  const hotkey = [...h.live.hotkeys][0]
  hotkey.opts.onHotkey({ action: 'price-check', target: 'price-check', shortcut: 'Ctrl + D', ts: 0 })
  assert.equal(h.live.bursts.length, 1)
  integ.stop()
  h.live.bursts[0]({ name: 'Foe Slicer', raw: 'Item Class: Two Hand Swords\nRarity: Rare\nFoe Slicer' })
  assert.deepEqual(items, [])
})
