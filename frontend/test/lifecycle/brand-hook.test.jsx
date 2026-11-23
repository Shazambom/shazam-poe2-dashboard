import { it, expect, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import BrandOrb from '../../src/components/BrandOrb.jsx'
import { api } from '../../src/lib/api.js'

it('keeps the mounted backfill poll and cancels its next tick when the orb unmounts', async () => {
  vi.useFakeTimers()
  try {
    const first = vi.fn(), second = vi.fn()
    const poll = vi.spyOn(api, 'backfill').mockResolvedValueOnce({ running: true, phase: 'leagues' }).mockResolvedValue(null)
    const { rerender, unmount } = render(<BrandOrb onDone={first} />)
    await act(async () => {})
    rerender(<BrandOrb onDone={second} />)
    expect(poll).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    unmount()
    await vi.advanceTimersByTimeAsync(10000)
    expect(poll).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})
