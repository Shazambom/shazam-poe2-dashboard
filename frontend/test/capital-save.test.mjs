// QA pass 1 (2026-10-03): a quantity typed just before leaving the Stash came back as the old amount. The
// save was still in flight when the page reopened (or a status poll that started before the save landed
// after it), so the page re-read stale holdings — and the next edit would have saved the stale amount.
// Holdings writes go through the store: while one is in flight `capitalSaving` is set, and a poll that
// started before a save never overwrites what the save returned.
import test from 'node:test'
import assert from 'node:assert/strict'
const { useStatus } = await import('../src/lib/statusStore.js')
const { api } = await import('../src/lib/api.js')

const deferred = () => { let res; const p = new Promise(r => { res = r }); return { p, res } }

test('a save marks holdings as saving until the server answers, then holds its answer', async () => {
  const put = deferred()
  api.putCapital = () => put.p
  const saving = useStatus.getState().saveCapital({ divine: 4 })
  assert.equal(useStatus.getState().capitalSaving, true)
  put.res({ rows: [{ currency: 'divine', qty: 4 }] })
  await saving
  assert.equal(useStatus.getState().capitalSaving, false)
  assert.deepEqual(useStatus.getState().capital.rows, [{ currency: 'divine', qty: 4 }])
})

test('a status poll that started before a save cannot overwrite the saved holdings', async () => {
  useStatus.setState({ capital: { rows: [{ currency: 'divine', qty: 2 }] } })
  const poll = deferred()
  api.status = async () => ({})
  api.capital = () => poll.p
  api.rateLimits = async () => ({})
  const refreshing = useStatus.getState().refresh()
  api.putCapital = async () => ({ rows: [{ currency: 'divine', qty: 4 }] })
  await useStatus.getState().saveCapital({ divine: 4 })
  poll.res({ rows: [{ currency: 'divine', qty: 2 }] })   // the stale read lands last
  await refreshing
  assert.deepEqual(useStatus.getState().capital.rows, [{ currency: 'divine', qty: 4 }])
})

test('a save passes on which totals the user counted', async () => {
  let sent
  api.putCapital = async (entries, counted) => { sent = { entries, counted }; return { rows: [] } }
  await useStatus.getState().saveCapital({ divine: 4, chaos: 2 }, ['divine'])
  assert.deepEqual(sent, { entries: { divine: 4, chaos: 2 }, counted: ['divine'] })
})
