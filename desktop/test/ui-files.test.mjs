// desktop/src/ui-files.js: the file the local UI server sends for a request path.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { staticFile } = require('../src/ui-files.js')

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
