// desktop/src/ui-files.js: the file the local UI server sends for a request path, and how it is sent.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { staticFile, serveStatic } = require('../src/ui-files.js')

const FS = fs.promises

test('a request path maps to its file in dist; /, a directory, a missing file and an escape get index.html', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'arb-ui-'))
  try {
    mkdirSync(join(dist, 'assets'))
    writeFileSync(join(dist, 'index.html'), '<!doctype html>')
    writeFileSync(join(dist, 'assets', 'app.js'), '')
    const index = join(dist, 'index.html')
    assert.equal(await staticFile(FS, dist, '/'), index)
    assert.equal(await staticFile(FS, dist, '/assets/app.js'), join(dist, 'assets', 'app.js'))
    assert.equal(await staticFile(FS, dist, '/assets'), index, 'a directory')
    assert.equal(await staticFile(FS, dist, '/board'), index, 'a client-side route')
    assert.equal(await staticFile(FS, dist, '/assets/missing.js'), index)
    assert.equal(await staticFile(FS, join(dist, 'assets'), '/../index.html'), join(dist, 'assets', 'index.html'), 'outside dist')
  } finally { rmSync(dist, { recursive: true, force: true }) }
})

// One request against a real server running serveStatic over `fsm`; resolves with the answer (or the socket error).
async function request(fsm, dist, pathname) {
  const errors = []
  const server = http.createServer((req, res) => { serveStatic(fsm, dist, new URL(req.url, 'http://x').pathname, res, (e) => errors.push(e)) })
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => { resolve(undefined) }) })
  try {
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port
    try {
      const r = await fetch(`http://127.0.0.1:${port}${pathname}`)
      return { status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), body: await r.text(), errors }
    } catch (e) { return { failed: e, errors } }
  } finally { server.close() }
}

test('a file of the bundle is sent with its type; /assets/ files are cached for good', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'arb-ui-'))
  try {
    mkdirSync(join(dist, 'assets'))
    writeFileSync(join(dist, 'index.html'), '<!doctype html>')
    writeFileSync(join(dist, 'assets', 'app.js'), 'go()')
    const page = await request(fs, dist, '/board')
    assert.deepEqual([page.status, page.type, page.cache, page.body], [200, 'text/html', null, '<!doctype html>'])
    const js = await request(fs, dist, '/assets/app.js')
    assert.deepEqual([js.status, js.type, js.cache, js.body], [200, 'text/javascript', 'public, max-age=31536000, immutable', 'go()'])
    assert.deepEqual([...page.errors, ...js.errors], [])
  } finally { rmSync(dist, { recursive: true, force: true }) }
})

// The packaged build that pointed the UI server at a missing directory threw an uncaught ENOENT in main per
// request. A file that is gone by the time it is read (here: deleted right after the lookup found it) is a
// 404 with the error logged once, never a 200 with a broken body or an exception.
test('a file that vanishes between lookup and read: 404, logged once, nothing thrown', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'arb-ui-'))
  try {
    writeFileSync(join(dist, 'index.html'), '<!doctype html>')
    const vanishing = { ...fs, promises: { stat: async (p) => { const st = await FS.stat(p); rmSync(p); return st } } }
    const r = await request(vanishing, dist, '/')
    assert.equal(r.status, 404)
    assert.equal(r.errors.length, 1)
    assert.equal(r.errors[0].code, 'ENOENT')
  } finally { rmSync(dist, { recursive: true, force: true }) }
})

test('a file that cannot be opened for another reason: 500, logged once', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'arb-ui-'))
  try {
    writeFileSync(join(dist, 'index.html'), '<!doctype html>')
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const locked = { ...fs, createReadStream: () => { const s = new PassThrough(); process.nextTick(() => s.emit('error', eacces)); return s } }
    const r = await request(locked, dist, '/')
    assert.equal(r.status, 500)
    assert.deepEqual(r.errors, [eacces])
  } finally { rmSync(dist, { recursive: true, force: true }) }
})
