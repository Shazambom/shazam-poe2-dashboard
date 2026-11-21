// Autosave controller concurrency, flush-in-flight, hold/release, and unmount safety.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAutosave } from '../src/lib/autosave.js'

const deferred = () => {
  let res, rej
  const p = new Promise((r, j) => { res = r; rej = j })
  return { p, res, rej }
}

test('flush waits for an already in-flight save before resolving', async () => {
  const save1 = deferred()
  let calls = 0
  const a = createAutosave(() => { calls++; return save1.p }, 5)
  a.arm()
  a.save({ divine: 100 })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(calls, 1, 'debounce timer started the save')

  let flushed = false
  const fl = a.flush().then(() => { flushed = true })
  await Promise.resolve()
  assert.equal(flushed, false, 'flush must wait while PUT is in flight')

  save1.res()
  await fl
  assert.equal(flushed, true)
})

test('concurrent saves serialize so an older write cannot overtake a newer write', async () => {
  const first = deferred()
  const order = []
  let n = 0
  const a = createAutosave(async (payload) => {
    const id = ++n
    order.push(`start:${id}:${payload.v}`)
    if (id === 1) await first.p
    order.push(`end:${id}:${payload.v}`)
  }, 5)
  a.arm()
  a.save({ v: 1 })
  await new Promise(r => setTimeout(r, 15))
  a.save({ v: 2 })
  const fl = a.flush()
  await Promise.resolve()
  assert.deepEqual(order, ['start:1:1'], 'second save waits for first to complete')
  first.res()
  await fl
  assert.deepEqual(order, ['start:1:1', 'end:1:1', 'start:2:2', 'end:2:2'])
})

test('unmount flushes an unheld pending edit synchronously and ignores later save/release', async () => {
  const saved = []
  const a = createAutosave(async (p) => { saved.push(p) }, 50)
  a.arm()
  a.save({ v: 1 })
  a.unmount()
  assert.deepEqual(saved, [{ v: 1 }], 'unmount invokes saver synchronously before returning')

  a.release()
  a.save({ v: 2 })
  await new Promise(r => setTimeout(r, 60))
  assert.deepEqual(saved, [{ v: 1 }], 'stale closures after unmount cannot schedule further writes')
})

test('unmount preserves FIFO order on a shared queue even while a prior save is in flight (C1)', async () => {
  const first = deferred()
  const queueOrder = []
  let q = Promise.resolve()
  const enqueue = (label, waitFirst = false) => {
    queueOrder.push(`enqueue:${label}`)
    const run = q.then(async () => {
      if (waitFirst) await first.p
      queueOrder.push(`commit:${label}`)
    })
    q = run
    return run
  }
  const a = createAutosave((p) => enqueue(p.label, p.waitFirst), 5)
  a.arm()
  a.save({ label: 'drag-1', waitFirst: true })
  await new Promise(r => setTimeout(r, 15))
  a.save({ label: 'drag-2', waitFirst: false })
  // Simulate RoutesView preset click: unmount slider, then immediately enqueue preset.
  a.unmount()
  const preset = enqueue('preset')
  first.res()
  await preset
  assert.deepEqual(queueOrder, [
    'enqueue:drag-1', 'enqueue:drag-2', 'enqueue:preset',
    'commit:drag-1', 'commit:drag-2', 'commit:preset',
  ])
})

test('unmount skips a held pending edit and discard clears pending before release (C2b)', async () => {
  const saved = []
  const a = createAutosave(async (p) => { saved.push(p) }, 15)
  a.arm()
  a.hold()
  a.save({ v: 'unreconciled' })
  a.unmount()
  await new Promise(r => setTimeout(r, 30))
  assert.deepEqual(saved, [], 'held unreconciled edit must not flush on unmount')

  const saved2 = []
  const b = createAutosave(async (p) => { saved2.push(p) }, 15)
  b.arm()
  b.hold()
  b.save({ v: 'stale' })
  b.discard()
  b.release()
  await new Promise(r => setTimeout(r, 30))
  assert.deepEqual(saved2, [], 'discard prevents release from sending stale pre-credit edit')
})

