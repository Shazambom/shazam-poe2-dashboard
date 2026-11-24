// QA 2026-11-24: a live search the trade site rejected (HTTP 401 on the socket handshake) showed a
// generic "Error" (the socket's own error event, fired right after, overwrote the auth state) and
// stayed counted as live until the user stopped it. A rejected watch reports auth, and only auth,
// and leaves the live count.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)
const stub = (path, exports) => {
  const id = require.resolve(path)
  require.cache[id] = /** @type {NodeJS.Module} */ (/** @type {unknown} */ ({ id, filename: id, loaded: true, exports }))
}

const opened = []
class FakeSocket extends EventEmitter {
  constructor(url) { super(); this.url = url; opened.push(this) }
  terminate() { this.emit('close', 1006) }
  close() { this.emit('close', 1000) }
}
stub('ws', FakeSocket)
stub('../src/trade/proxy.js', {
  POE: 'https://www.pathofexile.com', poeRequest: async () => ({}), poeJson: () => ({}),
  cookieHeader: async () => 'POESESSID=x', userAgent: () => 'test',
})
stub('../src/trade/budget.js', { acquire: async () => {}, observe: () => {}, RateLimitError: Error })

const engine = require('../src/trade/engine.js')

test('a live search rejected with 401 reports auth only, leaves the live count and does not reconnect', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const sent = []
  engine.setSink((channel, payload) => sent.push([channel, payload]))
  assert.deepEqual(await engine.startSearch('row', 'Standard', 'abc'), { ok: true })
  assert.equal(engine.activeCount(), 1)
  const ws = opened.at(-1)
  sent.length = 0

  ws.emit('unexpected-response', {}, { statusCode: 401 })
  ws.emit('error', new Error('WebSocket was closed before the connection was established'))
  t.mock.timers.tick(120000)

  const states = sent.filter(([c]) => c === 'trade:search-state').map(([, p]) => p.state)
  assert.deepEqual(states, ['auth'])
  assert.equal(engine.activeCount(), 0)
  const last = sent.filter(([c]) => c === 'trade:engine-state').at(-1)?.[1]
  assert.deepEqual(last?.activeIds, [])
  assert.equal(opened.at(-1), ws, 'no reconnect after an auth rejection')

  // Started again (after the account is reconnected), it opens a new socket.
  assert.deepEqual(await engine.startSearch('row', 'Standard', 'abc'), { ok: true })
  assert.notEqual(opened.at(-1), ws)
  engine.stopAll()
})
