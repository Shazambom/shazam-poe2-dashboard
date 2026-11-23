// desktop/scripts/webview.mjs as a process: what it prints and its exit code, against a fake debug port
// (a local /json list). Pins the paths that end before any page is touched: the trade window's address,
// a missing trade window, and an unknown command refused by the guard before the socket opens.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/webview.mjs', import.meta.url))
const TRADE = 'https://www.pathofexile.com/trade2/search/poe2/Standard'

// A fake CDP /json endpoint listing `targets`; resolves to its port and a close().
function fakeCdp(targets) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(targets)) })
    srv.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address())
      resolve({ port, close: () => new Promise(r => { srv.close(() => r(undefined)) }) })
    })
  })
}

/** @returns {Promise<{ code: number | null, out: string, err: string, ms: number }>} */
function run(args, port) {
  return new Promise((resolve) => {
    const t = Date.now()
    const p = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, CDP_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('close', (code) => resolve({ code, out, err, ms: Date.now() - t }))
  })
}

test('url: prints the trade window\'s address and exits 0', async () => {
  const cdp = await fakeCdp([{ type: 'page', url: 'http://127.0.0.1:1/' }, { type: 'webview', url: TRADE, webSocketDebuggerUrl: 'ws://127.0.0.1:1/x' }])
  try {
    const r = await run(['url'], cdp.port)
    assert.deepEqual([r.code, r.out, r.err], [0, `${TRADE}\n`, ''])
  } finally { await cdp.close() }
})

test('no trade window: says so on stderr and exits 1', async () => {
  const cdp = await fakeCdp([{ type: 'page', url: 'http://127.0.0.1:1/' }])
  try {
    for (const cmd of ['url', 'shot']) {
      const r = await run([cmd], cdp.port)
      assert.deepEqual([r.code, r.out, r.err], [1, '', 'no trade window — open Trading → Workspace first\n'], cmd)
    }
  } finally { await cdp.close() }
})
