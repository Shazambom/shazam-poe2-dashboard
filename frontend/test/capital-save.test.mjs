// QA pass 1 (2026-10-03): a quantity typed just before leaving the Stash came back as the old amount. The
// save was still in flight when the page reopened (or a status poll that started before the save landed
// after it), so the page re-read stale holdings — and the next edit would have saved the stale amount.
// Holdings writes go through the store: while one is in flight `capitalSaving` is set, and a poll that
// started before a save never overwrites what the save returned.
import test from 'node:test'
import assert from 'node:assert/strict'
const { useStatus, capitalDirty } = await import('../src/lib/statusStore.js')
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

test('waitCapital waits for an in-flight save and overlapping saves keep capitalSaving true until both land', async () => {
  const first = deferred()
  const second = deferred()
  const order = []
  let call = 0
  api.putCapital = async (entries) => {
    const id = ++call
    order.push(`start:${id}:${entries.divine}`)
    await (id === 1 ? first.p : second.p)
    order.push(`end:${id}:${entries.divine}`)
    return { rows: [{ currency: 'divine', qty: entries.divine }] }
  }
  const s1 = useStatus.getState().saveCapital({ divine: 10 }, ['divine'])
  const s2 = useStatus.getState().saveCapital({ divine: 20 }, ['divine'])
  let waited = false
  const w = useStatus.getState().waitCapital().then(() => { waited = true })

  first.res()
  await s1
  assert.equal(useStatus.getState().capitalSaving, true, 'second save is still in flight')
  assert.equal(waited, false, 'waitCapital waits for queued saves too')

  second.res()
  await Promise.all([s2, w])
  assert.equal(useStatus.getState().capitalSaving, false)
  assert.equal(waited, true)
  assert.deepEqual(order, ['start:1:10', 'end:1:10', 'start:2:20', 'end:2:20'])
  assert.deepEqual(useStatus.getState().capital.rows, [{ currency: 'divine', qty: 20 }])
})

test('waitCapital returns false when a prior save rejected and resets once reported', async () => {
  api.putCapital = async () => { throw new Error('write failed') }
  const failed = useStatus.getState().saveCapital({ divine: 50 }, ['divine'])
  await assert.rejects(failed, /write failed/)
  assert.equal(await useStatus.getState().waitCapital(), false, 'reports prior mount save failure')
  assert.equal(await useStatus.getState().waitCapital(), true, 'does not permanently lock out later retries')
})

test('capitalStale ignores a stale pre-credit poll and clears only when a fresh refresh lands', async () => {
  useStatus.setState({ capital: { rows: [{ currency: 'divine', qty: 100 }] }, capitalStale: false })
  const oldPoll = deferred()
  api.status = async () => ({})
  api.capital = () => oldPoll.p
  api.rateLimits = async () => ({})
  const staleRefresh = useStatus.getState().refresh()

  // Simulate confirmed credit + failed api.capital(): bump capitalWrites and mark capitalStale.
  useStatus.setState(st => ({ capitalStale: true, capitalWrites: st.capitalWrites + 1 }))
  oldPoll.res({ rows: [{ currency: 'divine', qty: 100 }] })
  await staleRefresh
  assert.equal(useStatus.getState().capitalStale, true, 'pre-credit poll must not clear capitalStale')

  api.capital = async () => ({ rows: [{ currency: 'divine', qty: 125 }] })
  await useStatus.getState().refresh()
  assert.equal(useStatus.getState().capitalStale, false)
  assert.deepEqual(useStatus.getState().capital.rows, [{ currency: 'divine', qty: 125 }])
})

