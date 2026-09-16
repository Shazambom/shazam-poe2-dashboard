// The EE2 query builder's process (roadmap §4.3): an Electron utilityProcess entry (off the UI
// thread, off main's event loop, crash-isolated) and a `--stdin` CLI for tests/manual checks.
//
// Protocol (parent ↔ worker over process.parentPort / IPC):
//   → { t:'init', dataDir? }                 ← { t:'ready', ms, items, stats }
//   → { t:'build', id, raw, prefs }          ← { t:'built', id, q, name, item, host, buildMs }
//                                           ← { t:'error', id, stage, message }
// A build that runs past BUILD_TIMEOUT_MS reports { stage:'timeout' } (the parser is sync, so this
// only trips on a pathological input). Nothing here touches the network — index.js refuses it.
//
//   node desktop/src/ee2-history/worker.js --stdin [--league "Standard"] < item.txt   → prints the result JSON
'use strict'
const port = require('./port.js')

const BUILD_TIMEOUT_MS = 3000

async function handle(msg, reply) {
  if (!msg || typeof msg !== 'object') return
  if (msg.t === 'init') {
    try { reply({ t: 'ready', ...(await port.init(msg.dataDir)) }) } catch (e) { reply({ t: 'error', id: null, stage: 'init', message: String(e && e.message || e) }) }
    return
  }
  if (msg.t === 'build') {
    const t0 = Date.now()
    let done = false
    const timer = setTimeout(() => { if (!done) { done = true; reply({ t: 'error', id: msg.id, stage: 'timeout', message: `build exceeded ${BUILD_TIMEOUT_MS} ms` }) } }, BUILD_TIMEOUT_MS)
    try {
      await port.init()
      const r = port.buildQuery(msg.raw, msg.prefs)
      clearTimeout(timer)
      if (done) return
      done = true
      if (r.error) reply({ t: 'error', id: msg.id, ...r.error })
      else reply({ t: 'built', id: msg.id, ...r, buildMs: Date.now() - t0 })
    } catch (e) { clearTimeout(timer); if (!done) { done = true; reply({ t: 'error', id: msg.id, stage: 'request', message: String(e && e.message || e) }) } }
  }
}

if (process.argv.includes('--stdin')) {
  const league = process.argv[process.argv.indexOf('--league') + 1]
  let raw = ''
  process.stdin.setEncoding('utf8').on('data', d => { raw += d }).on('end', async () => {
    await port.init()
    const r = port.buildQuery(raw, { leagueId: process.argv.includes('--league') ? league : 'Standard' })
    process.stdout.write(JSON.stringify(r) + '\n')
    process.exit(r.error ? 2 : 0)
  })
} else if (process.parentPort) {
  // Electron utilityProcess
  process.parentPort.on('message', (e) => handle(e.data, (m) => process.parentPort.postMessage(m)))
} else if (process.send) {
  // plain child_process fork (tests)
  process.on('message', (m) => handle(m, (r) => process.send(r)))
}

module.exports = { handle, BUILD_TIMEOUT_MS }
