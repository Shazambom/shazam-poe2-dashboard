import { it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAutosave } from '../../src/lib/hooks.js'

it('autosave retains a pending draft across rerenders and flushes it once with the current saver on unmount', () => {
  vi.useFakeTimers()
  try {
    const first = vi.fn()
    const last = vi.fn()
    const { result, rerender, unmount } = renderHook(saver => useAutosave(saver, 500), { initialProps: first, reactStrictMode: true })
    const { arm, save } = result.current
    act(() => { arm(); save('pending') })
    rerender(last)
    expect(result.current.arm).toBe(arm)
    expect(result.current.save).toBe(save)
    expect(last).not.toHaveBeenCalled()
    unmount()
    expect(last.mock.calls).toEqual([['pending']])
    act(() => { save('late'); vi.advanceTimersByTime(1000) })
    expect(first).not.toHaveBeenCalled()
    expect(last).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
})
