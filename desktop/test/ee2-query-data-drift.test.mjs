// Every vendored/data file's sha256 matches data/MANIFEST.json — a hand edit to generated code is caught.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
const V = new URL('../src/vendor/ee2-query/', import.meta.url).pathname
const manifest = JSON.parse(readFileSync(join(V, 'data', 'MANIFEST.json'), 'utf8'))

test('manifest names the EE2 tag and every vendored file hashes as recorded', () => {
  assert.ok(manifest.ee2Tag && manifest.syncedAt && Array.isArray(manifest.modules) && manifest.modules.length > 20)
  const walk = (d, out = []) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); e.isDirectory() ? walk(p, out) : out.push(p) } return out }
  const files = [...walk(join(V, 'vendor')), ...walk(join(V, 'data'))].filter(f => !f.endsWith('MANIFEST.json'))
  assert.equal(files.length, Object.keys(manifest.files).length, 'file set matches the manifest')
  for (const f of files) {
    const rel = relative(V, f).split('/').join('/')
    const rec = manifest.files[rel]
    assert.ok(rec, `${rel} in manifest`)
    assert.equal(statSync(f).size, rec.bytes, `${rel} size`)
    assert.equal(createHash('sha256').update(readFileSync(f)).digest('hex'), rec.sha256, `${rel} hash — regenerate with scripts/sync-ee2.mjs, never hand-edit`)
  }
})

test('vendored data is checked out byte-exact everywhere (no CRLF conversion — the index bins are byte offsets)', () => {
  const ga = readFileSync(join(V, '..', '..', '..', '..', '.gitattributes'), 'utf8')
  assert.match(ga, /desktop\/src\/vendor\/ee2-query\/data\/\*\* [^\n]*-text/)
  assert.match(ga, /desktop\/src\/vendor\/ee2-query\/vendor\/\*\* [^\n]*-text/)
  for (const f of ['en/items.ndjson', 'en/stats.ndjson']) assert.ok(!readFileSync(join(V, 'data', f)).includes(13), `${f} has a CR byte`)
})
