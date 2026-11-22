#!/usr/bin/env node
/**
 * Repeatable full-stack profiler for Arbiter (artifacts, backend compute, live Electron runtime).
 *
 * Isolates all writes to temporary directories — never mutates ~/Library/Application Support/Arbiter.
 *
 * Usage:
 *   node ops/profile.mjs [options]
 *   npm --prefix desktop run profile
 *   npm --prefix desktop run profile:quick
 *
 * Options:
 *   --only <stages>       Comma-separated subset of: artifacts,backend,runtime (default: all)
 *   --quick               Skip cold boot, run 5x leak check, 3s idle settle (~35s total)
 *   --build               Also time a fresh `npm --prefix frontend run build`
 *   --check-sidecar-idle  Wait ~65s after tour to confirm sidecar idle exit
 *   --app <path>          Path to packaged Arbiter.app (default: desktop/release/mac-arm64/Arbiter.app)
 *   --db <path>           Path to market.sqlite or .sqlite.gz for backend + warm-boot benchmarks
 *   --out <file.json>     Write structured JSON profile to this path
 *   --save                Save profile JSON under .profiles/profile-<sha>-<timestamp>.json
 *   --compare <file.json> Compare current run against a saved baseline JSON
 *   --check               Exit non-zero if budget gates or baseline regressions (>20%) fail
 *   --json                Emit raw JSON to stdout instead of formatted summary tables
 */
import { execFileSync, execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')
const DESKTOP_DIR = path.join(ROOT, 'desktop')
const FRONTEND_DIR = path.join(ROOT, 'frontend')
const DEFAULT_APP = path.join(DESKTOP_DIR, 'release', 'mac-arm64', 'Arbiter.app')
const BACKEND_PORT = 8210

const ALL_STAGES = new Set(['artifacts', 'backend', 'runtime'])

export const DEFAULT_BUDGETS = {
  backendBinaryContamMB: 1.0,
  consoleErrors: 0,
  exceptions: 0,
  peakDomNodes: 15000,
  idleElectronCpuPct: 15.0,
  leakHeapDeltaMB: 15.0,
  regressionPct: 20.0,
}

export function parseArgs(argv) {
  const opts = {
    stages: new Set(ALL_STAGES),
    quick: false,
    build: false,
    checkSidecarIdle: false,
    app: DEFAULT_APP,
    db: null,
    out: null,
    save: false,
    compare: null,
    check: false,
    json: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--only' && argv[i + 1]) {
      const list = argv[++i].split(',').map((s) => s.trim()).filter(Boolean)
      for (const s of list) {
        if (!ALL_STAGES.has(s)) throw new Error(`Unknown stage "${s}". Valid: artifacts, backend, runtime`)
      }
      opts.stages = new Set(list)
    } else if (a === '--quick') {
      opts.quick = true
    } else if (a === '--build') {
      opts.build = true
    } else if (a === '--check-sidecar-idle') {
      opts.checkSidecarIdle = true
    } else if (a === '--app' && argv[i + 1]) {
      opts.app = path.resolve(argv[++i])
    } else if (a === '--db' && argv[i + 1]) {
      opts.db = path.resolve(argv[++i])
    } else if (a === '--out' && argv[i + 1]) {
      opts.out = path.resolve(argv[++i])
    } else if (a === '--save') {
      opts.save = true
    } else if (a === '--compare' && argv[i + 1]) {
      opts.compare = path.resolve(argv[++i])
    } else if (a === '--check') {
      opts.check = true
    } else if (a === '--json') {
      opts.json = true
    } else if (a === '-h' || a === '--help') {
      opts.help = true
    } else {
      throw new Error(`Unknown argument: ${a}`)
    }
  }
  return opts
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => performance.now()

function gitMeta() {
  const run = (cmd) => {
    try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
    catch { return null }
  }
  return {
    sha: run('git rev-parse --short HEAD') || 'unknown',
    branch: run('git rev-parse --abbrev-ref HEAD') || 'unknown',
    dirty: Boolean(run('git status --porcelain')),
    version: JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, 'package.json'), 'utf8')).version,
  }
}

function findPython(preferBuild = false) {
  const candidates = preferBuild
    ? [path.join(DESKTOP_DIR, '.venv-build', 'bin', 'python'), path.join(ROOT, '.venv-test', 'bin', 'python'), 'python3']
    : [path.join(ROOT, '.venv-test', 'bin', 'python'), path.join(DESKTOP_DIR, '.venv-build', 'bin', 'python'), 'python3']
  for (const c of candidates) {
    if (c === 'python3' || fs.existsSync(c)) return c
  }
  return 'python3'
}