test('edits made while a write is in flight coalesce into one follow-up save with the latest payload (C3a)', async () => {
  const first = deferred()
  const sent = []
  const a = createAutosave(async (p) => {
    sent.push(p)
    if (sent.length === 1) await first.p
  }, 5)
  a.arm()
  a.save({ v: 1 })
  await new Promise(r => setTimeout(r, 15))
  assert.equal(sent.length, 1)
  a.save({ v: 2 })
  await new Promise(r => setTimeout(r, 15))
  a.save({ v: 3 })
  await new Promise(r => setTimeout(r, 15))
  assert.equal(sent.length, 1, 'second write waits while first is still in flight')
  first.res()
  await new Promise(r => setTimeout(r, 25))
  assert.deepEqual(sent, [{ v: 1 }, { v: 3 }], 'superseded snapshot v:2 is coalesced into v:3')
})

test('flush returns false when a pending or in-flight save rejects (C4)', async () => {
  const errs = []
  const a = createAutosave(async () => { throw new Error('disk full') }, 20, { onError: (e) => errs.push(e.message) })
  a.arm()
  a.save({ v: 1 })
  const ok = await a.flush()
  assert.equal(ok, false)
  assert.deepEqual(errs, ['disk full'])

  const b = createAutosave(async () => {}, 20)
  b.arm()
  b.save({ v: 2 })
  assert.equal(await b.flush(), true)

  // Synchronous throw inside saver must not throw ReferenceError or leave inFlight stuck.
  const syncErrs = []
  let shouldThrow = true
  const saved = []
  const c = createAutosave((p) => {
    if (shouldThrow) throw new Error('sync boom')
    saved.push(p)
    return Promise.resolve()
  }, 20, { onError: (e) => syncErrs.push(e.message) })
  c.arm()
  c.save({ v: 'bad' })
  assert.equal(await c.flush(), false)
  assert.deepEqual(syncErrs, ['sync boom'])
  shouldThrow = false
  c.save({ v: 'good' })
  assert.equal(await c.flush(), true)
  assert.deepEqual(saved, [{ v: 'good' }])
})

test('hold cancels an already scheduled debounce timer and keeps the edit pending until release', async () => {
  const saved = []
  const a = createAutosave(async (p) => { saved.push(p) }, 15)
  a.arm()
  a.save({ v: 1 })
  a.hold()
  await new Promise(r => setTimeout(r, 35))
  assert.deepEqual(saved, [], 'held timer must not fire')
  a.release()
  await new Promise(r => setTimeout(r, 35))
  assert.deepEqual(saved, [{ v: 1 }], 'release reschedules and commits the pending edit')
})

test('flush returns false when a due follow-up save throws synchronously while an earlier save is in flight', async () => {
  const first = deferred()
  const errs = []
  let calls = 0
  const a = createAutosave((p) => {
    calls++
    if (calls === 1) return first.p
    throw new Error(`sync boom on ${p.v}`)
  }, 5, { onError: (e) => errs.push(e.message) })
  a.arm()
  a.save({ v: 1 })
  await new Promise(r => setTimeout(r, 15))
  a.save({ v: 2 })
  await new Promise(r => setTimeout(r, 15)) // marks follow-up as due while first is in flight
  const fl = a.flush()
  first.res()
  assert.equal(await fl, false, 'flush must observe synchronous failure of due follow-up')
  assert.deepEqual(errs, ['sync boom on 2'])
})

test('flush observes async rejection and sync throw when unmount flushes a pending edit mid-flush', async () => {
  // Async rejection on unmount follow-up
  const first1 = deferred()
  const second1 = deferred()
  let calls1 = 0
  const a = createAutosave(() => (++calls1 === 1 ? first1.p : second1.p), 5)
  a.arm()
  a.save({ v: 1 })
  await new Promise(r => setTimeout(r, 15))
  a.save({ v: 2 })
  const fl1 = a.flush()
  a.unmount()
  assert.equal(calls1, 2, 'unmount dispatches follow-up synchronously')
  first1.res()
  second1.rej(new Error('unmount write failed'))
  assert.equal(await fl1, false, 'flush must report async rejection of unmount-dispatched save')

  // Synchronous throw on unmount follow-up
  const first2 = deferred()
  let calls2 = 0
  const b = createAutosave(() => {
    if (++calls2 === 1) return first2.p
    throw new Error('sync unmount boom')
  }, 5)
  b.arm()
  b.save({ v: 1 })
  await new Promise(r => setTimeout(r, 15))
  b.save({ v: 2 })
  const fl2 = b.flush()
  b.unmount()
  first2.res()
  assert.equal(await fl2, false, 'flush must report synchronous throw of unmount-dispatched save')
})


