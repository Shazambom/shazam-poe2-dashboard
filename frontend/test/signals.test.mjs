// The market-signal inbox: a recurring poll owned by the store; a change in the fired set
// surfaces as `lastNew` (what App turns into a ping + OS notification + banner).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let payload = { league: 'L', signals: [], unseen: 0 }
globalThis.fetch = async (url) => ({ ok: true, json: async () => payload, text: async () => '' })
globalThis.window = undefined
const { useSignals, startSignalPolling, newSignals } = await import('../src/lib/signalStore.js')
const sig = (id, t, acked = false) => ({ item_id: id, name: `Item ${id}`, t, vol_z: 3, mp_dist: 1, close: 1, acked })

test('newSignals: un-acked keys that were not in the previous set', () => {
  assert.deepEqual(newSignals([], [sig(1, 5)]).map(s => s.item_id), [1])
  assert.deepEqual(newSignals([sig(1, 5)], [sig(1, 5), sig(2, 6)]).map(s => s.item_id), [2])
  assert.deepEqual(newSignals([sig(1, 5)], [sig(1, 5)]), [])
  assert.deepEqual(newSignals([], [sig(1, 5, true)]), [])          // already dismissed → no ping
  assert.deepEqual(newSignals([sig(1, 5)], [sig(1, 9)]).map(s => s.t), [9])   // same item, new spike day
})

test('first load establishes state without a ping; later changes set lastNew', async () => {
  payload = { league: 'L', signals: [sig(1, 5)], unseen: 1 }
  await useSignals.getState().refresh()
  assert.equal(useSignals.getState().lastNew, null)
  assert.equal(useSignals.getState().signals.length, 1)
  payload = { league: 'L', signals: [sig(1, 5), sig(2, 6)], unseen: 2 }
  await useSignals.getState().refresh()
  assert.deepEqual(useSignals.getState().lastNew.signals.map(s => s.item_id), [2])
  const stamp = useSignals.getState().lastNew.at
  await useSignals.getState().refresh()                              // unchanged → lastNew untouched
  assert.equal(useSignals.getState().lastNew.at, stamp)
})

test('the store owns the recurring poll', () => {
  assert.equal(typeof startSignalPolling, 'function')
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  assert.ok(!app.includes('setInterval(refresh, 60000)'))
  assert.ok(app.includes('startSignalPolling(') && app.includes('lastNew'))
})

test('OS notifications have one home', () => {
  const walk = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8')
  assert.ok(walk('lib/notify.js').includes('export function osNotify('))
  assert.ok(!walk('lib/liveWiring.js').includes('new Notification('))
})
