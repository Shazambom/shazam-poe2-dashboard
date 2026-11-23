/**
 * Packaged macOS Arbiter.app end-to-end smoke test via Chrome DevTools Protocol (CDP).
 *
 * Launches an isolated Arbiter.app instance against a temporary --user-data-dir (never touching
 * ~/Library/Application Support/Arbiter), walks every top-level tab and subtab, checks backend
 * health/status, currency icon loading, Theme Builder presets, zero uncaught page/console errors,
 * zero local API 4xx/5xx errors, and clean shutdown + port release.
 *
 * Usage:
 *   npm --prefix desktop run smoke:mac
 *   node desktop/scripts/smoke-packaged.mjs [--app /path/to/Arbiter.app]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = path.resolve(__dirname, '..')
const DEFAULT_APP = path.join(DESKTOP_DIR, 'release', 'mac-arm64', 'Arbiter.app')

function parseArgs(argv) {
  const out = { app: DEFAULT_APP }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app' && argv[i + 1]) out.app = path.resolve(argv[++i])
  }
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address())
      srv.close(() => resolve(port))
    })
  })
}

async function isPortOpen(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
  })
}

async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return res
      lastErr = new Error(`HTTP ${res.status} from ${url}`)
    } catch (err) {
      lastErr = err
    }
    await sleep(250)
  }
  throw new Error(`Timed out waiting for ${url}: ${lastErr?.message || lastErr}`)
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', resolve)
      this.ws.once('error', reject)
    })
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw))
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else resolve(msg.result)
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params)
      }
    })
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(fn)
  }
  async send(method, params = {}) {
    await this.ready
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (res.exceptionDetails) {
      throw new Error(`CDP eval error: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`)
    }
    return res.result?.value
  }
  close() {
    try { this.ws.close() } catch {}
  }
}

async function waitForPageTarget(cdpPort, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      if (res.ok) {
        const list = await res.json()
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url).startsWith('devtools://'))
        if (page) return page
      }
    } catch {}
    await sleep(250)
  }
  throw new Error(`No Electron renderer page target found on CDP port ${cdpPort}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const binary = path.join(args.app, 'Contents', 'MacOS', 'Arbiter')
  if (!fs.existsSync(binary)) {
    throw new Error(`Packaged app binary not found at ${binary}. Run "npm --prefix desktop run dist:mac" first.`)
  }
  if (await isPortOpen(8210)) {
    throw new Error('Port 8210 is already in use; stop any running Arbiter or backend before running smoke:mac.')
  }

  const cdpPort = await freePort()
  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'arbiter-smoke-'))
  const env = { ...process.env }
  // Never inherit ELECTRON_RUN_AS_NODE from an editor/agent shell.
  delete env.ELECTRON_RUN_AS_NODE

  const logs = []
  const proc = spawn(binary, [`--user-data-dir=${tmpUserData}`, `--remote-debugging-port=${cdpPort}`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout.on('data', (d) => logs.push(String(d)))
  proc.stderr.on('data', (d) => logs.push(String(d)))

  let cdp = null
  const pageErrors = []
  const consoleErrors = []
  const apiErrors = []

  try {
    console.log(`==> Launching ${args.app} (isolated profile ${tmpUserData}, CDP :${cdpPort})`)

    const healthRes = await waitForHttp('http://127.0.0.1:8210/api/health', 30000)
    const health = await healthRes.json()
    if (!health?.ok) throw new Error(`/api/health unexpected payload: ${JSON.stringify(health)}`)

    const statusRes = await waitForHttp('http://127.0.0.1:8210/api/status', 15000)
    const status = await statusRes.json()
    console.log(`  [ok] backend /api/health + /api/status (league=${status.league || 'default'})`)

    const target = await waitForPageTarget(cdpPort, 25000)
    cdp = new CdpClient(target.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable')
    await cdp.send('Log.enable')

    cdp.on('Runtime.exceptionThrown', (p) => {
      pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'Runtime exception')
    })
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
        consoleErrors.push(text)
      }
    })
    cdp.on('Network.responseReceived', (p) => {
      const url = p.response?.url || ''
      const code = p.response?.status || 0
      if (url.startsWith('http://127.0.0.1:8210/api/') && code >= 400) {
        apiErrors.push(`${code} ${url}`)
      }
    })

    // Wait for main app shell tabs to mount
    const tabDeadline = Date.now() + 20000
    let tabsReady = false
    while (Date.now() < tabDeadline) {
      const count = await cdp.eval(`document.querySelectorAll('[role="tab"]').length`)
      if (count >= 5) { tabsReady = true; break }
      await sleep(250)
    }
    if (!tabsReady) throw new Error('Main top-level tabs did not mount within 20s')

    const clickTab = async (name, timeoutMs = 10000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const ok = await cdp.eval(`(() => {
          const tabs = Array.from(document.querySelectorAll('[role="tab"]'))
          const t = tabs.find(el => new RegExp('^' + ${JSON.stringify(name)}, 'i').test((el.textContent || '').trim()))
          if (!t) return false
          t.click()
          return true
        })()`)
        if (ok) {
          await sleep(450)
          return
        }
        await sleep(150)
      }
      throw new Error(`Tab not found within ${timeoutMs}ms: ${name}`)
    }

    // 1. Board + currency icons check (wait for price tiles to finish loading)
    await clickTab('Board')
    const imgDeadline = Date.now() + 20000
    let imgStats = { total: 0, loaded: 0, broken: 0 }
    while (Date.now() < imgDeadline) {
      imgStats = await cdp.eval(`(() => {
        const imgs = Array.from(document.querySelectorAll('.price-tile img.cur-img'))
        const broken = imgs.filter(i => i.complete && i.naturalWidth === 0).length
        const loaded = imgs.filter(i => i.complete && i.naturalWidth > 0).length
        return { total: imgs.length, loaded, broken }
      })()`)
      if (imgStats.total >= 5 && imgStats.loaded === imgStats.total) break
      await sleep(300)
    }
    if (imgStats.total === 0 || imgStats.broken > 0) {
      throw new Error(`Board currency images failed check: ${JSON.stringify(imgStats)}`)
    }
    console.log(`  [ok] Board rendered ${imgStats.loaded}/${imgStats.total} tile currency icons cleanly`)

    // 2. Stash + subtabs
    await clickTab('Stash')
    for (const sub of ['Stash', 'Arbitrage', 'Strat Calculator']) {
      await clickTab(sub)
    }
    console.log('  [ok] Stash + Arbitrage + Strat Calculator rendered')

    // 3. Trading + subtabs
    await clickTab('Trading')
    for (const sub of ['Workspace', 'Live', 'Regex', 'Mods']) {
      await clickTab(sub)
    }
    console.log('  [ok] Trading Workspace + Live + Regex + Mods rendered')

    // 4. Economy + subtabs
    await clickTab('Economy')
    for (const sub of ['Hold', 'Inflation', 'Top movers', 'Market']) {
      await clickTab(sub)
    }
    console.log('  [ok] Economy Hold + Inflation + Top movers + Market rendered')

    // 5. Settings + Theme Builder presets
    await clickTab('Settings')
    const presetCheck = await cdp.eval(`(async () => {
      const sum = Array.from(document.querySelectorAll('summary')).find(s => /Custom themes/i.test(s.textContent || ''))
      if (sum) sum.click()
      for (let i = 0; i < 20; i++) {
        const opts = document.querySelectorAll('details.adv select option').length
        const btn = Array.from(document.querySelectorAll('details.adv button')).find(b => b.textContent.trim() === 'Create')
        if (opts >= 5 && btn && !btn.disabled) return { ok: true, opts }
        await new Promise(r => setTimeout(r, 150))
      }
      return { ok: false, opts: document.querySelectorAll('details.adv select option').length }
    })()`)
    if (!presetCheck?.ok) {
      throw new Error(`Theme Builder presets failed check: ${JSON.stringify(presetCheck)}`)
    }
    console.log(`  [ok] Settings + Theme Builder loaded ${presetCheck.opts} presets`)

    if (pageErrors.length) throw new Error(`Uncaught page errors:\n${pageErrors.join('\n')}`)
    if (consoleErrors.length) throw new Error(`Console errors:\n${consoleErrors.join('\n')}`)
    if (apiErrors.length) throw new Error(`Local API 4xx/5xx responses:\n${apiErrors.join('\n')}`)

    // Clean quit
    cdp.close()
    cdp = null
    proc.kill('SIGTERM')
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for Arbiter to quit')), 12000)
      proc.once('exit', (code) => { clearTimeout(timer); resolve(code) })
    })
    if (exitCode !== 0 && exitCode !== null) {
      throw new Error(`Arbiter exited with non-zero code ${exitCode}`)
    }

    // Confirm backend port 8210 released
    const portDeadline = Date.now() + 8000
    while (Date.now() < portDeadline && (await isPortOpen(8210))) {
      await sleep(200)
    }
    if (await isPortOpen(8210)) {
      throw new Error('Port 8210 remained open after Arbiter quit')
    }
    console.log('  [ok] Clean quit (rc=0) and port 8210 freed')
    console.log('==> PASS: packaged Arbiter.app smoke test succeeded')
  } finally {
    if (cdp) cdp.close()
    if (proc.exitCode === null) {
      try { proc.kill('SIGKILL') } catch {}
      await new Promise((r) => {
        const t = setTimeout(r, 2000)
        proc.once('exit', () => { clearTimeout(t); r() })
      })
    }
    await sleep(300)
    try { fs.rmSync(tmpUserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch {}
  }
}

main().catch((err) => {
  console.error('FAIL:', err?.stack || err)
  process.exit(1)
})
