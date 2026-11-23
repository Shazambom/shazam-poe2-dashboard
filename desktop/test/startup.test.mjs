// desktop/src/startup.js: the desktop app's startup chain as a dependency graph. Pins the order main.js
// runs the steps in, that every declared edge holds (a step starts only once the steps it needs are
// done), and what happens when each resource is missing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
const require = createRequire(import.meta.url)
const { STEPS, boot, planBackend, resolveUiDist } = require('../src/startup.js')

const RES = '/res'
const APP = '/app/desktop'
const DATA = '/user/data'
const BIN = join(RES, 'backend-bin', 'poe2arb-backend')

// A fake file system (fs.promises) holding `files`, recording every call in order. `delay(call)` makes a
// call take that many ms (a slow disk), so a step that did not await its prerequisites would show.
/** @param {string[]} files @param {{ mkdirError?: any, delay?: (call: string) => number, trace?: (e: string) => void }} [opts] */
function fakeFs(files, { mkdirError = null, delay = () => 0, trace = () => {} } = {}) {
  const have = new Set(files)
  const calls = []
  const settle = async (call) => {
    trace(`> ${call}`)
    await new Promise(resolve => { setTimeout(resolve, delay(call)) })
    trace(`< ${call}`)
  }
  return {
    calls,
    // Electron's fs.promises.access answers ENOENT for a DIRECTORY inside app.asar (measured on the packaged
    // 45.4.1 build: existsSync true, stat ok, access ENOENT), and app-dist is exactly that. Existence is asked
    // through stat; access is here only to fail the way Electron's does.
    async access(p) {
      throw Object.assign(new Error(`ENOENT: ${p} (fs.promises.access inside app.asar)`), { code: 'ENOENT' })
    },
    async stat(p) {
      const call = `exists ${p}`
      calls.push(call)
      await settle(call)
      if (!have.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      return {}
    },
    async mkdir(p, o) {
      const call = `mkdir ${p} ${JSON.stringify(o)}`
      calls.push(call)
      await settle(call)
      if (mkdirError) throw mkdirError
    },
  }
}

// One startup run against `files`: what the fs saw, the step marks, the log, and each hook's call.
/**
 * @param {string[]} files
 * @param {{ platform?: string, mkdirError?: any, failReady?: any, resourcesPath?: string, delay?: (call: string) => number,
 *   stopped?: () => boolean }} [opts]
 */
async function run(files, { platform = 'darwin', mkdirError = null, failReady = null, delay, stopped, ...o } = {}) {
  const resourcesPath = 'resourcesPath' in o ? o.resourcesPath : RES
  const timeline = []   // marks and the begin (>) and end (<) of every fs call, interleaved
  const fs = fakeFs(files, { mkdirError, delay, trace: (e) => timeline.push(e) })
  const marks = []
  const logs = []
  const hooks = { launched: [], readied: [], served: [] }
  const env = {
    fs, resourcesPath, appRoot: APP, platform, dataDir: () => DATA,
    log: (...a) => logs.push(a.join(' ')), mark: (id, phase) => { marks.push(`${id}:${phase}`); timeline.push(`${id}:${phase}`) }, stopped,
  }
  let error = null
  let booted = null
  try {
    booted = await boot(env, {
      launch: (plan) => { marks.push('launch-hook'); hooks.launched.push(plan) },
      ready: async (plan) => { hooks.readied.push(plan); if (failReady) throw failReady },
      serve: async (dist) => { hooks.served.push(dist) },
    })
  } catch (e) { error = e }
  return { calls: fs.calls, marks, logs, hooks, error, booted, timeline }
}

const UI_INDEX = join(APP, 'app-dist', 'index.html')
const FULL = [BIN, join(RES, 'market-seed', 'market-seed.sqlite.gz'), UI_INDEX]

test('startup runs in the current order: binary, data dir, seed, sidecar, launch, ready, UI bundle, UI server', async () => {
  const r = await run(FULL)
  assert.equal(r.error, null)
  assert.equal(r.booted, true)
  assert.deepEqual(r.marks, [
    'backend-bin:start', 'backend-bin:done',
    'data-dir:start', 'data-dir:done',
    'market-seed:start', 'market-seed:done',
    'sidecar-bin:start', 'sidecar-bin:done',
    'backend-launch:start', 'launch-hook', 'backend-launch:done',
    'backend-ready:start', 'backend-ready:done',
    'ui-dist:start', 'ui-dist:done',
    'ui-server:start', 'ui-server:done',
  ])
  assert.deepEqual(r.calls, [
    `exists ${BIN}`,
    `mkdir ${DATA} {"recursive":true}`,
    `exists ${join(RES, 'market-seed', 'market-seed.sqlite.gz')}`,
    `exists ${join(RES, 'sidecar-bin', 'poe2arb-sidecar')}`,
    `exists ${join(APP, 'sidecar-bin', 'poe2arb-sidecar')}`,
    `exists ${UI_INDEX}`,
  ])
  assert.deepEqual(r.logs, [
    `[backend] market seed: ${join(RES, 'market-seed', 'market-seed.sqlite.gz')}`,
    `[backend] sidecar: ${BIN} --sidecar`,
  ])
  assert.deepEqual(r.hooks.served, [join(APP, 'app-dist')])
})

test('the graph names every step once, and every edge points back at an earlier step with a reason', () => {
  const ids = STEPS.map(s => s.id)
  assert.deepEqual(ids, ['backend-bin', 'data-dir', 'market-seed', 'sidecar-bin', 'backend-launch', 'backend-ready', 'ui-dist', 'ui-server'])
  for (const [i, s] of STEPS.entries()) {
    for (const n of s.needs) {
      assert.ok(ids.indexOf(n.step) >= 0 && ids.indexOf(n.step) < i, `${s.id} needs ${n.step}, declared before it`)
      assert.ok(n.why && n.why.length > 20, `${s.id} ← ${n.step} carries its reason`)
    }
  }
})

// Every edge: the prerequisite is done before the dependent step starts. A prerequisite that never
// started was skipped (no binary: no data dir, seed, sidecar or launch), which `skipped` must name.
function assertEdges(marks, skipped = []) {
  for (const s of STEPS) {
    const start = marks.indexOf(`${s.id}:start`)
    if (start < 0) continue
    for (const n of s.needs) {
      if (skipped.includes(n.step)) { assert.ok(!marks.includes(`${n.step}:start`), `${n.step} was skipped`); continue }
      const done = marks.indexOf(`${n.step}:done`)
      assert.ok(done >= 0 && done < start, `${s.id} started (${start}) before ${n.step} was done (${done}): ${n.why}`)
    }
  }
}

test('every declared edge holds: no step starts before the steps it needs are done', async () => {
  const r = await run(FULL)
  for (const s of STEPS) assert.ok(r.marks.includes(`${s.id}:start`), `${s.id} ran`)
  assertEdges(r.marks)
})

test('the backend is launched with exactly the binary, data dir, seed and sidecar the earlier steps found', async () => {
  const SIDE = join(APP, 'sidecar-bin', 'poe2arb-sidecar')
  const r = await run([...FULL, SIDE])
  assert.deepEqual(r.hooks.launched, [{ bin: BIN, dataDir: DATA, marketSeed: join(RES, 'market-seed', 'market-seed.sqlite.gz'), sidecarBin: SIDE }])
  assert.deepEqual(r.hooks.readied, r.hooks.launched, 'ready waits on the same plan')
  assert.equal(r.logs.at(-1), `[backend] sidecar: ${SIDE}`)
})

test('missing backend binary: no data dir, seed or sidecar, no launch; ready gets null; the UI is still served', async () => {
  const r = await run([UI_INDEX])
  assert.equal(r.error, null)
  assert.deepEqual(r.calls, [
    `exists ${BIN}`, `exists ${join(APP, 'backend-bin', 'poe2arb-backend')}`, `exists ${UI_INDEX}`,
  ])
  assert.deepEqual(r.marks, ['backend-bin:start', 'backend-bin:done', 'backend-ready:start', 'backend-ready:done',
    'ui-dist:start', 'ui-dist:done', 'ui-server:start', 'ui-server:done'])
  assert.deepEqual(r.hooks.launched, [])
  assert.deepEqual(r.hooks.readied, [null])
  assert.deepEqual(r.logs, [])
  assertEdges(r.marks, ['data-dir', 'market-seed', 'sidecar-bin', 'backend-launch'])
})

test('packed binary missing, dev binary present: the dev one runs (Windows names)', async () => {
  const devBin = join(APP, 'backend-bin', 'poe2arb-backend.exe')
  const r = await run([devBin], { platform: 'win32' })
  assert.equal(r.hooks.launched[0].bin, devBin)
  assert.ok(r.calls.includes(`exists ${join(RES, 'sidecar-bin', 'poe2arb-sidecar.exe')}`))
})

test('no resourcesPath (an unpackaged run): packed paths resolve relative, dev paths still found', async () => {
  const devBin = join(APP, 'backend-bin', 'poe2arb-backend')
  const r = await run([devBin], { resourcesPath: undefined })
  assert.equal(r.calls[0], `exists ${join('backend-bin', 'poe2arb-backend')}`)
  assert.equal(r.hooks.launched[0].bin, devBin)
})

test('market seed: gz before plain, packed dir before dev dir, empty and no log line when there is none', async () => {
  const env = (files) => ({ fs: fakeFs(files), resourcesPath: RES, appRoot: APP, platform: 'darwin', dataDir: () => DATA, log: () => {} })
  const pick = async (files) => (await planBackend(env([BIN, ...files]))).marketSeed
  const packedGz = join(RES, 'market-seed', 'market-seed.sqlite.gz')
  const packedPlain = join(RES, 'market-seed', 'market-seed.sqlite')
  const devGz = join(APP, 'market-seed', 'market-seed.sqlite.gz')
  const devPlain = join(APP, 'market-seed', 'market-seed.sqlite')
  assert.equal(await pick([packedGz, packedPlain, devGz]), packedGz)
  assert.equal(await pick([packedPlain, devGz]), packedPlain)
  assert.equal(await pick([devGz, devPlain]), devGz)
  assert.equal(await pick([devPlain]), devPlain)
  assert.equal(await pick([]), '')
  const logs = []
  await planBackend({ ...env([BIN]), log: (...a) => logs.push(a.join(' ')) })
  assert.deepEqual(logs, [`[backend] sidecar: ${BIN} --sidecar`], 'no seed line without a seed')
})

test('a data dir that cannot be created fails startup before the launch, with that error', async () => {
  const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
  const r = await run(FULL, { mkdirError: eacces })
  assert.equal(r.error, eacces)
  assert.deepEqual(r.hooks.launched, [])
  assert.deepEqual(r.hooks.served, [])
  assert.deepEqual(r.marks, ['backend-bin:start', 'backend-bin:done', 'data-dir:start'])
})

test('a ready step that throws stops startup before the UI server', async () => {
  const boom = new Error('boom')
  const r = await run(FULL, { failReady: boom })
  assert.equal(r.error, boom)
  assert.deepEqual(r.hooks.served, [])
})

test('UI bundle: desktop/app-dist when it exists, else frontend/dist', async () => {
  const env = (files) => ({ fs: fakeFs(files), resourcesPath: RES, appRoot: APP, platform: 'darwin', dataDir: () => DATA, log: () => {} })
  assert.equal(await resolveUiDist(env([UI_INDEX])), join(APP, 'app-dist'))
  assert.equal(await resolveUiDist(env([join(APP, '..', 'frontend', 'dist', 'index.html')])), join(APP, '..', 'frontend', 'dist'))
})

// Interleaving: a slow disk (every call takes a different time; mkdir the slowest) must not let any
// step start before its prerequisites are done, and the order stays exactly the synchronous one.
test('a slow, uneven disk changes nothing: same marks, same calls, every edge holds', async () => {
  const fast = await run(FULL)
  const slowMs = (call) => (call.startsWith('mkdir') ? 25 : (call.length * 7) % 11)
  const slow = await run(FULL, { delay: slowMs })
  assert.equal(slow.error, null)
  assert.deepEqual(slow.marks, fast.marks)
  assert.deepEqual(slow.calls, fast.calls)
  assertEdges(slow.marks)
  // One fs call at a time, each finished before the next starts, and inside the step that made it.
  const t = slow.timeline
  for (const [i, e] of t.entries()) {
    if (e.startsWith('> ')) assert.equal(t[i + 1], `< ${e.slice(2)}`, `${e} overlapped ${t[i + 1]}`)
  }
  const inside = (call, id) => t.indexOf(`${id}:start`) < t.indexOf(`> ${call}`) && t.indexOf(`< ${call}`) < t.indexOf(`${id}:done`)
  assert.ok(inside(`mkdir ${DATA} {"recursive":true}`, 'data-dir'))
  assert.ok(inside(`exists ${join(RES, 'market-seed', 'market-seed.sqlite.gz')}`, 'market-seed'))
  assert.ok(inside(`exists ${join(APP, 'sidecar-bin', 'poe2arb-sidecar')}`, 'sidecar-bin'))
  assert.ok(inside(`exists ${UI_INDEX}`, 'ui-dist'))
  const noBin = await run([UI_INDEX], { delay: slowMs })
  assertEdges(noBin.marks, ['data-dir', 'market-seed', 'sidecar-bin', 'backend-launch'])
})

test('a quit that begins while startup reads the disk: no backend is spawned, nothing more runs', async () => {
  let quitting = false
  const r = await run(FULL, { delay: (call) => { if (call.startsWith('mkdir')) { quitting = true } return 1 }, stopped: () => quitting })
  assert.equal(r.booted, false)
  assert.deepEqual(r.hooks.launched, [])
  assert.deepEqual(r.hooks.readied, [])
  assert.deepEqual(r.hooks.served, [])
  const normal = await run(FULL, { stopped: () => false })
  assert.equal(normal.booted, true)
  assert.equal(normal.hooks.launched.length, 1)
})

// The packaged 0.3.17 lint build never reached the Board: app-dist lives inside app.asar, access() said it was
// missing, and the UI server was pointed at Resources/frontend/dist, which does not exist in a packaged app.
test('the UI bundle is found through stat, which works on a directory inside app.asar', async () => {
  const r = await run(FULL)
  assert.equal(r.error, null)
  assert.deepEqual(r.hooks.served, [join(APP, 'app-dist')])
})

// A packaged build once served a directory that did not exist: every request answered an uncaught ENOENT and
// the window stayed blank. The bundle is the first candidate that holds index.html (asked through stat, the one
// call that works inside app.asar); with neither, startup fails with both paths named, before the UI server.
test('the UI bundle is the first candidate holding index.html; with neither, startup fails before serving', async () => {
  const devIndex = join(APP, '..', 'frontend', 'dist', 'index.html')
  const half = await run([BIN, devIndex])   // app-dist without index.html (a half-built bundle) is passed over
  assert.equal(half.error, null)
  assert.deepEqual(half.hooks.served, [join(APP, '..', 'frontend', 'dist')])
  assert.deepEqual(half.calls.slice(-2), [`exists ${UI_INDEX}`, `exists ${devIndex}`])
  const none = await run([BIN])
  assert.match(String(none.error), /index\.html/)
  assert.ok(String(none.error).includes(join(APP, 'app-dist')) && String(none.error).includes(join(APP, '..', 'frontend', 'dist')), 'both paths named')
  assert.deepEqual(none.hooks.served, [])
  assert.deepEqual(none.marks.slice(-1), ['ui-dist:start'])
})
