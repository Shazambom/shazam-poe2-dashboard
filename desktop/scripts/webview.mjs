// Drive the app's embedded trade window like a user, over the debug port (for QA and drive checks).
// Launch the app with --remote-debugging-port=9222, then from desktop/:
//   node scripts/webview.mjs nav "https://www.pathofexile.com/trade2/search/poe2/<league>?q=…"   (= pasting a trade link)
//   node scripts/webview.mjs click <x> <y>        a left click at page coordinates
//   node scripts/webview.mjs type "<text>"        type into the focused field
//   node scripts/webview.mjs key <Enter|Tab|Escape|Backspace>
//   node scripts/webview.mjs wheel <deltaY>       scroll (positive = down)
//   node scripts/webview.mjs shot <out.png>       screenshot the trade window
//   node scripts/webview.mjs url                  the trade window's address
// nav/click/type/key take --row <data-id of YOUR throwaway row>: refused unless it is the active row (or none is).
// Guarded: only the trade <webview> target; only pathofexile.com trade2 links; only Input.* events,
// Page.navigate and Page.captureScreenshot. Never Runtime.* (scripts in the page) and never Page.reload, which on a
// webview reloads the whole app. Every search this causes counts against the site's limits: pace it like a person.
import WebSocket from 'ws'
import { writeFileSync } from 'node:fs'
import { guard } from './webview-guard.mjs'

const argv = process.argv.slice(2)
const ri = argv.indexOf('--row')
const row = ri >= 0 ? argv[ri + 1] : null
if (ri >= 0) argv.splice(ri, 2)
const [cmd, a, b] = argv
const port = process.env.CDP_PORT || '9222'
const fail = (m) => { console.error(m); process.exit(1) }
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const t = targets.find(x => x.type === 'webview' && /^https:\/\/www\.pathofexile\.com\//.test(x.url))
if (!t) fail('no trade window — open Trading → Workspace first')
if (cmd === 'url') { console.log(t.url); process.exit(0) }
// Never let a probe's search land in the owner's row (the Workspace saves searches into the active row).
const activeId = (await (await fetch(`http://127.0.0.1:8210/api/trading/workspace`)).json())?.workspace?.activeId ?? null
const refusal = guard({ cmd, row, activeId })
if (refusal) fail(refusal)

const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })
let id = 0
const ALLOWED = new Set(['Page.navigate', 'Page.captureScreenshot', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText'])
const send = (method, params = {}) => {
  if (!ALLOWED.has(method)) fail(`${method} is not allowed`)
  return new Promise(res => { const m = ++id; const h = raw => { const j = JSON.parse(raw); if (j.id === m) { ws.off('message', h); res(j) } }; ws.on('message', h); ws.send(JSON.stringify({ id: m, method, params })) })
}
const KEYS = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8 }

if (cmd === 'nav') {
  if (!/^https:\/\/www\.pathofexile\.com\/trade2\//.test(String(a))) fail('only https://www.pathofexile.com/trade2/… links')
  const r = await send('Page.navigate', { url: a })
  console.log(r.error ? `error ${r.error.message}` : 'navigated')
} else if (cmd === 'click') {
  const x = Number(a), y = Number(b)
  if (!Number.isFinite(x) || !Number.isFinite(y)) fail('click <x> <y>')
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  console.log(`clicked ${x},${y}`)
} else if (cmd === 'type') {
  await send('Input.insertText', { text: String(a ?? '') })
  console.log('typed')
} else if (cmd === 'key') {
  const code = KEYS[a]
  if (!code) fail(`key: one of ${Object.keys(KEYS).join(', ')}`)
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: a, code: a, windowsVirtualKeyCode: code })
  console.log(`pressed ${a}`)
} else if (cmd === 'wheel') {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 600, y: 500, deltaX: 0, deltaY: Number(a) || 400 })
  console.log('scrolled')
} else if (cmd === 'shot') {
  if (!a) fail('shot <out.png>')
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(a, Buffer.from(r.result.data, 'base64'))
  console.log(`saved ${a}`)
} else fail('usage: nav <url> | click <x> <y> | type <text> | key <name> | wheel <dy> | shot <out.png> | url')
ws.close()
