// Reload the running Electron renderer and print the first exceptions / console.error lines it
// throws over CDP (a blank page after a rebuild = look here). Launch with --remote-debugging-port=9222
// first, then (from desktop/):  node scripts/console.mjs
import WebSocket from 'ws'
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const send = (m, p) => new Promise(r => { const mid = ++id; const h = raw => { const x = JSON.parse(raw); if (x.id === mid) { ws.off('message', h); r(x) } }; ws.on('message', h); ws.send(JSON.stringify({ id: mid, method: m, params: p })) })
const errs = []
ws.on('message', raw => { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(m.params.args.map(a => a.value || a.description).join(' ')) })
ws.on('open', async () => { await send('Runtime.enable', {}); await send('Page.enable', {}); await send('Page.reload', {}); errs.length = 0 /* drop the pre-reload replay */; setTimeout(() => { console.log(JSON.stringify(errs.slice(0, 5), null, 1)); ws.close(); process.exit(0) }, 6000) })
