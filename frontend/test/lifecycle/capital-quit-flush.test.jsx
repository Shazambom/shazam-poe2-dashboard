import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import StashView from '../../src/components/StashView.jsx'
import { api } from '../../src/lib/api.js'
import { flushForQuit } from '../../src/lib/quitFlush.js'
import { capitalDirty, useStatus } from '../../src/lib/statusStore.js'
import { installApiMock } from './setup.js'

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const advance = ms => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

const makeCapital = (entries) => ({
  reference: 'exalted',
  rows: Object.entries(entries).map(([currency, qty]) => ({ currency, qty, value_ref: qty })),
})

beforeEach(async () => {
  vi.useFakeTimers()
  installApiMock()
  capitalDirty.clear()
  useStatus.setState({ capitalSaving: false, capitalStale: false, salesFetching: false })
  await useStatus.getState().refresh()
})

afterEach(() => {
  cleanup()
  capitalDirty.clear()
  useStatus.setState({ capitalSaving: false, capitalStale: false, salesFetching: false })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('mounted StashView with edit inside debounce and idle queue sends one PUT on quit', async () => {
  const put = vi.spyOn(api, 'putCapital').mockImplementation(async entries => makeCapital(entries))
  render(<StashView />)
  await settle()

  fireEvent.change(screen.getByLabelText('Divine Orb held'), { target: { value: '25' } })
  await advance(200)
  expect(put).not.toHaveBeenCalled()

  const ok = await act(async () => flushForQuit())
  expect(ok).toBe(true)
  expect(put.mock.calls).toEqual([[{ divine: 25, exalted: 500 }, ['divine']]])
})

it('unmounted idle StashView sends zero PUTs on quit', async () => {
  const put = vi.spyOn(api, 'putCapital').mockImplementation(async entries => makeCapital(entries))
  const view = render(<StashView />)
  await settle()
  view.unmount()
  await settle()

  const ok = await act(async () => flushForQuit())
  expect(ok).toBe(true)
  expect(put).not.toHaveBeenCalled()
})

it('unmount PUT already in flight sends no duplicate PUT and quit waits for it', async () => {
  const deferred = Promise.withResolvers()
  const put = vi.spyOn(api, 'putCapital').mockReturnValueOnce(deferred.promise)
  const view = render(<StashView />)
  await settle()

  fireEvent.change(screen.getByLabelText('Divine Orb held'), { target: { value: '25' } })
  view.unmount()
  await settle()
  expect(put.mock.calls).toEqual([[{ divine: 25, exalted: 500 }, ['divine']]])

  let done = false
  const quitting = flushForQuit().then(ok => { done = ok; return ok })
  await settle()
  expect(put).toHaveBeenCalledTimes(1)
  expect(done).toBe(false)

  deferred.resolve(makeCapital({ divine: 25, exalted: 500 }))
  expect(await act(async () => quitting)).toBe(true)
  expect(put).toHaveBeenCalledTimes(1)
})

it('save in flight with second edit pending flushes the second edit once after the first lands', async () => {
  const first = Promise.withResolvers()
  const second = Promise.withResolvers()
  const put = vi.spyOn(api, 'putCapital')
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)

  render(<StashView />)
  await settle()

  fireEvent.change(screen.getByLabelText('Divine Orb held'), { target: { value: '25' } })
  await advance(700)
  expect(put.mock.calls).toEqual([[{ divine: 25, exalted: 500 }, ['divine']]])

  fireEvent.change(screen.getByLabelText('Exalted Orb held'), { target: { value: '600' } })
  await advance(100)
  expect(put).toHaveBeenCalledTimes(1)

  let done = false
  const quitting = flushForQuit().then(ok => { done = ok; return ok })
  await settle()
  expect(put).toHaveBeenCalledTimes(1)
  expect(done).toBe(false)

  first.resolve(makeCapital({ divine: 25, exalted: 500 }))
  await settle()
  expect(put.mock.calls).toEqual([
    [{ divine: 25, exalted: 500 }, ['divine']],
    [{ divine: 25, exalted: 600 }, ['exalted']],
  ])
  expect(done).toBe(false)

  second.resolve(makeCapital({ divine: 25, exalted: 600 }))
  expect(await act(async () => quitting)).toBe(true)
  expect(put).toHaveBeenCalledTimes(2)
})

it('previously failed saves with failedEdits and failedCounted send one combined PUT on quit', async () => {
  const first = Promise.withResolvers()
  const put = vi.spyOn(api, 'putCapital')
    .mockReturnValueOnce(first.promise)
    .mockRejectedValueOnce(new Error('locked-2'))
    .mockImplementation(async entries => makeCapital(entries))

  const { saveCapital } = useStatus.getState()
  const p1 = saveCapital({ divine: 25, exalted: 500 }, ['divine'], new Map([['divine', { kind: 'count', value: 25 }]]))
  const p2 = saveCapital({ divine: 25, exalted: 600 }, ['exalted'], new Map([['exalted', { kind: 'count', value: 600 }]]))
  const r1 = p1.catch(e => e.message)
  const r2 = p2.catch(e => e.message)

  first.reject(new Error('locked-1'))
  expect(await r1).toBe('locked-1')
  expect(await r2).toBe('locked-2')
  expect(put).toHaveBeenCalledTimes(2)

  const ok = await act(async () => flushForQuit())
  expect(ok).toBe(true)
  expect(put).toHaveBeenCalledTimes(3)
  expect(put.mock.calls[2][0]).toEqual({ divine: 25, exalted: 600 })
  expect([...put.mock.calls[2][1]].sort()).toEqual(['divine', 'exalted'])
})

it('salesFetching and capitalStale hold the quit flush until cleared', async () => {
  const put = vi.spyOn(api, 'putCapital').mockImplementation(async entries => makeCapital(entries))
  const view1 = render(<StashView />)
  await settle()

  fireEvent.change(screen.getByLabelText('Divine Orb held'), { target: { value: '25' } })
  act(() => { useStatus.setState({ salesFetching: true }) })
  await settle()

  const quit1 = flushForQuit()
  await advance(90)
  expect(put).not.toHaveBeenCalled()

  act(() => { useStatus.setState({ salesFetching: false }) })
  await advance(20)
  expect(await quit1).toBe(true)
  expect(put.mock.calls).toEqual([[{ divine: 25, exalted: 500 }, ['divine']]])
  view1.unmount()
  await settle()

  // capitalStale holds a pending capitalDirty edit until cleared.
  put.mockClear()
  capitalDirty.set('divine', { kind: 'count', value: 30 })
  useStatus.setState({ capitalStale: true })

  const quit2 = flushForQuit()
  await advance(1000)
  expect(await quit2).toBe(false)
  expect(put).not.toHaveBeenCalled()

  useStatus.setState({ capitalStale: false })
  const quit3 = await act(async () => flushForQuit())
  expect(quit3).toBe(true)
  expect(put.mock.calls).toEqual([[{ divine: 30, exalted: 500 }, ['divine']]])
})
