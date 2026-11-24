// Tests for writeManifest idempotency in desktop/scripts/sync-ee2.mjs:
// a no-op sync must keep the existing syncedAt so MANIFEST.json stays byte-identical
// (preventing publish-github.sh from staging a timestamp-only diff and re-running the test gate),
// while any real change to tag, commit, modules, or vendored files still updates syncedAt.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeManifest } from '../scripts/sync-ee2.mjs'

function makeVendorTree() {
  const dir = mkdtempSync(join(tmpdir(), 'sync-ee2-manifest-'))
  mkdirSync(join(dir, 'vendor'), { recursive: true })
  mkdirSync(join(dir, 'data', 'en'), { recursive: true })
  writeFileSync(join(dir, 'vendor', 'bundle.cjs'), '// bundle v1\n')
  writeFileSync(join(dir, 'data', 'en', 'items.ndjson'), '{"a":1}\n')
  return dir
}

test('writeManifest keeps existing syncedAt when tag, commit, modules, and files are unchanged', () => {
  const vendorDir = makeVendorTree()
  try {
    const meta = { ee2Tag: 'v0.16.3', ee2Commit: '68478104b235', modules: ['src/parser/index.ts'] }
    const manifestPath = join(vendorDir, 'data', 'MANIFEST.json')

    writeManifest(meta, '2026-11-23T07:00:00.000Z', vendorDir)
    const first = readFileSync(manifestPath, 'utf8')

    writeManifest(meta, '2026-11-23T08:30:00.000Z', vendorDir)
    const second = readFileSync(manifestPath, 'utf8')

    assert.equal(second, first, 'unchanged inputs must leave MANIFEST.json byte-identical')
    assert.equal(JSON.parse(second).syncedAt, '2026-11-23T07:00:00.000Z')
  } finally {
    rmSync(vendorDir, { recursive: true, force: true })
  }
})

test('writeManifest updates syncedAt when files, tag, commit, or modules change', () => {
  const vendorDir = makeVendorTree()
  try {
    const base = { ee2Tag: 'v0.16.3', ee2Commit: '68478104b235', modules: ['src/parser/index.ts'] }
    const manifestPath = join(vendorDir, 'data', 'MANIFEST.json')

    writeManifest(base, '2026-11-23T07:00:00.000Z', vendorDir)

    writeFileSync(join(vendorDir, 'vendor', 'bundle.cjs'), '// bundle v2\n')
    writeManifest(base, '2026-11-23T08:00:00.000Z', vendorDir)
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).syncedAt, '2026-11-23T08:00:00.000Z')

    writeManifest({ ...base, ee2Tag: 'v0.16.4' }, '2026-11-23T09:00:00.000Z', vendorDir)
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).syncedAt, '2026-11-23T09:00:00.000Z')

    writeManifest({ ...base, ee2Tag: 'v0.16.4', ee2Commit: 'abcdef123456' }, '2026-11-23T10:00:00.000Z', vendorDir)
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).syncedAt, '2026-11-23T10:00:00.000Z')

    writeManifest(
      { ...base, ee2Tag: 'v0.16.4', ee2Commit: 'abcdef123456', modules: ['src/parser/index.ts', 'src/parser/meta.ts'] },
      '2026-11-23T11:00:00.000Z',
      vendorDir,
    )
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).syncedAt, '2026-11-23T11:00:00.000Z')
  } finally {
    rmSync(vendorDir, { recursive: true, force: true })
  }
})
