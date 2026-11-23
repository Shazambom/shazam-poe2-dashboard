// The type declaration beside the generated EE2 bundle is the one sync-ee2.mjs writes, byte for byte,
// so a hand edit of either copy is caught (the drift test pins the vendored copy to the manifest).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BUNDLE_TYPES } from '../scripts/ee2-bundle-types.mjs'

test('vendor/bundle.d.cts is what scripts/sync-ee2.mjs writes', () => {
  const vendored = readFileSync(new URL('../src/vendor/ee2-query/vendor/bundle.d.cts', import.meta.url), 'utf8')
  assert.equal(vendored, BUNDLE_TYPES, 'regenerate with `node scripts/sync-ee2.mjs --types-only`, never hand-edit')
})
