import { it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { installApiMock, DEFAULT_CURRENCIES } from './setup.js'
import { loadIcons, useIcons } from '../../src/lib/icons.js'

it('shares one icon request, keeps the last published value across a failure and retries after five seconds', async () => {
  vi.useFakeTimers()
  try {
    let attempt = 0
    const { calls } = installApiMock({
      '/api/currencies': () => {
        attempt += 1
        if (attempt === 1) return new Response('unavailable', { status: 503 })
        return DEFAULT_CURRENCIES
      },
    })
    const first = renderHook(() => useIcons())
    const second = renderHook(() => useIcons())
    await act(async () => { await loadIcons() })
    const reads = () => calls.filter(call => call.path === '/api/currencies')
    expect(reads()).toHaveLength(1)
    first.rerender()
    expect(first.result.current).toBeNull()
    expect(second.result.current).toBeNull()
    second.unmount()
    const late = renderHook(() => useIcons())
    expect(late.result.current.list).toEqual([])
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(reads()).toHaveLength(2)
    expect(first.result.current.list).toEqual(DEFAULT_CURRENCIES.currencies)
    expect(late.result.current).toBe(first.result.current)
    expect(second.result.current).toBeNull()
    first.unmount()
    late.unmount()
  } finally {
    vi.useRealTimers()
  }
})
