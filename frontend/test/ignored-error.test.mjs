import test from 'node:test'
import assert from 'node:assert/strict'
import { ignoredError } from '../src/lib/ignoredError.js'

test('a best-effort failure stays handled even when the local console throws', (t) => {
  const debug = t.mock.method(console, 'debug', () => { throw new Error('console unavailable') })
  assert.doesNotThrow(() => ignoredError('load prices'))
  assert.deepEqual(debug.mock.calls[0].arguments, ['[Arbiter]', 'load prices'])
})
