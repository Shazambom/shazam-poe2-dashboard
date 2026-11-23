import { it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { usePoll } from '../../src/lib/hooks.js'

it('polls with the current callback, restarts only for a changed input and releases listeners and timers', () => {
  vi.useFakeTimers()
  try {
    const a = vi.fn(), b = vi.fn()
    const { rerender, unmount } = renderHook(({ run, league }) => usePoll(run, 10000, [league]), {
      initialProps: { run: a, league: 'A' },
    })
    expect(a).toHaveBeenCalledTimes(1)
    rerender({ run: b, league: 'A' })
    expect(b).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(10000))
    expect(b).toHaveBeenCalledTimes(1)
    rerender({ run: b, league: 'B' })
    expect(b).toHaveBeenCalledTimes(2)
    unmount()
    act(() => { vi.advanceTimersByTime(20000); window.dispatchEvent(new Event('focus')) })
    expect(b).toHaveBeenCalledTimes(2)
    expect(a).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
})
