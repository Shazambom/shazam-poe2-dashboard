import { it, expect, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import UpdateStatus from '../../src/components/UpdateStatus.jsx'

it('subscribes to updates once and releases the subscription on unmount', () => {
  const unsubscribe = vi.fn()
  const subscribe = vi.spyOn(window.poe2desktop, 'onUpdate').mockReturnValue(unsubscribe)
  const { rerender, unmount } = render(<UpdateStatus version="1" />)
  rerender(<UpdateStatus version="2" />)
  expect(subscribe).toHaveBeenCalledTimes(1)
  act(() => subscribe.mock.calls[0][0]({ phase: 'ready', version: '3' }))
  expect(screen.getByRole('button', { name: /Install update 3/ })).toBeTruthy()
  unmount()
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})
