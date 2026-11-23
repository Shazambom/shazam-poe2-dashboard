// The file-system steps of the desktop app's startup, in the order main.js runs them, with the
// dependencies between them written down as data (STEPS). main.js passes in everything that
// touches the machine (fs, the app's paths, the platform, the logger), so the order is testable
// without launching Electron (desktop/test/startup.test.mjs).
//
// boot() runs the chain: find the backend binary → data dir → market seed → sidecar → launch the
// backend → wait for it → find the UI bundle → serve it. The file-system calls are asynchronous, and
// every step is awaited before the next one starts, in exactly this order; STEPS records which of
// those orderings the code actually needs.
'use strict'
const path = require('node:path')

/**
 * One startup step and the steps that must be complete before it starts, each with its reason.
 * @type {ReadonlyArray<{ id: string, needs: ReadonlyArray<{ step: string, why: string }> }>}
 */
const STEPS = Object.freeze([
  { id: 'backend-bin', needs: [] },
  { id: 'data-dir', needs: [
    { step: 'backend-bin', why: 'the data dir is created only when a bundled backend exists (a dev launch without one uses a dev server)' },
  ] },
  { id: 'market-seed', needs: [
    { step: 'backend-bin', why: 'the seed is looked up only for a bundled backend, the one process that reads it' },
  ] },
  { id: 'sidecar-bin', needs: [
    { step: 'backend-bin', why: 'without a separate sidecar the backend binary runs it (`<bin> --sidecar`), so the sidecar line names the binary' },
  ] },
  { id: 'backend-launch', needs: [
    { step: 'backend-bin', why: 'spawn(bin) runs the binary found' },
    { step: 'data-dir', why: 'the backend is spawned with DATA_DIR and opens its databases there, so the dir must exist first' },
    { step: 'market-seed', why: 'the backend is spawned with MARKET_SEED, the seed path found' },
    { step: 'sidecar-bin', why: 'the backend is spawned with SIDECAR_BIN, the sidecar path found' },
  ] },
  { id: 'backend-ready', needs: [
    { step: 'backend-launch', why: 'waits for /api/health of the process just spawned, then sets backendUrl' },
  ] },
  { id: 'ui-dist', needs: [] },
  { id: 'ui-server', needs: [
    { step: 'ui-dist', why: 'serves the files of the bundle found' },
    { step: 'backend-ready', why: 'proxies /api to backendUrl and logs it, which backend-ready settles' },
  ] },
])

/**
 * @typedef {{ fs: { stat: (p: string) => Promise<any>, mkdir: (p: string, o?: any) => Promise<any> },
 *   resourcesPath: string | undefined, appRoot: string, platform: string, dataDir: () => string,
 *   log: (...a: any[]) => void, mark?: (id: string, phase: 'start' | 'done') => void,
 *   stopped?: () => boolean }} StartupEnv
 * fs: the file system (fs.promises); resourcesPath: process.resourcesPath (packed resources); appRoot:
 * desktop/ (src/..); dataDir: where the backend keeps its databases; mark: records each step's start
 * and end; stopped: true once the app has begun to quit.
 */

/** @param {StartupEnv} env @param {string} id @param {() => any} fn */
async function step(env, id, fn) {
  env.mark?.(id, 'start')
  const out = await fn()
  env.mark?.(id, 'done')
  return out
}

// fs.existsSync's answer, without blocking: false for any error (missing, unreadable parent). Asked through
// stat, never access: Electron's fs.promises.access answers ENOENT for a directory inside app.asar, which is
// where the packaged app-dist lives.
/** @param {StartupEnv} env @param {string} p */
async function exists(env, p) {
  try {
    await env.fs.stat(p)
    return true
  } catch {
    return false
  }
}

// A bundled per-platform binary: the packed location (extraResources) preferred, then the dev
// location. `found` is the existing path or null; `expected` is the packed path to report when
// nothing is found (a packaging regression). Shared by the backend and the analytics sidecar.
/** @param {StartupEnv} env @param {string} dir @param {string} name */
async function findBundledBin(env, dir, name) {
  const packed = path.join(env.resourcesPath || '', dir, name)
  const dev = path.join(env.appRoot, dir, name)
  const found = await exists(env, packed) ? packed : (await exists(env, dev) ? dev : null)
  return { found, expected: packed }
}

