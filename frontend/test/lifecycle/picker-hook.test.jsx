import { it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import CurrencyPicker from '../../src/components/CurrencyPicker.jsx'

it('keeps the typed currency filter when choices change and picks the first remaining result', () => {
  const pick = vi.fn()
  const opts = [{ id: 'a', name: 'Coin A' }, { id: 'b', name: 'Coin B' }]
  const props = { value: '', placeholder: 'Search coins', renderIcon: null, onChange: pick }
  const { rerender, unmount } = render(<CurrencyPicker {...props} options={opts} />)
  const input = screen.getByPlaceholderText('Search coins')
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: 'Coin' } })
  fireEvent.keyDown(input, { key: 'ArrowDown' })
  rerender(<CurrencyPicker {...props} options={opts.slice(0, 1)} />)
  expect(input.value).toBe('Coin')
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(pick.mock.calls).toEqual([['a']])
  unmount()
  fireEvent.mouseDown(document)
  expect(pick).toHaveBeenCalledTimes(1)
})
