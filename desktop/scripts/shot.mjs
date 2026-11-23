// Screenshot a CSS-selected region of the running Electron renderer over CDP.
// Launch the app with --remote-debugging-port=9222 first, then (from desktop/):
//   node scripts/shot.mjs ".pulse-strip" out.png     (selector defaults to body, out to shot.png)
import WebSocket from 'ws'
import fs from 'node:fs'
import { ignored } from '../src/ignored.js'

const sel = process.argv[2] || 'body'
const out = process.argv[3] || 'shot.png'
const port = process.env.CDP_PORT || '9222'
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1'))
if (!page) {
  console.error('no 127.0.0.1 page target')
  process.exitCode = 1
} else {
  capture(page)
}

// Capture the selector's box over the page's debugger socket; the process ends once the socket is closed.
function capture(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const send = (method, params) => new Promise((resolve) => {
    const mid = ++id
    const onMsg = (raw) => { const m = JSON.parse(raw); if (m.id === mid) { ws.off('message', onMsg); resolve(m) } }
    ws.on('message', onMsg); ws.send(JSON.stringify({ id: mid, method, params }))
  })
  // No `scale` on the clip: a scaled capture flashes device emulation on the visible window.
  // Ctrl-C: close the socket so the pending capture never completes, and end with 130 once nothing is left.
  process.on('SIGINT', () => { process.exitCode = 130; try { ws.close() } catch (e) { ignored('shot:close', e) } })
  ws.on('open', async () => {
    try {
      await send('Page.enable', {}); await send('Runtime.enable', {})
      const box = await send('Runtime.evaluate', { expression: `(()=>{const e=document.querySelector('${sel}');if(!e)return null;const r=e.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})})()`, returnByValue: true })
      if (!box.result.result.value) { console.error('selector not found:', sel); process.exitCode = 1; return }
      const b = JSON.parse(box.result.result.value)
      const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, b.x - 8), y: Math.max(0, b.y - 8), width: b.w + 16, height: b.h + 16, scale: 1 } })
      fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
      console.log('wrote', out)
    } finally {
      ws.close()
    }
  })
}