/** @param {StartupEnv} env */
async function backendBinary(env) {
  const name = env.platform === 'win32' ? 'poe2arb-backend.exe' : 'poe2arb-backend'
  return (await findBundledBin(env, 'backend-bin', name)).found
}

// Bundled market snapshot (extraResources). The backend seeds market.sqlite from it on first run /
// when newer, so users skip the cold backfill. Missing in dev = crawl live. The seed ships gzipped
// (~8x smaller); a plain .sqlite is the dev fallback. '' when there is none.
/** @param {StartupEnv} env */
async function findMarketSeed(env) {
  const seedDirs = [path.join(env.resourcesPath || '', 'market-seed'), path.join(env.appRoot, 'market-seed')]
  const seedNames = ['market-seed.sqlite.gz', 'market-seed.sqlite']
  for (const d of seedDirs) {
    for (const n of seedNames) {
      const p = path.join(d, n); if (await exists(env, p)) return p
    }
  }
  return ''
}

/**
 * The backend's inputs, found in order: the binary, then (only when there is one) its data dir,
 * the market seed and the sidecar. null when no binary is bundled.
 * @param {StartupEnv} env
 * @returns {Promise<{ bin: string, dataDir: string, marketSeed: string, sidecarBin: string } | null>}
 */
async function planBackend(env) {
  const bin = await step(env, 'backend-bin', () => backendBinary(env))
  if (!bin) return null
  const dataDir = await step(env, 'data-dir', async () => {
    const d = env.dataDir()
    await env.fs.mkdir(d, { recursive: true })
    return d
  })
  const marketSeed = await step(env, 'market-seed', () => findMarketSeed(env))
  if (marketSeed) env.log('[backend] market seed:', marketSeed)
  // Sidecar (heavy analytics): unified into poe2arb-backend (--sidecar), reusing the same frozen
  // Python + NumPy runtime. If a separate legacy sidecar-bin exists, honour it; otherwise leave
  // SIDECAR_BIN empty so sidecar_supervisor launches `[sys.executable, "--sidecar"]`.
  const sidecarBin = await step(env, 'sidecar-bin', async () => {
    const sidecarName = env.platform === 'win32' ? 'poe2arb-sidecar.exe' : 'poe2arb-sidecar'
    return (await findBundledBin(env, 'sidecar-bin', sidecarName)).found || ''
  })
  env.log('[backend] sidecar:', sidecarBin || `${bin} --sidecar`)
  return { bin, dataDir, marketSeed, sidecarBin }
}

// The built frontend: desktop/app-dist when packaged or built, else the frontend's own dist; the first
// that holds index.html. With neither, startup fails here, naming both: serving a bundle that is not
// there leaves a blank window.
/** @param {StartupEnv} env */
async function resolveUiDist(env) {
  const candidates = [path.join(env.appRoot, 'app-dist'), path.join(env.appRoot, '..', 'frontend', 'dist')]
  for (const dist of candidates) {
    if (await exists(env, path.join(dist, 'index.html'))) return dist
  }
  throw new Error(`no UI bundle: no index.html in ${candidates.join(' or ')}`)
}

/**
 * @typedef {{ bin: string, dataDir: string, marketSeed: string, sidecarBin: string }} BackendPlan
 */

/**
 * The startup chain up to the UI server. `launch` spawns the backend from the plan; `ready` waits
 * for it (or, with no plan, picks the dev or local URL) and settles backendUrl; `serve` starts the
 * UI server on the bundle found. Resolves true once the UI server is up, or false when the app began
 * to quit while the backend's inputs were being found: a quit that lands between those awaits must
 * not be followed by a backend spawn nobody will stop.
 * @param {StartupEnv} env
 * @param {{ launch: (plan: BackendPlan) => void,
 *   ready: (plan: BackendPlan | null) => Promise<void>, serve: (dist: string) => Promise<void> }} hooks
 * @returns {Promise<boolean>}
 */
async function boot(env, { launch, ready, serve }) {
  const plan = await planBackend(env)
  if (env.stopped?.()) return false
  if (plan) await step(env, 'backend-launch', () => launch(plan))
  await step(env, 'backend-ready', () => ready(plan))
  const dist = await step(env, 'ui-dist', () => resolveUiDist(env))
  await step(env, 'ui-server', () => serve(dist))
  return true
}

module.exports = { STEPS, boot, planBackend, resolveUiDist }
