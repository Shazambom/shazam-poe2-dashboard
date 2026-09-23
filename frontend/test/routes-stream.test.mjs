// The routes page must show the same loops whether the server streamed a fresh search or
// replayed a cached one. Owner (2026-09-23, 0.3.4-beta.2): "a bunch of results and then the
// number narrows after a while." A fresh stream delivers every loop that passed the filters
// (316 on the owner's machine), the cached replay two minutes later only the scored top 100;
// the page banded each population on its own mean and σ and showed 82 rows, then 20.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finishRoutes } from '../src/lib/routesStream.js'

const loop = (id, score) => ({ id, score })

test('a finished stream keeps the authoritative top list, in its order, with its scores', () => {
  const streamed = [loop('a', 0.1), loop('b'), loop('c', 0.9), loop('d'), loop('e', 0.5)]   // b, d never scored
  const done = { order: ['c', 'e', 'a'], scores: { c: 0.95, e: 0.55, a: 0.15 } }
  const out = finishRoutes(streamed, done)
  assert.deepEqual(out.map(r => r.id), ['c', 'e', 'a'])
  assert.deepEqual(out.map(r => r.score), [0.95, 0.55, 0.15])
})

test('a cached replay (already the top list) comes through unchanged', () => {
  const replay = [loop('c', 0.95), loop('e', 0.55), loop('a', 0.15)]
  const done = { order: ['c', 'e', 'a'], scores: { c: 0.95, e: 0.55, a: 0.15 }, cached: true }
  assert.deepEqual(finishRoutes(replay, done), replay)
})

test('a done without an order keeps what streamed (older servers), scores applied', () => {
  const streamed = [loop('a', 0.1), loop('b', 0.2)]
  assert.deepEqual(finishRoutes(streamed, { scores: { b: 0.7 } }).map(r => r.score), [0.1, 0.7])
})

test('the page uses it on done', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/components/RoutesView.jsx', import.meta.url), 'utf8')
  assert.match(src, /finishRoutes\(accRef\.current, d\)/, 'RoutesView does not reduce the stream to the authoritative list on done')
})
