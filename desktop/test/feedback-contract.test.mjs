// The feedback feature and the desktop contract: nothing under desktop/src/feedback/ can leave the
// machine — no telemetry sender, no shazam host, no fetch to anything but loopback — and the snap
// window's preload exposes no writer. The sink is a Discord invite the OS browser opens.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SRC = new URL('../src/', import.meta.url).pathname
const FB = join(SRC, 'feedback')
const fbFiles = readdirSync(FB).filter(f => f.endsWith('.js')).map(f => join(FB, f))
const read = (f) => readFileSync(f, 'utf8')

test('feedback/ never imports the telemetry sender, names the installlog endpoint or the shazam host', () => {
  for (const f of fbFiles) {
    const s = read(f)
    assert.ok(!/telemetry\.js|installLog|installlog|192\.168\./.test(s), f)
  }
})

test('feedback/ fetches nothing but 127.0.0.1 (the bundled backend) and opens only the Discord invite', () => {
  for (const f of fbFiles) {
    const s = read(f)
    for (const m of s.matchAll(/fetch\(\s*([^,)]+)/g)) assert.match(m[1], /backendUrl|127\.0\.0\.1/, `${f}: ${m[0]}`)
    for (const m of s.matchAll(/https?:\/\/[^'"`\s)]+/g)) assert.match(m[0], /^https:\/\/discord\.(gg|com)\/|^http:\/\/127\.0\.0\.1/, `${f}: ${m[0]}`)
  }
})

test('the Discord invite literal appears exactly once under desktop/src (feedback/index.js)', () => {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])
  const hits = walk(SRC).filter(f => f.endsWith('.js') && !f.includes('node_modules') && /discord\.(gg|com)\//.test(read(f)))
  assert.deepEqual(hits.map(f => f.replace(SRC, '')), ['feedback/index.js'])
})

test('preload-snap.js exposes no writer: no trade, ws, clipboard, setCookie, feedback, setChannel, installUpdate, dev, diag, notify', () => {
  const s = read(join(SRC, 'preload-snap.js')).replace(/^\s*\/\/.*$/gm, '')   // code, not comments
  for (const dead of ['trade', 'ws:', 'clipboard', 'setCookie', 'feedback', 'setChannel', 'installUpdate', 'dev:', 'diag', 'notify', 'setTheme', 'openTrade', 'connectSession', 'ipcRenderer.send'])
    assert.ok(!s.includes(dead), `preload-snap exposes ${dead}`)
  for (const live of ['getVersion', 'getChannel', 'hotkey', 'ee2']) assert.ok(s.includes(live), live)
})

test('the main preload exposes exactly the four feedback calls', () => {
  const s = read(join(SRC, 'preload.js'))
  for (const ch of ['feedback:package', 'feedback:drag', 'feedback:reveal', 'feedback:discord']) assert.ok(s.includes(`'${ch}'`), ch)
})