function resolveMarketDbPath(explicitDb) {
  if (explicitDb) {
    if (!fs.existsSync(explicitDb)) throw new Error(`--db not found: ${explicitDb}`)
    return explicitDb
  }
  const candidates = [
    path.join(os.homedir(), 'Library', 'Application Support', 'Arbiter', 'data', 'market.sqlite'),
    path.join(ROOT, 'data', 'market.sqlite'),
    path.join(DESKTOP_DIR, 'market-seed', 'market-seed.sqlite.gz'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

function copyMarketDb(srcPath, destSqlitePath) {
  fs.mkdirSync(path.dirname(destSqlitePath), { recursive: true })
  if (srcPath.endsWith('.gz')) {
    const gz = fs.readFileSync(srcPath)
    fs.writeFileSync(destSqlitePath, zlib.gunzipSync(gz))
  } else {
    fs.copyFileSync(srcPath, destSqlitePath)
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
  })
}

function dirSizeBytes(dir) {
  if (!fs.existsSync(dir)) return null
  try {
    const out = execFileSync('du', ['-sk', dir], { encoding: 'utf8' })
    const kb = Number(out.trim().split(/\s+/)[0])
    return Number.isFinite(kb) ? kb * 1024 : null
  } catch {
    return null
  }
}

// ============================ STAGE 1: ARTIFACTS ============================

function profileArtifacts(opts) {
  const res = {}

  // Optional timed frontend rebuild
  if (opts.build) {
    const t0 = now()
    execSync('npm --prefix frontend run build', { cwd: ROOT, stdio: 'pipe' })
    res.frontendBuildMs = +(now() - t0).toFixed(1)
  }

  // Frontend dist/assets breakdown (SI kB to match Vite output)
  const assetsDir = path.join(FRONTEND_DIR, 'dist', 'assets')
  if (fs.existsSync(assetsDir)) {
    const files = fs.readdirSync(assetsDir).sort()
    const chunks = {}
    let totalRaw = 0
    let totalGz = 0
    for (const f of files) {
      const full = path.join(assetsDir, f)
      const buf = fs.readFileSync(full)
      const raw = buf.byteLength
      const gz = zlib.gzipSync(buf, { level: 9 }).byteLength
      totalRaw += raw
      totalGz += gz
      const stem = f.replace(/-[A-Za-z0-9_-]{6,}(\.[^.]+)$/, '$1')
      chunks[stem] = { file: f, rawKB: +(raw / 1000).toFixed(2), gzKB: +(gz / 1000).toFixed(2) }
    }
    res.frontend = {
      totalRawKB: +(totalRaw / 1000).toFixed(2),
      totalGzKB: +(totalGz / 1000).toFixed(2),
      entryJsKB: chunks['index.js']?.rawKB ?? null,
      entryJsGzKB: chunks['index.js']?.gzKB ?? null,
      lineChartJsKB: chunks['LineChart.js']?.rawKB ?? null,
      lineChartJsGzKB: chunks['LineChart.js']?.gzKB ?? null,
      tradingViewJsKB: chunks['TradingView.js']?.rawKB ?? null,
      cssKB: chunks['index.css']?.rawKB ?? null,
      chunks,
    }
  }

  // Backend binary + PyInstaller CArchive inspection + --sidecar --selftest
  const binPath = path.join(DESKTOP_DIR, 'backend-bin', process.platform === 'win32' ? 'poe2arb-backend.exe' : 'poe2arb-backend')
  if (fs.existsSync(binPath)) {
    const sizeBytes = fs.statSync(binPath).size
    const selftestTimes = []
    for (let i = 0; i < 3; i++) {
      const t0 = now()
      execFileSync(binPath, ['--sidecar', '--selftest'], { stdio: 'pipe' })
      selftestTimes.push(+(now() - t0).toFixed(1))
    }
    selftestTimes.sort((a, b) => a - b)

    let pyi = { available: false }
    try {
      const py = findPython(true)
      const raw = execFileSync(py, [path.join(__dirname, 'profile-backend.py'), '--pyi-inspect', binPath], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      pyi = JSON.parse(raw)
    } catch (e) {
      pyi = { available: false, error: e.message }
    }

    res.backendBinary = {
      path: path.relative(ROOT, binPath),
      sizeMB: +(sizeBytes / 1000000).toFixed(2),
      sidecarSelftestMedMs: selftestTimes[Math.floor(selftestTimes.length / 2)],
      sidecarSelftestRunsMs: selftestTimes,
      pyinstaller: pyi,
    }
  }

  // Release artifacts (prefer current desktop/package.json version, fallback newest mtime) & seed
  const releaseDir = path.join(DESKTOP_DIR, 'release')
  const release = {}
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, 'package.json'), 'utf8')).version
  if (fs.existsSync(releaseDir)) {
    const pickArtifact = (suffix) => {
      const matches = fs.readdirSync(releaseDir)
        .filter((f) => f.endsWith(suffix))
        .map((f) => ({ name: f, stat: fs.statSync(path.join(releaseDir, f)) }))
      if (!matches.length) return null
      const exact = matches.find((m) => m.name.includes(`-${pkgVersion}-`))
      if (exact) return exact
      matches.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      return matches[0]
    }
    const dmg = pickArtifact('.dmg')
    const zip = pickArtifact('-mac.zip')
    if (dmg) { release.dmgFile = dmg.name; release.dmgMiB = +(dmg.stat.size / 1048576).toFixed(1) }
    if (zip) { release.zipFile = zip.name; release.zipMiB = +(zip.stat.size / 1048576).toFixed(1) }
    const appSize = dirSizeBytes(opts.app)
    if (appSize != null) release.appMiB = +(appSize / 1048576).toFixed(1)
  }
  const seedPath = path.join(DESKTOP_DIR, 'market-seed', 'market-seed.sqlite.gz')
  if (fs.existsSync(seedPath)) {
    release.seedMB = +(fs.statSync(seedPath).size / 1000000).toFixed(2)
  }
  res.release = release
  return res
}

