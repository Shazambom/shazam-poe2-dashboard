// desktop/src/export-file.js: "Export searches" writes the renderer's text into Downloads and returns
// the path. Pins the file name, the content, the error and the order of two exports.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { makeExporter } = require('../src/export-file.js')

const FS = fs.promises

test('writes the text into Downloads under a safe name and returns the path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-export-'))
  try {
    const exportFile = makeExporter({ fsp: FS, downloads: () => dir })
    assert.equal(await exportFile({ name: 'my searches/v2?.json', text: '{"a":1}' }), join(dir, 'my_searches_v2_.json'))
    assert.equal(readFileSync(join(dir, 'my_searches_v2_.json'), 'utf8'), '{"a":1}')
    assert.equal(await exportFile({}), join(dir, 'arbiter-searches.json'))
    assert.equal(readFileSync(join(dir, 'arbiter-searches.json'), 'utf8'), '')
    assert.equal(await exportFile(null), join(dir, 'arbiter-searches.json'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a write that fails reaches the caller as that error', async () => {
  const exportFile = makeExporter({ fsp: FS, downloads: () => join(tmpdir(), 'arb-export-missing-dir', 'nope') })
  await assert.rejects(async () => exportFile({ name: 'x.json', text: 'x' }), { code: 'ENOENT' })
})

test('two exports at once are written one after the other, in arrival order', async () => {
  const log = []
  const files = new Map()
  const fsp = {
    async writeFile(f, d) {
      log.push(`> ${d}`)
      await new Promise(resolve => { setTimeout(resolve, d === 'first' ? 20 : 1) })   // the first is the slow one
      files.set(f, d)
      log.push(`< ${d}`)
    },
  }
  const exportFile = makeExporter({ fsp, downloads: () => '/dl' })
  const [a, b] = await Promise.all([exportFile({ name: 's.json', text: 'first' }), exportFile({ name: 's.json', text: 'second' })])
  assert.equal(a, join('/dl', 's.json'))
  assert.equal(b, a)
  assert.deepEqual(log, ['> first', '< first', '> second', '< second'])
  assert.equal(files.get(a), 'second', 'the later export wins, as with the synchronous write')
})

test('a failed export does not stop the next one', async () => {
  let n = 0
  const fsp = { async writeFile() { n += 1; if (n === 1) throw new Error('disk full') } }
  const exportFile = makeExporter({ fsp, downloads: () => '/dl' })
  const first = exportFile({ name: 'a.json', text: 'x' })
  const second = exportFile({ name: 'b.json', text: 'y' })
  await assert.rejects(first, /disk full/)
  assert.equal(await second, join('/dl', 'b.json'))
})
