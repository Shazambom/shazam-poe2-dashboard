import { it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { iconFailed, useIconEpoch } from '../../src/lib/icons.js'

it('retains the last delivered icon epoch while inactive and catches up once on activation', () => {
  vi.useFakeTimers()
  try {
    const { result, rerender, unmount } = renderHook(active => useIconEpoch(active), { initialProps: false })
    const first = result.current
    act(() => { iconFailed(); iconFailed(); vi.advanceTimersByTime(5000) })
    rerender(false)
    expect(result.current).toBe(first)
    rerender(true)
    expect(result.current).toBe(first + 1)
    rerender(false)
    act(() => { iconFailed(); vi.advanceTimersByTime(15000) })
    rerender(false)
    expect(result.current).toBe(first + 1)
    rerender(true)
    expect(result.current).toBe(first + 2)
    unmount()
    act(() => { iconFailed(); vi.advanceTimersByTime(45000) })
    expect(result.current).toBe(first + 2)
  } finally {
    vi.useRealTimers()
  }
})