// ============================ STAGE 2: BACKEND ============================

function profileBackend(opts) {
  const py = findPython(false)
  const pyArgs = [path.join(__dirname, 'profile-backend.py'), '--runs', opts.quick ? '3' : '5']
  if (opts.db) pyArgs.push('--db', opts.db)
  const raw = execFileSync(py, pyArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  })
  return JSON.parse(raw)
}

// ============================ STAGE 3: RUNTIME ============================

function getProcessTree(rootPid) {
  const out = execSync('ps -axo pid,ppid,rss,pcpu,command', { encoding: 'utf8' })
  const rows = out.trim().split('\n').slice(1).map((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/)
    if (!m) return null
    return { pid: Number(m[1]), ppid: Number(m[2]), rssKB: Number(m[3]), cpu: Number(m[4]), cmd: m[5] }
  }).filter(Boolean)

  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const family = []
  for (const r of rows) {
    let cur = r
    let match = false
    const seen = new Set()
    while (cur && !seen.has(cur.pid)) {
      seen.add(cur.pid)
      if (cur.pid === rootPid) { match = true; break }
      cur = byPid.get(cur.ppid)
    }
    if (match) family.push(r)
  }

  const procs = family.map((r) => {
    let role = 'other'
    if (r.cmd.includes('--sidecar')) role = 'backend-sidecar'
    else if (r.cmd.includes('poe2arb-backend')) role = 'backend-main'
    else if (r.cmd.includes('--type=renderer')) role = 'electron-renderer'
    else if (r.cmd.includes('--type=gpu-process')) role = 'electron-gpu'
    else if (r.cmd.includes('--type=utility')) role = 'electron-utility'
    else if (r.pid === rootPid) role = 'electron-main'
    return { pid: r.pid, role, rssMB: +(r.rssKB / 1024).toFixed(1), cpu: r.cpu }
  })

  const totalMB = +procs.reduce((a, b) => a + b.rssMB, 0).toFixed(1)
  const byRole = {}
  const cpuByRole = {}
  for (const p of procs) {
    byRole[p.role] = +((byRole[p.role] || 0) + p.rssMB).toFixed(1)
    cpuByRole[p.role] = +((cpuByRole[p.role] || 0) + p.cpu).toFixed(1)
  }
  const electronCpuPct = +((cpuByRole['electron-renderer'] || 0) + (cpuByRole['electron-gpu'] || 0) + (cpuByRole['electron-main'] || 0)).toFixed(1)
  return { totalMB, count: procs.length, byRole, cpuByRole, electronCpuPct, procs }
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.id = 0
    this.pending = new Map()
    this.consoleErrors = []
    this.exceptions = []
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true })
      this.ws.addEventListener('error', rej, { once: true })
    })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)))
        else res(msg.result)
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
        this.consoleErrors.push(text)
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'exception')
      }
    })
    await this.send('Runtime.enable')
    await this.send('Performance.enable')
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'CDP eval error')
    return r.result?.value
  }
  async metrics() {
    const { metrics } = await this.send('Performance.getMetrics')
    const m = Object.fromEntries(metrics.map(({ name, value }) => [name, value]))
    return {
      JSHeapUsedMB: +(m.JSHeapUsedSize / 1048576).toFixed(2),
      JSHeapTotalMB: +(m.JSHeapTotalSize / 1048576).toFixed(2),
      Nodes: m.Nodes,
      Documents: m.Documents,
      JSEventListeners: m.JSEventListeners,
      LayoutCount: m.LayoutCount,
      RecalcStyleCount: m.RecalcStyleCount,
      ScriptDurationS: +(m.ScriptDuration || 0).toFixed(3),
    }
  }
  close() {
    try { this.ws?.close() } catch {}
  }
}

