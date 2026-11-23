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

// A fake file system holding `files`, recording every call in order.
function fakeFs(files, { mkdirError = null } = {}) {
  const have = new Set(files)
  const calls = []
  return {
    calls,
    existsSync(p) { calls.push(`exists ${p}`); return have.has(p) },
    mkdirSync(p, o) {
      calls.push(`mkdir ${p} ${JSON.stringify(o)}`)
      if (mkdirError) throw mkdirError
    },
  }
}

// One startup run against `files`: what the fs saw, the step marks, the log, and each hook's call.
/** @param {string[]} files @param {{ platform?: string, mkdirError?: any, failReady?: any, resourcesPath?: string }} [opts] */
async function run(files, { platform = 'darwin', mkdirError = null, failReady = null, ...o } = {}) {
  const resourcesPath = 'resourcesPath' in o ? o.resourcesPath : RES
  const fs = fakeFs(files, { mkdirError })
  const marks = []
  const logs = []
  const hooks = { launched: [], readied: [], served: [] }
  const env = {
    fs, resourcesPath, appRoot: APP, platform, dataDir: () => DATA,
    log: (...a) => logs.push(a.join(' ')), mark: (id, phase) => marks.push(`${id}:${phase}`),
  }
  let error = null
  try {
    await boot(env, {
      launch: (plan) => { marks.push('launch-hook'); hooks.launched.push(plan) },
      ready: async (plan) => { hooks.readied.push(plan); if (failReady) throw failReady },
      serve: async (dist) => { hooks.served.push(dist) },
    })
  } catch (e) { error = e }
  return { calls: fs.calls, marks, logs, hooks, error }
}

const FULL = [BIN, join(RES, 'market-seed', 'market-seed.sqlite.gz'), join(APP, 'app-dist')]

test('startup runs in the current order: binary, data dir, seed, sidecar, launch, ready, UI bundle, UI server', async () => {
  const r = await run(FULL)
  assert.equal(r.error, null)
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
    `exists ${join(APP, 'app-dist')}`,
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
  const r = await run([join(APP, 'app-dist')])
  assert.equal(r.error, null)
  assert.deepEqual(r.calls, [
    `exists ${BIN}`, `exists ${join(APP, 'backend-bin', 'poe2arb-backend')}`, `exists ${join(APP, 'app-dist')}`,
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

test('market seed: gz before plain, packed dir before dev dir, empty and no log line when there is none', () => {
  const env = (files) => ({ fs: fakeFs(files), resourcesPath: RES, appRoot: APP, platform: 'darwin', dataDir: () => DATA, log: () => {} })
  const pick = (files) => planBackend(env([BIN, ...files])).marketSeed
  const packedGz = join(RES, 'market-seed', 'market-seed.sqlite.gz')
  const packedPlain = join(RES, 'market-seed', 'market-seed.sqlite')
  const devGz = join(APP, 'market-seed', 'market-seed.sqlite.gz')
  const devPlain = join(APP, 'market-seed', 'market-seed.sqlite')
  assert.equal(pick([packedGz, packedPlain, devGz]), packedGz)
  assert.equal(pick([packedPlain, devGz]), packedPlain)
  assert.equal(pick([devGz, devPlain]), devGz)
  assert.equal(pick([devPlain]), devPlain)
  assert.equal(pick([]), '')
  const logs = []
  planBackend({ ...env([BIN]), log: (...a) => logs.push(a.join(' ')) })
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

test('UI bundle: desktop/app-dist when it exists, else frontend/dist', () => {
  const env = (files) => ({ fs: fakeFs(files), resourcesPath: RES, appRoot: APP, platform: 'darwin', dataDir: () => DATA, log: () => {} })
  assert.equal(resolveUiDist(env([join(APP, 'app-dist')])), join(APP, 'app-dist'))
  assert.equal(resolveUiDist(env([])), join(APP, '..', 'frontend', 'dist'))
})
