// desktop/src/feedback/installid.js beyond the basic pin in feedback-bundle.test.mjs: a bad file is
// replaced, a good one is never rewritten, an unwritable dir still yields an id, and concurrent first
// calls create one id.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { installId } = await import('../src/feedback/installid.js')
const HEX32 = /^[0-9a-f]{32}$/

test('installId: a file that is not 32 hex is replaced by a fresh id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-iid-'))
  try {
    writeFileSync(join(dir, 'install-id'), 'not-an-id\n')
    const id = await installId(dir)
    assert.match(id, HEX32)
    assert.equal(readFileSync(join(dir, 'install-id'), 'utf8'), `${id}\n`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('installId: a good id is read back trimmed and its file is left as it is', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-iid-'))
  try {
    const id = 'ab'.repeat(16)
    writeFileSync(join(dir, 'install-id'), `  ${id}\n\n`, { mode: 0o644 })
    assert.equal(await installId(dir), id)
    assert.equal(readFileSync(join(dir, 'install-id'), 'utf8'), `  ${id}\n\n`)
    assert.equal(statSync(join(dir, 'install-id')).mode & 0o777, 0o644)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('installId: a data dir that cannot be created still yields an id (unsaved), never an error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arb-iid-'))
  try {
    writeFileSync(join(root, 'blocker'), '')   // a file where the data dir should go
    const a = await installId(join(root, 'blocker', 'data'))
    const b = await installId(join(root, 'blocker', 'data'))
    assert.match(a, HEX32)
    assert.match(b, HEX32)
    assert.notEqual(a, b, 'nothing was saved, so each call is a new reporter')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('installId: concurrent first calls share one load and write one file', async (t) => {
  const fs = await import('node:fs')
  const writes = t.mock.method(fs.promises, 'writeFile')
  const dir = mkdtempSync(join(tmpdir(), 'arb-iid-'))
  try {
    const ids = await Promise.all([installId(dir), installId(dir), installId(dir)])
    assert.match(ids[0], HEX32)
    assert.deepEqual(ids, [ids[0], ids[0], ids[0]])
    assert.equal(writes.mock.callCount(), 1)
    assert.equal(readFileSync(join(dir, 'install-id'), 'utf8'), `${ids[0]}\n`)
    assert.equal(await installId(dir), ids[0], 'a later call reads the saved id')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