test('saveCapital carries failed recount cutoffs into the next queued PUT only on rejection, never on success', async () => {
  // Drain any leftover failedCounted from prior test with one succeeding PUT.
  api.putCapital = async () => ({ rows: [] })
  await useStatus.getState().saveCapital({}, [])

  // Case 1: PUT A (recount divine) succeeds, overlapping PUT B (add chaos) must NOT repeat 'divine'.
  const first = deferred()
  const sent1 = []
  api.putCapital = async (entries, counted) => {
    sent1.push({ entries, counted: [...counted] })
    if (sent1.length === 1) await first.p
    return { rows: [] }
  }
  const a1 = useStatus.getState().saveCapital({ divine: 125 }, ['divine'])
  const b1 = useStatus.getState().saveCapital({ divine: 125, chaos: 5 }, [])
  first.res()
  await Promise.all([a1, b1])
  assert.deepEqual(sent1.map(s => s.counted), [['divine'], []])

  // Case 2: PUT A (recount divine) rejects, overlapping PUT B (add +5 divine) MUST inherit 'divine'.
  const sent2 = []
  let call = 0
  api.putCapital = async (entries, counted) => {
    call++
    sent2.push({ entries, counted: [...counted] })
    if (call === 1) throw new Error('transient error')
    return { rows: [{ currency: 'divine', qty: entries.divine }] }
  }
  const a2 = useStatus.getState().saveCapital({ divine: 125 }, ['divine'])
  const b2 = useStatus.getState().saveCapital({ divine: 130 }, [])
  await assert.rejects(a2, /transient error/)
  await b2
  assert.deepEqual(sent2.map(s => s.counted), [['divine'], ['divine']])
})

test('a rejected PUT superseded by a newer queued PUT does not replay stale deltas when the newer PUT succeeds', async () => {
  capitalDirty.clear()
  let call = 0
  api.putCapital = async (entries) => {
    call++
    if (call === 1) throw new Error('first put failed')
    return { rows: Object.entries(entries).map(([currency, qty]) => ({ currency, qty })) }
  }
  const edits1 = new Map([['divine', { kind: 'add', delta: 10 }]])
  const edits2 = new Map([['chaos', { kind: 'add', delta: 5 }]])
  const p1 = useStatus.getState().saveCapital({ divine: 110 }, [], edits1)
  const p2 = useStatus.getState().saveCapital({ divine: 110, chaos: 5 }, [], edits2)
  await assert.rejects(p1, /first put failed/)
  await p2
  assert.equal(capitalDirty.size, 0, 'PUT 2 persisted both divine=110 and chaos=5; no delta may replay into capitalDirty')
})

test('when both overlapping PUTs reject, the queue tail restores both sets of edits into capitalDirty in order', async () => {
  capitalDirty.clear()
  api.putCapital = async () => { throw new Error('offline') }
  const edits1 = new Map([['divine', { kind: 'count', value: '125' }]])
  const edits2 = new Map([['divine', { kind: 'add', delta: 5 }], ['chaos', { kind: 'add', delta: 3 }]])
  const p1 = useStatus.getState().saveCapital({ divine: 125 }, ['divine'], edits1)
  const p2 = useStatus.getState().saveCapital({ divine: 130, chaos: 3 }, [], edits2)
  await assert.rejects(p1, /offline/)
  await assert.rejects(p2, /offline/)
  assert.deepEqual([...capitalDirty.entries()], [
    ['divine', { kind: 'count', value: '130' }],
    ['chaos', { kind: 'add', delta: 3 }],
  ])
  // Clean up store state for any subsequent tests.
  capitalDirty.clear()
  api.putCapital = async () => ({ rows: [] })
  await useStatus.getState().saveCapital({}, [])
})

test('when a lone tail PUT rejects while a newer edit sits in capitalDirty, failed edits restore underneath it', async () => {
  capitalDirty.clear()
  const first = deferred()
  api.putCapital = async () => { await first.p; throw new Error('timeout') }
  const edits1 = new Map([['divine', { kind: 'count', value: '125' }]])
  const p1 = useStatus.getState().saveCapital({ divine: 125 }, ['divine'], edits1)
  capitalDirty.set('divine', { kind: 'add', delta: 5 })
  first.res()
  await assert.rejects(p1, /timeout/)
  assert.deepEqual([...capitalDirty.entries()], [['divine', { kind: 'count', value: '130' }]])
  capitalDirty.clear()
  api.putCapital = async () => ({ rows: [] })
  await useStatus.getState().saveCapital({}, [])
})



