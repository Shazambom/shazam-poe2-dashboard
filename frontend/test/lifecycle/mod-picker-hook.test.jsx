import { it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import ModPicker from '../../src/components/ModPicker.jsx'

it('keeps modifier rows under the pointer and the filter draft until the pointer leaves', () => {
  const props = { mods: [{ id: 'a', text: 'Mod A' }, { id: 'b', text: 'Mod B' }, { id: 'c', text: 'Other' }], onToggle: vi.fn(), header: 'Mods' }
  const { rerender, unmount } = render(<ModPicker {...props} selected={new Set()} />)
  const filter = screen.getByPlaceholderText('Filter modifiers')
  fireEvent.change(filter, { target: { value: 'mod' } })
  fireEvent.click(screen.getByRole('option', { name: 'Mod B' }))
  expect(props.onToggle.mock.calls).toEqual([['b']])
  rerender(<ModPicker {...props} selected={new Set(['b'])} />)
  const rows = () => screen.getAllByRole('option').map(row => row.textContent)
  expect(filter.value).toBe('mod')
  expect(rows()).toEqual(['Mod A', 'Mod B'])
  expect(screen.getByRole('option', { name: 'Mod B' }).getAttribute('aria-selected')).toBe('true')
  fireEvent.change(filter, { target: { value: 'MOD ' } })
  expect(rows()).toEqual(['Mod A', 'Mod B'])
  fireEvent.mouseLeave(screen.getByRole('listbox'))
  expect(rows()).toEqual(['Mod B', 'Mod A'])
  fireEvent.change(filter, { target: { value: 'b mod' } })
  expect(rows()).toEqual(['Mod B'])
  unmount()
  expect(screen.queryByRole('listbox')).toBeNull()
})
