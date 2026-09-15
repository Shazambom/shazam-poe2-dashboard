// Evaluate a JS expression inside the running Electron renderer over the Chrome
// DevTools Protocol. Launch the app first with:  npx electron . --remote-debugging-port=9222
// Then:  node scripts/cdp.mjs "<js-expression>"   (run from the desktop/ dir)
// The expression is awaited, so async works:  node scripts/cdp.mjs "(await fetch('/api/status')).json()"
import WebSocket from 'ws'

const expr = process.argv[2] || 'document.title'
const port = process.env.CDP_PORT || '9222'

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1') && t.webSocketDebuggerUrl)
if (!page) { console.error('no 127.0.0.1 page target — is the app running with --remote-debugging-port?'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const send = (method, params) => new Promise((resolve) => {
  const mid = ++id
  const onMsg = (raw) => { const m = JSON.parse(raw); if (m.id === mid) { ws.off('message', onMsg); resolve(m) } }
  ws.on('message', onMsg)
  ws.send(JSON.stringify({ id: mid, method, params }))
})

ws.on('open', async () => {
  await send('Runtime.enable', {})
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { return (${expr}) })()`,
    awaitPromise: true, returnByValue: true,
  })
  if (r.result?.exceptionDetails) console.error('EXC', JSON.stringify(r.result.exceptionDetails))
  console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 2))
  ws.close(); process.exit(0)
})
