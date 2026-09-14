// OPTIONAL observer: authoritative "is EE2's server up?" via its /config endpoint.
//
// WHY NOT the /events websocket (the obvious choice):
//   We traced EE2's server (reference clone ~/Exiled-Exchange-2). On EVERY ws
//   connection the server does `lastActiveClient = socket` (main/src/server.ts:96),
//   and it routes replies with sendEventTo("last-active", ...) (server.ts:58-70,
//   113). So an external client connecting to ws://127.0.0.1:<port>/events would
//   HIJACK EE2's "last-active" client and could divert price-check results away
//   from EE2's own overlay until it re-announces itself. That's a side effect on
//   EE2, and our brief is a LISTENING layer with no side effects. So we refuse to
//   open the websocket.
//
//   Instead we poll the server's plain HTTP `GET /config` route (server.ts:126-137),
//   which returns HostState { version, updater, contents } and mutates NOTHING.
//   It's a stateless read: authoritative proof EE2's server is up, plus its
//   version — a stronger signal than process/config-dir detection, with zero
//   interference.
//
// PORT DISCOVERY: EE2 binds its server to an ephemeral port (`port = 0` in prod,
// server.ts:131) and never writes it to disk — it hands the number in-process to
// the renderer via overlay.loadAppPage(port) (main/src/main.ts:129-132,
// OverlayWindow.ts:77-79). So a peer can't read the port from a file. We discover
// it by enumerating the EE2 process's own LISTEN sockets (lsof / PowerShell),
// then confirming each candidate with a /config probe. No brute port-scan.
'use strict'

const http = require('http')
const { execFile } = require('child_process')

// Run a short, guarded command and hand back stdout (or '' on any failure).
function run(cmd, args, timeout = 2500) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true }, (err, out) => resolve(err ? '' : String(out || '')))
    } catch { resolve('') }
  })
}

// PIDs of running EE2-looking processes. Best-effort per platform.
async function ee2Pids() {
  const pids = new Set()
  if (process.platform === 'win32') {
    // CSV: "Name","PID",...
    const out = await run('tasklist', ['/FO', 'CSV', '/NH'])
    for (const line of out.split(/\r?\n/)) {
      if (/exiled.?exchange/i.test(line)) {
        const m = line.match(/^"[^"]*","(\d+)"/)
        if (m) pids.add(Number(m[1]))
      }
    }
  } else {
    const out = await run('ps', ['-A', '-o', 'pid=,comm='])
    for (const line of out.split(/\r?\n/)) {
      if (/exiled.?exchange/i.test(line)) {
        const m = line.match(/^\s*(\d+)\s/)
        if (m) pids.add(Number(m[1]))
      }
    }
  }
  return [...pids]
}

// LISTEN ports owned by a pid. lsof on mac/linux, PowerShell on win.
async function listenPorts(pid) {
  const ports = new Set()
  if (process.platform === 'win32') {
    const ps = `Get-NetTCPConnection -OwningProcess ${pid} -State Listen | Select-Object -ExpandProperty LocalPort`
    const out = await run('powershell', ['-NoProfile', '-Command', ps])
    for (const m of out.matchAll(/(\d+)/g)) ports.add(Number(m[1]))
  } else {
    const out = await run('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'])
    for (const m of out.matchAll(/:(\d+)\s*\(LISTEN\)/g)) ports.add(Number(m[1]))
  }
  return [...ports].filter((p) => p > 0 && p < 65536)
}

// Probe http://127.0.0.1:<port>/config; resolve EE2's version if it's the EE2
// server, else null. Stateless GET — no side effect on EE2.
function probeConfig(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/config', timeout: 1500 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null) }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy() })
      res.on('end', () => {
        try {
          const j = JSON.parse(body)
          // HostState shape from server.ts:128 — version + contents object.
          if (j && typeof j.version === 'string' && 'contents' in j) return resolve(j.version)
        } catch {}
        resolve(null)
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

// Discover the EE2 server port and version. Prefers a previously-known port
// (cheap re-probe); otherwise enumerates EE2's LISTEN sockets and confirms each.
async function discover(knownPort) {
  if (knownPort) {
    const v = await probeConfig(knownPort)
    if (v != null) return { port: knownPort, version: v }
  }
  for (const pid of await ee2Pids()) {
    for (const port of await listenPorts(pid)) {
      if (port === knownPort) continue
      const v = await probeConfig(port)
      if (v != null) return { port, version: v }
    }
  }
  return null
}

// Polls for the EE2 server and calls onUp({port,version,url}) / onDown() on
// transitions. Never throws; if discovery tooling is missing it just stays quiet.
class ServerWatcher {
  constructor({ intervalMs = 15000, onUp, onDown } = {}) {
    this._intervalMs = Math.max(intervalMs, 3000)
    this._onUp = typeof onUp === 'function' ? onUp : () => {}
    this._onDown = typeof onDown === 'function' ? onDown : () => {}
    this._timer = null
    this._port = null
  }

  start() {
    if (this._timer) return
    this._poll()   // immediate first check
    this._timer = setInterval(() => this._poll(), this._intervalMs)
    if (this._timer.unref) this._timer.unref()
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
    this._port = null
  }

  async _poll() {
    let found = null
    try { found = await discover(this._port) } catch {}
    if (found) {
      const wasDown = this._port == null
      this._port = found.port
      if (wasDown) {
        try { this._onUp({ port: found.port, version: found.version, url: `http://127.0.0.1:${found.port}` }) } catch {}
      }
    } else if (this._port != null) {
      this._port = null
      try { this._onDown() } catch {}
    }
  }
}

module.exports = { ServerWatcher, discover, probeConfig }
