import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAutosave } from '../../src/lib/hooks.js'
import { flushForQuit } from '../../src/lib/quitFlush.js'

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const advance = ms => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('does not resurrect a failed autosave payload on unmount or quit', async () => {
  const put = vi.fn().mockRejectedValueOnce(new Error('locked')).mockResolvedValue(true)
  const { result, unmount } = renderHook(() => useAutosave(put, 500))

  act(() => { result.current.arm(); result.current.save('draft') })
  await advance(500)
  expect(put.mock.calls).toEqual([['draft']])

  unmount()
  await settle()
  await act(async () => { await flushForQuit() })

  expect(put).toHaveBeenCalledTimes(1)
})

it('does not resurrect a failed autosave payload on quit while mounted', async () => {
  const put = vi.fn().mockRejectedValueOnce(new Error('locked')).mockResolvedValue(true)
  const { result } = renderHook(() => useAutosave(put, 500))

  act(() => { result.current.arm(); result.current.save('draft') })
  await advance(500)
  expect(put.mock.calls).toEqual([['draft']])

  await act(async () => { await flushForQuit() })

  expect(put).toHaveBeenCalledTimes(1)
})

it('still flushes a pending edit inside the debounce window on unmount and on quit', async () => {
  const putA = vi.fn().mockResolvedValue(true)
  const hookA = renderHook(() => useAutosave(putA, 500))
  act(() => { hookA.result.current.arm(); hookA.result.current.save('unmount-draft') })
  await advance(200)
  expect(putA).not.toHaveBeenCalled()
  hookA.unmount()
  await settle()
  expect(putA.mock.calls).toEqual([['unmount-draft']])

  const putB = vi.fn().mockResolvedValue(true)
  const hookB = renderHook(() => useAutosave(putB, 500))
  act(() => { hookB.result.current.arm(); hookB.result.current.save('quit-draft') })
  await advance(200)
  expect(putB).not.toHaveBeenCalled()
  await act(async () => { await flushForQuit() })
  expect(putB.mock.calls).toEqual([['quit-draft']])
})
