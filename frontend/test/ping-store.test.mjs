// Pins the live-search state slot in pingStore + the Live button label derived from it.
// Run:  node --test frontend/test/
import test from 'node:test'
import assert from 'node:assert/strict'

const { usePings, liveLabel } = await import('../src/lib/pingStore.js')

test('setSearchState records per-search engine state', () => {
  const st = usePings.getState()
  st.setSearchState({ itemId: 'n1', state: 'auth', message: 'Reconnect your PoE session' })
  st.setSearchState({ itemId: 'n2', state: 'live' })
  assert.deepEqual(usePings.getState().searchStates.n1, { state: 'auth', message: 'Reconnect your PoE session' })
  assert.equal(usePings.getState().searchStates.n2.state, 'live')
  st.clearSearchState('n2')
  assert.equal(usePings.getState().searchStates.n2, undefined)
})

test('liveLabel reflects armed + engine state', () => {
  assert.deepEqual(liveLabel({ armed: false }, undefined), { text: 'Go live', title: '' })
  assert.deepEqual(liveLabel({ armed: true }, undefined), { text: 'Live …', title: 'Connecting' })
  assert.deepEqual(liveLabel({ armed: true }, { state: 'live' }), { text: 'Live ●', title: 'Connected' })
  assert.deepEqual(liveLabel({ armed: true }, { state: 'auth', message: 'Reconnect your PoE session' }),
    { text: 'Reconnect session', title: 'Reconnect your PoE session' })
  assert.deepEqual(liveLabel({ armed: true }, { state: 'reconnecting', message: 'closed 1006' }),
    { text: 'Reconnecting…', title: 'closed 1006' })
  assert.deepEqual(liveLabel({ armed: true }, { state: 'error', message: 'HTTP 500' }), { text: 'Error', title: 'HTTP 500' })
})
