// The bundle cannot reach the network, and main.js cannot reach the bundle (only the worker can).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const ROOT = new URL('../../', import.meta.url).pathname
const bundle = readFileSync(`${ROOT}desktop/src/vendor/ee2-query/vendor/bundle.cjs`, 'utf8')

test('no sockets, no XHR, no poe.ninja; the Host proxy comes from the throwing IPC shim', () => {
  for (const bad of ['XMLHttpRequest', 'new WebSocket', 'sockette', 'poe.ninja', 'https://www.pathofexile.com/api']) assert.ok(!bundle.includes(bad), bad)
  assert.ok(bundle.includes('require("../shims/ipc.js")'), 'Host comes from the shim')
})

test('main.js never requires the vendor or the port; only the worker does; pure deps stay bundled', () => {
  const main = readFileSync(`${ROOT}desktop/src/main.js`, 'utf8')
  assert.ok(!main.includes('vendor/ee2-query') && !main.includes('ee2-history/port'))
  const worker = readFileSync(`${ROOT}desktop/src/ee2-history/worker.js`, 'utf8')
  assert.ok(worker.includes("require('./port.js')"))
  const pkg = readFileSync(`${ROOT}desktop/package.json`, 'utf8')
  assert.ok(!/"(dot-prop|luxon|neverthrow|@sindresorhus\/fnv1a|object-hash)"/.test(pkg), 'pure deps are bundled from EE2 lockfile, not runtime deps')
})
