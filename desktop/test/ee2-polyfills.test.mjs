// The guarded ES2023+ polyfills the EE2 port installs (desktop/src/vendor/ee2-query/polyfills.js) agree with
// the built-ins they stand in for. Node already has every built-in, so the file runs in a fresh context
// whose built-ins are removed first; each polyfill's result is compared with the host's native result.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SRC = readFileSync(new URL('../src/vendor/ee2-query/polyfills.js', import.meta.url), 'utf8')
const ARRAY = ['toSorted', 'toReversed', 'toSpliced', 'with', 'findLast', 'findLastIndex']
const SET = ['intersection', 'union', 'difference', 'symmetricDifference', 'isSubsetOf', 'isSupersetOf', 'isDisjointFrom']

function polyfilled() {
  const ctx = vm.createContext({})
  vm.runInContext(`
    for (const n of ${JSON.stringify(ARRAY)}) delete Array.prototype[n]
    for (const n of ${JSON.stringify(SET)}) delete Set.prototype[n]
    delete Object.groupBy; delete Map.groupBy
  `, ctx)
  vm.runInContext(SRC, ctx)
  return ctx
}
// Maps and Sets from the other context fail instanceof, so they are recognised by their tag.
const tag = (x) => Object.prototype.toString.call(x)
const plain = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (tag(x) === '[object Map]' ? [...x] : tag(x) === '[object Set]' ? [...x].sort() : x === undefined ? '<undefined>' : x)))

test('every polyfill is installed where the built-in is missing', () => {
  const ctx = polyfilled()
  for (const n of ARRAY) assert.equal(vm.runInContext(`typeof Array.prototype.${n}`, ctx), 'function', n)
  for (const n of SET) assert.equal(vm.runInContext(`typeof Set.prototype.${n}`, ctx), 'function', n)
  assert.equal(vm.runInContext('typeof Object.groupBy + typeof Map.groupBy', ctx), 'functionfunction')
})

test('array polyfills match the built-ins', () => {
  const ctx = polyfilled()
  const a = [3, 1, 2, 5, 4], cmp = (x, y) => x - y
  const run = (expr) => plain(vm.runInContext(`(() => { const a = ${JSON.stringify(a)}, cmp = (x, y) => x - y; return ${expr} })()`, ctx))
  assert.deepEqual(run('a.toSorted(cmp)'), a.toSorted(cmp))
  assert.deepEqual(run('a.toSorted()'), a.toSorted())
  assert.deepEqual(run('a.toReversed()'), a.toReversed())
  assert.deepEqual(run('a.toSpliced(1, 2, 9)'), a.toSpliced(1, 2, 9))
  assert.deepEqual(run('a.with(1, 7)'), a.with(1, 7))
  assert.deepEqual(run('a.with(-1, 7)'), a.with(-1, 7))
  assert.deepEqual(run('[a.findLast(x => x > 2), a.findLast(x => x > 9)]'), plain([a.findLast(x => x > 2), a.findLast(x => x > 9)]))
  assert.deepEqual(run('[a.findLastIndex(x => x < 3), a.findLastIndex(x => x > 9)]'), [a.findLastIndex(x => x < 3), a.findLastIndex(x => x > 9)])
  assert.deepEqual(run('a'), a, 'the copying methods leave the array alone')
})

test('set polyfills match the built-ins', () => {
  const ctx = polyfilled()
  const A = ['a', 'b', 'c'], B = ['b', 'c', 'd'], C = ['b']
  const run = (expr) => plain(vm.runInContext(`(() => { const A = new Set(${JSON.stringify(A)}), B = new Set(${JSON.stringify(B)}), C = new Set(${JSON.stringify(C)}); return ${expr} })()`, ctx))
  const [sA, sB, sC] = [new Set(A), new Set(B), new Set(C)]
  for (const m of ['intersection', 'union', 'difference', 'symmetricDifference']) assert.deepEqual(run(`A.${m}(B)`), plain(sA[m](sB)), m)
  for (const m of ['isSubsetOf', 'isSupersetOf', 'isDisjointFrom']) {
    assert.deepEqual(run(`[A.${m}(B), C.${m}(A), A.${m}(C), A.${m}(new Set(['z']))]`), [sA[m](sB), sC[m](sA), sA[m](sC), sA[m](new Set(['z']))], m)
  }
})

test('groupBy polyfills match the built-ins, keys in first-seen order', () => {
  const ctx = polyfilled()
  const items = ['apple', 'avocado', 'banana', 'cherry', 'blueberry', 'apricot']
  const key = (s, i) => (i === 4 ? 'x' : s[0])
  const run = (expr) => plain(vm.runInContext(`(() => { const items = ${JSON.stringify(items)}, key = (s, i) => (i === 4 ? 'x' : s[0]); return ${expr} })()`, ctx))
  assert.deepEqual(run('Object.groupBy(items, key)'), plain({ ...Object.groupBy(items, key) }))
  assert.deepEqual(run('Object.keys(Object.groupBy(items, key))'), Object.keys(Object.groupBy(items, key)))
  assert.equal(vm.runInContext('Object.getPrototypeOf(Object.groupBy([], (x) => x))', ctx), null)
  assert.deepEqual(run('Map.groupBy(items, key)'), plain(Map.groupBy(items, key)))
})
