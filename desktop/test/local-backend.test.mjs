// desktop/src/local-backend.js: the one fetch the desktop runtime uses for its own backend. CLAUDE.md's desktop
// contract: every /api call goes to the bundled backend on 127.0.0.1; the only other origin is the dev backend
// main.js registers in an unpackaged run without a bundled binary.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { backendFetch, allowDevBackend } = require('../src/local-backend.js')

function stubFetch() {
  const calls = []
  const orig = globalThis.fetch
  globalThis.fetch = /** @type {any} a fetch double */ (async (url, init) => { calls.push({ url, init }); return { ok: true } })
  return { calls, restore: () => { globalThis.fetch = orig } }
}

test('a loopback backend URL is fetched as given, with the caller\'s options untouched', async () => {
  const f = stubFetch()
  try {
    const init = { method: 'POST', body: '{}', signal: AbortSignal.timeout(1000) }
    const r = await backendFetch('http://127.0.0.1:8210/api/ratelimits/acquire', init)
    assert.deepEqual(r, { ok: true })
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].url, 'http://127.0.0.1:8210/api/ratelimits/acquire')
    assert.equal(f.calls[0].init, init)
  } finally { f.restore() }
})

test('anything else is refused before any request: other hosts, https, malformed', async () => {
  const f = stubFetch()
  try {
    for (const url of ['http://192.168.1.250:8000/api/status', 'https://127.0.0.1:8210/api/x', 'http://localhost:8210/api/x', 'http://127.0.0.1.evil.com/api', 'not a url', '']) {
      await assert.rejects(backendFetch(url, {}), /local backend/, url)
    }
    assert.equal(f.calls.length, 0)
  } finally { f.restore() }
})

test('the dev backend main.js registers (unpackaged runs only) is the one other origin allowed', async () => {
  const f = stubFetch()
  try {
    await assert.rejects(backendFetch('http://dev.example:8000/api/status', {}), /local backend/)
    allowDevBackend('http://dev.example:8000')
    await backendFetch('http://dev.example:8000/api/status', {})
    await assert.rejects(backendFetch('http://other.example:8000/api/status', {}), /local backend/)
    assert.deepEqual(f.calls.map(c => c.url), ['http://dev.example:8000/api/status'])
  } finally { f.restore() }
})
