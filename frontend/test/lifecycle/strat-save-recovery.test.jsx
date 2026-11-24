import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { api, bus } from '../../src/lib/api.js'
import { flushForQuit, flushOnHide } from '../../src/lib/quitFlush.js'
import * as sc from '../../src/lib/stratcalc.js'
import { useStratStore } from '../../src/lib/stratStore.js'
import { useWorkspace } from '../../src/lib/workspaceStore.js'
import App from '../../src/App.jsx'
import { installApiMock } from './setup.js'

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const advance = ms => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

let events = vi.fn()
let offToast = null

beforeEach(() => {
  vi.useFakeTimers()
  installApiMock()
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} })
  events = vi.fn()
  offToast = bus.on(events)
  useStratStore.getState().reset()
  useWorkspace.getState().hydrate({ version: 2, tree: [] })
})

afterEach(() => {
  offToast?.()
  cleanup()
  useStratStore.getState().reset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('re-sends a previously failed strat save on quit and reports flushed only after it lands', async () => {
  const deferred = Promise.withResolvers()
  const put = vi.spyOn(api, 'putStratCalc')
    .mockRejectedValueOnce(new Error('locked'))
    .mockReturnValueOnce(deferred.promise)

  const savedWs = window.poe2desktop.ws
  let onQuit = null
  const flushed = vi.fn()
  window.poe2desktop.ws = { ...savedWs, onFlush: vi.fn((cb) => { onQuit = cb; return () => {} }), flushed }
  try {
    useStratStore.getState().hydrate(sc.newStrat(sc.blankDoc(), { id: 's', name: 'Initial', now: 1000 }))
    render(<App />)
    await settle()

    useStratStore.getState().change(d => sc.rename(d, 's', 'Edited before fail'))
    await advance(700)
    expect(put).toHaveBeenCalledTimes(1)
    expect(put.mock.calls[0][0].strats[0].name).toBe('Edited before fail')

    // No further edit; trigger app quit before retry fires.
    let quitPromise
    act(() => { quitPromise = onQuit() })
    await settle()

    expect(put).toHaveBeenCalledTimes(2)
    expect(put.mock.calls[1][0].strats[0].name).toBe('Edited before fail')
    expect(flushed).not.toHaveBeenCalled()

    deferred.resolve({ calc: put.mock.calls[1][0] })
    await act(async () => { await quitPromise })
    expect(flushed).toHaveBeenCalledTimes(1)
  } finally {
    window.poe2desktop.ws = savedWs
  }
})

it('re-sends a previously failed strat save on page hide', async () => {
  const put = vi.spyOn(api, 'putStratCalc')
    .mockRejectedValueOnce(new Error('locked'))
    .mockImplementation(async calc => ({ calc }))

  useStratStore.getState().hydrate(sc.newStrat(sc.blankDoc(), { id: 's', name: 'Initial', now: 1000 }))
  useStratStore.getState().change(d => sc.rename(d, 's', 'Hidden edit'))
  await advance(700)
  expect(put).toHaveBeenCalledTimes(1)

  await act(async () => { await flushOnHide() })
  expect(put).toHaveBeenCalledTimes(2)
  expect(put.mock.calls[1][0].strats[0].name).toBe('Hidden edit')
})

it('retries a failed strat save on the shared bounded schedule and still recovers at quit after exhaustion', async () => {
  const put = vi.spyOn(api, 'putStratCalc')
    .mockRejectedValueOnce(new Error('locked'))
    .mockImplementationOnce(async calc => ({ calc }))

  useStratStore.getState().hydrate(sc.newStrat(sc.blankDoc(), { id: 's', name: 'Initial', now: 1000 }))
  useStratStore.getState().change(d => sc.rename(d, 's', 'Retried edit'))
  await advance(700)
  expect(put).toHaveBeenCalledTimes(1)
  expect(events.mock.calls).toEqual([[{ text: 'locked', ok: false }]])

  await advance(1000)
  expect(put).toHaveBeenCalledTimes(2)
  expect(put.mock.calls[1][0].strats[0].name).toBe('Retried edit')
  expect(events).toHaveBeenCalledTimes(1)

  // Exhaust all bounded retries, then recover on quit.
  put.mockRejectedValue(new Error('still locked'))
  useStratStore.getState().change(d => sc.rename(d, 's', 'Exhausted edit'))
  await advance(700)
  await advance(60000)
  expect(put).toHaveBeenCalledTimes(6) // 2 earlier + 1 initial + 3 bounded retries
  expect(events).toHaveBeenCalledTimes(2)

  put.mockImplementation(async calc => ({ calc }))
  const ok = await act(async () => flushForQuit())
  expect(ok).toBe(true)
  expect(put).toHaveBeenCalledTimes(7)
  expect(put.mock.calls[6][0].strats[0].name).toBe('Exhausted edit')
})
