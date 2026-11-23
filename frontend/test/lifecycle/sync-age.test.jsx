import { it, expect, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { SyncMetrics } from '../../src/components/SyncControls.jsx'

it('samples market age on the next render without a background timer', () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(1000000)
    const status = { digest: { last_fetch: 995 } }
    const { rerender } = render(<SyncMetrics status={status} />)
    expect(screen.getByText('market 5s ago')).toBeTruthy()
    act(() => vi.advanceTimersByTime(120000))
    expect(screen.getByText('market 5s ago')).toBeTruthy()
    rerender(<SyncMetrics status={status} />)
    expect(screen.getByText('market 2m ago')).toBeTruthy()
  } finally {
    vi.useRealTimers()
  }
})
