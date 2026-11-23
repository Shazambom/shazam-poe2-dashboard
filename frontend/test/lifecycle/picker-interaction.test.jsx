import { it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import CurrencyPicker from '../../src/components/CurrencyPicker.jsx'

it('lets the picker reopen from its padding and keeps selection in the focused input', () => {
  const choose = vi.fn()
  const opts = [{ id: 'c', name: 'Chaos' }, { id: 'd', name: 'Divine' }]
  const { container } = render(<CurrencyPicker value="c" onChange={choose} options={opts}
    placeholder="Currency" renderIcon={null} />)
  const input = screen.getByPlaceholderText('Currency')
  fireEvent.click(container.querySelector('.curpick-box'))
  expect(document.activeElement).toBe(input)
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(container.querySelector('.curpick-pop')).toBeNull()
  fireEvent.click(input)
  const rows = container.querySelectorAll('.cmdk-item')
  expect(rows).toHaveLength(2)
  fireEvent.mouseDown(rows[1])
  expect(choose.mock.calls).toEqual([['d']])
  expect(container.querySelector('.curpick-pop')).toBeNull()
})
