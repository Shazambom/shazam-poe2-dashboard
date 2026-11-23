import { it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import TradeBuilder from '../../src/components/TradeBuilder.jsx'

it('keeps trade subscriptions and the pasted draft until the builder closes', () => {
  const offNav = vi.fn(), offTap = vi.fn()
  const trade = window.poe2desktop.trade
  const nav = vi.spyOn(trade, 'onWebviewNav').mockReturnValue(offNav)
  const tap = vi.spyOn(trade, 'onTap').mockReturnValue(offTap)
  const close = vi.fn()
  const props = { title: 'Build', url: 'about:blank', league: 'A', onClose: close }
  const { rerender, unmount } = render(<TradeBuilder {...props} />)
  const input = screen.getByPlaceholderText('Paste a trade link')
  fireEvent.change(input, { target: { value: 'draft' } })
  rerender(<TradeBuilder {...props} url="about:blank#updated" />)
  expect(input.value).toBe('draft')
  expect(nav).toHaveBeenCalledTimes(1)
  expect(tap).toHaveBeenCalledTimes(1)
  unmount()
  expect(offNav).toHaveBeenCalledTimes(1)
  expect(offTap).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(close).not.toHaveBeenCalled()
})