async function waitForHealth(t0, timeoutMs = 45000) {
  while (now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/health`)
      if (r.ok) return { ms: +(now() - t0).toFixed(1), body: await r.json() }
    } catch {}
    await sleep(50)
  }
  throw new Error(`Timed out waiting for /api/health after ${timeoutMs}ms`)
}

async function waitForCdpTarget(cdpPort, t0, timeoutMs = 35000) {
  while (now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      if (r.ok) {
        const list = await r.json()
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url).startsWith('devtools://'))
        if (page) return { ms: +(now() - t0).toFixed(1), target: page }
      }
    } catch {}
    await sleep(50)
  }
  throw new Error(`Timed out waiting for CDP target on :${cdpPort}`)
}

async function waitForDom(cdp, expr, timeoutMs = 20000) {
  const t0 = now()
  while (now() - t0 < timeoutMs) {
    try {
      if (await cdp.eval(expr)) return +(now() - t0).toFixed(1)
    } catch {}
    await sleep(40)
  }
  return -1
}

async function stopApp(proc) {
  if (!proc) return
  const pid = proc.pid
  try { proc.kill('SIGTERM') } catch {}
  const deadline = now() + 5000
  while (now() < deadline && proc.exitCode === null) await sleep(100)
  if (proc.exitCode === null) {
    try { proc.kill('SIGKILL') } catch {}
  }
  // Ensure any child backend owned by this instance is also gone and port 8210 is released
  const tree = getProcessTree(pid)
  for (const p of tree.procs) {
    try { process.kill(p.pid, 'SIGKILL') } catch {}
  }
  const portDeadline = now() + 5000
  while (now() < portDeadline && await isPortOpen(BACKEND_PORT)) await sleep(100)
}

async function clickNav(cdp, label) {
  return cdp.eval(`(() => {
    const els = [...document.querySelectorAll('button, [role="tab"], a, nav *')]
    const el = els.find((e) => e.textContent && e.textContent.trim() === ${JSON.stringify(label)})
    if (!el) return false
    el.click()
    return true
  })()`)
}

async function benchHttp(urlPath, runs = 5) {
  const url = `http://127.0.0.1:${BACKEND_PORT}${urlPath}`
  const times = []
  let status = 0
  let bytes = 0
  for (let i = 0; i < runs; i++) {
    const t0 = now()
    const r = await fetch(url)
    const buf = await r.arrayBuffer()
    times.push(+(now() - t0).toFixed(1))
    status = r.status
    bytes = buf.byteLength
  }
  const warm = times.slice(1).sort((a, b) => a - b)
  return {
    path: urlPath,
    status,
    bytes,
    coldMs: times[0],
    warmMedMs: warm.length ? warm[Math.floor(warm.length / 2)] : times[0],
    warmMaxMs: warm.length ? warm[warm.length - 1] : times[0],
  }
}

async function profileRuntime(opts) {
  const binary = path.join(opts.app, 'Contents', 'MacOS', 'Arbiter')
  if (!fs.existsSync(binary)) {
    throw new Error(`Packaged app not found at ${binary}. Run "npm --prefix desktop run dist:mac" first, or pass --only artifacts,backend.`)
  }
  if (await isPortOpen(BACKEND_PORT)) {
    throw new Error(`Port ${BACKEND_PORT} is already in use. Stop any running Arbiter/backend before profiling.`)
  }

  const runtime = {}
  const spawnEnv = { ...process.env }
  delete spawnEnv.ELECTRON_RUN_AS_NODE

  // Phase A: Cold boot (seed extraction) unless --quick
  if (!opts.quick) {
    const coldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbiter-prof-cold-'))
    const cdpPort = await freePort()
    let proc = null
    let cdp = null
    try {
      const t0 = now()
      proc = spawn(binary, [`--user-data-dir=${coldDir}`, `--remote-debugging-port=${cdpPort}`], {
        env: spawnEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const [health, cdpInfo] = await Promise.all([waitForHealth(t0, 60000), waitForCdpTarget(cdpPort, t0, 60000)])
      cdp = new CdpClient(cdpInfo.target.webSocketDebuggerUrl)
      await cdp.connect()
      await waitForDom(cdp, `document.body && document.body.innerText.includes('Divine') && document.querySelectorAll('button').length > 5`, 30000)
      const boardPaintedMs = +(now() - t0).toFixed(1)
      const navTiming = await cdp.eval(`(() => {
        const nav = performance.getEntriesByType('navigation')[0]
        const paints = Object.fromEntries(performance.getEntriesByType('paint').map(p => [p.name, +p.startTime.toFixed(1)]))
        return {
          domInteractiveMs: nav ? +nav.domInteractive.toFixed(1) : null,
          loadEventMs: nav ? +nav.loadEventEnd.toFixed(1) : null,
          fcpMs: paints['first-contentful-paint'] ?? null,
        }
      })()`)
      runtime.coldBoot = {
        healthMs: health.ms,
        cdpReadyMs: cdpInfo.ms,
        boardPaintedMs,
        ...navTiming,
        rssMB: getProcessTree(proc.pid).totalMB,
      }
    } finally {
      cdp?.close()
      await stopApp(proc)
      fs.rmSync(coldDir, { recursive: true, force: true })
    }
  }

  // Phase B: Warm boot + HTTP endpoints + UI tour + leak check + idle CPU
  const warmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbiter-prof-warm-'))
  const dbSrc = resolveMarketDbPath(opts.db)
  if (dbSrc) copyMarketDb(dbSrc, path.join(warmDir, 'data', 'market.sqlite'))

  const cdpPort = await freePort()
  let proc = null
  let cdp = null
  try {
    const t0 = now()
    proc = spawn(binary, [`--user-data-dir=${warmDir}`, `--remote-debugging-port=${cdpPort}`], {
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const [health, cdpInfo] = await Promise.all([waitForHealth(t0, 45000), waitForCdpTarget(cdpPort, t0, 45000)])
    cdp = new CdpClient(cdpInfo.target.webSocketDebuggerUrl)
    await cdp.connect()
    await waitForDom(cdp, `document.body && document.body.innerText.includes('Divine') && document.querySelectorAll('button').length > 5`, 25000)
    const boardPaintedMs = +(now() - t0).toFixed(1)
    const navTiming = await cdp.eval(`(() => {
      const nav = performance.getEntriesByType('navigation')[0]
      const paints = Object.fromEntries(performance.getEntriesByType('paint').map(p => [p.name, +p.startTime.toFixed(1)]))
      return {
        domInteractiveMs: nav ? +nav.domInteractive.toFixed(1) : null,
        fcpMs: paints['first-contentful-paint'] ?? null,
      }
    })()`)
    await sleep(800)

    runtime.warmBoot = {
      healthMs: health.ms,
      cdpReadyMs: cdpInfo.ms,
      boardPaintedMs,
      ...navTiming,
      rss: getProcessTree(proc.pid),
      metrics: await cdp.metrics(),
    }

    // Live HTTP endpoints
    const httpPaths = [
      '/api/health',
      '/api/status',
      '/api/board?window=24',
      '/api/hold?horizon=3d&numeraire=divine',
      '/api/inflation?anchor=lock',
      '/api/inflation?anchor=divine',
      '/api/inflation?anchor=mirror',
      '/api/movers',
      '/api/market/edges',
      '/api/market/top',
      '/api/capital',
      '/api/mods/pools',
      '/api/leaguearc?item=Divine+Orb&numeraire=divine',
    ]
    const httpRuns = opts.quick ? 3 : 5
    runtime.httpEndpoints = []
    for (const ep of httpPaths) {
      runtime.httpEndpoints.push(await benchHttp(ep, httpRuns))
    }

    // Full UI tab tour
    const tour = []
    let peakNodes = runtime.warmBoot.metrics.Nodes
    let peakListeners = runtime.warmBoot.metrics.JSEventListeners
    let peakRendererRssMB = runtime.warmBoot.rss.byRole['electron-renderer'] || 0

    const visit = async (label, readyExpr, settleMs = 400) => {
      const ts = now()
      const clicked = await clickNav(cdp, label)
      const readyMs = clicked && readyExpr ? await waitForDom(cdp, readyExpr, 10000) : -1
      const wallMs = +(now() - ts).toFixed(1)
      await sleep(settleMs)
      const m = await cdp.metrics()
      const r = getProcessTree(proc.pid)
      peakNodes = Math.max(peakNodes, m.Nodes)
      peakListeners = Math.max(peakListeners, m.JSEventListeners)
      peakRendererRssMB = Math.max(peakRendererRssMB, r.byRole['electron-renderer'] || 0)
      tour.push({
        tab: label,
        clicked,
        wallMs,
        readyMs,
        heapMB: m.JSHeapUsedMB,
        nodes: m.Nodes,
        listeners: m.JSEventListeners,
        rendererRssMB: r.byRole['electron-renderer'] || 0,
      })
    }

    await visit('Stash', `document.body.innerText.length > 100`, 400)
    await visit('Trading', `document.body.innerText.includes('Workspace') || document.body.innerText.includes('Regex')`, 450)
    await visit('Regex', `document.body.innerText.toLowerCase().includes('regex')`, 350)
    await visit('Mods', `document.body.innerText.length > 100`, 350)
    await visit('Workspace', `document.body.innerText.length > 100`, 350)
    await visit('Economy', `document.body.innerText.includes('Hold') || document.body.innerText.includes('Inflation')`, 500)
    await visit('Inflation', `document.querySelectorAll('svg.recharts-surface, .recharts-wrapper svg').length > 0`, 550)
    await visit('Market', `document.querySelectorAll('table tbody tr').length > 0`, 600)
    await visit('Settings', `document.body.innerText.toLowerCase().includes('theme') || document.body.innerText.toLowerCase().includes('settings')`, 400)
    await visit('Board', `document.body.innerText.includes('Divine')`, 400)

    runtime.tabTour = tour
    runtime.peakDomNodes = peakNodes
    runtime.peakListeners = peakListeners
    runtime.peakRendererRssMB = peakRendererRssMB
    runtime.rssAfterTour = getProcessTree(proc.pid)

    // Tab-switch memory leak check (5x in quick mode, 10x in full mode)
    const cycles = opts.quick ? 5 : 10
    await cdp.send('HeapProfiler.enable')
    await cdp.send('HeapProfiler.collectGarbage')
    await sleep(300)
    const before = await cdp.metrics()
    const cycleTimes = []
    for (let i = 0; i < cycles; i++) {
      const tc = now()
      await clickNav(cdp, 'Economy')
      await sleep(100)
      await clickNav(cdp, 'Inflation')
      await sleep(180)
      await clickNav(cdp, 'Trading')
      await sleep(120)
      await clickNav(cdp, 'Board')
      await sleep(120)
      cycleTimes.push(+(now() - tc).toFixed(1))
    }
    await cdp.send('HeapProfiler.collectGarbage')
    await sleep(400)
    const after = await cdp.metrics()
    runtime.leakCheck = {
      cycles,
      beforeHeapMB: before.JSHeapUsedMB,
      afterHeapMB: after.JSHeapUsedMB,
      deltaHeapMB: +(after.JSHeapUsedMB - before.JSHeapUsedMB).toFixed(2),
      deltaNodes: after.Nodes - before.Nodes,
      deltaListeners: after.JSEventListeners - before.JSEventListeners,
      avgCycleMs: +(cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length).toFixed(1),
    }

    // Idle CPU settle on Board
    await sleep(opts.quick ? 3000 : 5000)
    runtime.idleBoard = getProcessTree(proc.pid)

    // Optional 65s sidecar idle-exit verification
    if (opts.checkSidecarIdle) {
      await sleep(65000)
      const afterSidecar = getProcessTree(proc.pid)
      runtime.sidecarIdleCheck = {
        sidecarAlive: Boolean(afterSidecar.byRole['backend-sidecar']),
        rss: afterSidecar,
      }
    }

    runtime.consoleErrors = cdp.consoleErrors
    runtime.exceptions = cdp.exceptions
  } finally {
    cdp?.close()
    await stopApp(proc)
    fs.rmSync(warmDir, { recursive: true, force: true })
  }

  return runtime
}

// ============================ DIFF & BUDGETS ============================

export function extractMetrics(profile) {
  const m = {}
  const set = (k, v, unit, lowerBetter = true) => {
    if (typeof v === 'number' && Number.isFinite(v)) m[k] = { value: v, unit, lowerBetter }
  }
  const a = profile.artifacts
  if (a) {
    set('artifact.backendBinaryMB', a.backendBinary?.sizeMB, 'MB')
    set('artifact.backendContamMB', a.backendBinary?.pyinstaller?.contaminantTotalMB, 'MB')
    set('artifact.sidecarSelftestMs', a.backendBinary?.sidecarSelftestMedMs, 'ms')
    set('artifact.entryJsKB', a.frontend?.entryJsKB, 'kB')
    set('artifact.entryJsGzKB', a.frontend?.entryJsGzKB, 'kB')
    set('artifact.lineChartJsKB', a.frontend?.lineChartJsKB, 'kB')
    set('artifact.frontendTotalKB', a.frontend?.totalRawKB, 'kB')
    set('artifact.frontendBuildMs', a.frontendBuildMs, 'ms')
    set('artifact.dmgMiB', a.release?.dmgMiB, 'MiB')
  }
  const b = profile.backend
  if (b?.ops) {
    set('backend.peakRssMB', b.peakRssMB, 'MB')
    for (const [name, stat] of Object.entries(b.ops)) {
      const val = name.includes('_find_routes') ? stat.firstMs : stat.medMs
      set(`backend.${name}`, val, 'ms')
    }
  }
  const r = profile.runtime
  if (r) {
    set('runtime.coldHealthMs', r.coldBoot?.healthMs, 'ms')
    set('runtime.coldBoardMs', r.coldBoot?.boardPaintedMs, 'ms')
    set('runtime.warmHealthMs', r.warmBoot?.healthMs, 'ms')
    set('runtime.warmBoardMs', r.warmBoot?.boardPaintedMs, 'ms')
    set('runtime.fcpMs', r.warmBoot?.fcpMs, 'ms')
    set('runtime.peakDomNodes', r.peakDomNodes, 'nodes')
    set('runtime.peakRendererRssMB', r.peakRendererRssMB, 'MB')
    set('runtime.idleTotalRssMB', r.idleBoard?.totalMB, 'MB')
    set('runtime.idleBackendRssMB', r.idleBoard?.byRole?.['backend-main'], 'MB')
    set('runtime.idleElectronCpuPct', r.idleBoard?.electronCpuPct, '%')
    set('runtime.leakHeapDeltaMB', r.leakCheck?.deltaHeapMB, 'MB')
    set('runtime.consoleErrors', r.consoleErrors?.length, 'err')
    set('runtime.exceptions', r.exceptions?.length, 'err')
    for (const ep of r.httpEndpoints || []) {
      if (ep.status === 200) {
        const [rawPath, qs] = ep.path.split('?')
        const base = rawPath.replace(/^\/api\//, '').replace(/\//g, '.')
        const anchor = qs ? new URLSearchParams(qs).get('anchor') : null
        const key = anchor ? `${base}.${anchor}` : base
        set(`http.${key}.warmMs`, ep.warmMedMs, 'ms')
      }
    }
  }
  return m
}

export function compareProfiles(baseline, current, regressionPct = DEFAULT_BUDGETS.regressionPct) {
  const baseM = extractMetrics(baseline)
  const curM = extractMetrics(current)
  const rows = []
  for (const key of Object.keys(curM)) {
    if (!(key in baseM)) continue
    const b = baseM[key].value
    const c = curM[key].value
    const delta = +(c - b).toFixed(2)
    const pct = b === 0 ? (c === 0 ? 0 : 100) : +(((c - b) / b) * 100).toFixed(1)
    // Ignore tiny sub-millisecond jitter when flagging regressions
    const significant = Math.abs(delta) >= (curM[key].unit === 'ms' ? 5 : 0.5)
    const regressed = significant && (curM[key].lowerBetter ? pct > regressionPct : pct < -regressionPct)
    rows.push({ key, unit: curM[key].unit, baseline: b, current: c, delta, pct, regressed })
  }
  return rows
}

export function evaluateBudgets(profile, budgets = DEFAULT_BUDGETS, comparisonRows = []) {
  const failures = []
  const checkMax = (label, actual, limit, unit = '') => {
    if (typeof actual === 'number' && actual > limit) {
      failures.push(`${label}: ${actual}${unit} > budget ${limit}${unit}`)
    }
  }
  const contam = profile.artifacts?.backendBinary?.pyinstaller?.contaminantTotalMB
  checkMax('backend venv contamination', contam, budgets.backendBinaryContamMB, ' MB')

  const r = profile.runtime
  if (r) {
    checkMax('console errors', r.consoleErrors?.length, budgets.consoleErrors)
    checkMax('uncaught exceptions', r.exceptions?.length, budgets.exceptions)
    checkMax('peak DOM nodes', r.peakDomNodes, budgets.peakDomNodes)
    checkMax('idle Electron CPU', r.idleBoard?.electronCpuPct, budgets.idleElectronCpuPct, '%')
    checkMax('tab-switch leak heap delta', r.leakCheck?.deltaHeapMB, budgets.leakHeapDeltaMB, ' MB')
    if (r.sidecarIdleCheck?.sidecarAlive) {
      failures.push('sidecar still alive after 65s idle')
    }
  }
  for (const row of comparisonRows) {
    if (row.regressed) {
      failures.push(`regression ${row.key}: ${row.baseline} -> ${row.current} ${row.unit} (+${row.pct}%)`)
    }
  }
  return failures
}

export function formatReport(profile, comparisonRows = [], budgetFailures = []) {
  const lines = []
  const g = profile.meta
  lines.push(`=== Arbiter Profile (${g.version} @ ${g.sha}${g.dirty ? '*' : ''}, ${g.platform}/${g.arch}) ===`)

  if (profile.artifacts) {
    const a = profile.artifacts
    lines.push('\n[Artifacts]')
    if (a.backendBinary) {
      const pyi = a.backendBinary.pyinstaller
      const contam = pyi?.available ? ` (venv bloat: ${pyi.contaminantTotalMB} MB)` : ''
      lines.push(`  poe2arb-backend        : ${a.backendBinary.sizeMB} MB${contam} | --sidecar --selftest: ${a.backendBinary.sidecarSelftestMedMs} ms`)
    }
    if (a.frontend) {
      const f = a.frontend
      lines.push(`  frontend entry JS      : ${f.entryJsKB} kB (${f.entryJsGzKB} kB gz) | LineChart: ${f.lineChartJsKB} kB | total: ${f.totalRawKB} kB`)
    }
    if (a.frontendBuildMs != null) lines.push(`  frontend build         : ${a.frontendBuildMs} ms`)
    if (a.release && Object.keys(a.release).length) {
      const parts = []
      if (a.release.dmgMiB != null) parts.push(`.dmg ${a.release.dmgMiB} MiB`)
      if (a.release.zipMiB != null) parts.push(`.zip ${a.release.zipMiB} MiB`)
      if (a.release.appMiB != null) parts.push(`.app ${a.release.appMiB} MiB`)
      if (a.release.seedMB != null) parts.push(`seed ${a.release.seedMB} MB`)
      lines.push(`  release bundle         : ${parts.join(' | ')}`)
    }
  }

  if (profile.backend) {
    const b = profile.backend
    lines.push(`\n[Backend Compute] (${b.db.league}: ${b.db.leagueDigestRows.toLocaleString()} rows, Peak RSS ${b.peakRssMB} MB)`)
    for (const [name, s] of Object.entries(b.ops)) {
      lines.push(`  ${name.padEnd(38)} first=${String(s.firstMs).padStart(6)} ms  med=${String(s.medMs).padStart(6)} ms`)
    }
  }

  if (profile.runtime) {
    const r = profile.runtime
    lines.push('\n[Packaged Runtime]')
    if (r.coldBoot) {
      lines.push(`  cold boot              : health ${r.coldBoot.healthMs} ms | board ${r.coldBoot.boardPaintedMs} ms | FCP ${r.coldBoot.fcpMs} ms`)
    }
    lines.push(`  warm boot              : health ${r.warmBoot.healthMs} ms | board ${r.warmBoot.boardPaintedMs} ms | FCP ${r.warmBoot.fcpMs} ms`)
    lines.push(`  DOM / renderer peak    : ${r.peakDomNodes.toLocaleString()} nodes | ${r.peakListeners.toLocaleString()} listeners | renderer ${r.peakRendererRssMB} MB`)
    lines.push(`  idle Board             : RSS ${r.idleBoard.totalMB} MB (backend ${r.idleBoard.byRole['backend-main'] || 0} MB, renderer ${r.idleBoard.byRole['electron-renderer'] || 0} MB) | Electron CPU ${r.idleBoard.electronCpuPct}%`)
    lines.push(`  leak check (${r.leakCheck.cycles}x)        : heap ${r.leakCheck.deltaHeapMB >= 0 ? '+' : ''}${r.leakCheck.deltaHeapMB} MB | nodes ${r.leakCheck.deltaNodes >= 0 ? '+' : ''}${r.leakCheck.deltaNodes} | listeners ${r.leakCheck.deltaListeners >= 0 ? '+' : ''}${r.leakCheck.deltaListeners}`)
    lines.push(`  errors                 : console=${r.consoleErrors.length}, exceptions=${r.exceptions.length}`)
    lines.push('  live HTTP (warm med)   : ' + r.httpEndpoints
      .filter((e) => e.status === 200)
      .map((e) => {
        const [rawPath, qs] = e.path.split('?')
        const base = rawPath.replace('/api/', '')
        const anchor = qs ? new URLSearchParams(qs).get('anchor') : null
        return `${anchor ? `${base}(${anchor})` : base}=${e.warmMedMs}ms`
      })
      .join(', '))
  }

  if (comparisonRows.length) {
    lines.push('\n[Comparison vs Baseline]')
    for (const row of comparisonRows) {
      const sign = row.delta > 0 ? '+' : ''
      const flag = row.regressed ? '  [REGRESSED]' : ''
      lines.push(`  ${row.key.padEnd(42)} ${String(row.baseline).padStart(7)} -> ${String(row.current).padStart(7)} ${row.unit.padEnd(5)} (${sign}${row.pct}%)${flag}`)
    }
  }

  if (budgetFailures.length) {
    lines.push('\n[Budget Failures]')
    for (const f of budgetFailures) lines.push(`  FAIL: ${f}`)
  }

  return lines.join('\n')
}

// ============================ MAIN ============================

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, ''))
    return
  }

  const profile = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    meta: {
      ...gitMeta(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      quick: opts.quick,
    },
  }

  if (opts.stages.has('artifacts')) {
    if (!opts.json) console.error('==> Stage 1/3: Artifacts & binary inspection...')
    profile.artifacts = profileArtifacts(opts)
  }
  if (opts.stages.has('backend')) {
    if (!opts.json) console.error('==> Stage 2/3: Backend compute microbenchmarks...')
    profile.backend = profileBackend(opts)
  }
  if (opts.stages.has('runtime')) {
    if (!opts.json) console.error('==> Stage 3/3: Packaged Electron runtime profile...')
    profile.runtime = await profileRuntime(opts)
  }

  let savedPath = opts.out
  if (opts.save && !savedPath) {
    const dir = path.join(ROOT, '.profiles')
    fs.mkdirSync(dir, { recursive: true })
    const ts = profile.timestamp.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
    savedPath = path.join(dir, `profile-${profile.meta.sha}-${ts}.json`)
  }
  if (savedPath) {
    fs.mkdirSync(path.dirname(savedPath), { recursive: true })
    fs.writeFileSync(savedPath, JSON.stringify(profile, null, 2) + '\n')
  }

  let comparisonRows = []
  if (opts.compare) {
    const baseline = JSON.parse(fs.readFileSync(opts.compare, 'utf8'))
    comparisonRows = compareProfiles(baseline, profile)
  }
  const budgetFailures = opts.check ? evaluateBudgets(profile, DEFAULT_BUDGETS, comparisonRows) : []

  if (opts.json) {
    console.log(JSON.stringify({ profile, comparison: comparisonRows, budgetFailures, savedPath }, null, 2))
  } else {
    console.log(formatReport(profile, comparisonRows, budgetFailures))
    if (savedPath) console.log(`\nSaved JSON profile: ${savedPath}`)
  }

  if (opts.check && budgetFailures.length > 0) {
    process.exit(1)
  }
}

if (path.resolve(process.argv[1] || '') === __filename) {
  main().catch((err) => {
    console.error('PROFILE ERROR:', err.message)
    process.exit(1)
  })
}
