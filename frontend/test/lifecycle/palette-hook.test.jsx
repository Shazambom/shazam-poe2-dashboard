import { it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import CommandPalette from '../../src/components/CommandPalette.jsx'
import { installApiMock } from './setup.js'

it('loads the board once per palette opening and keeps a typed filter across unrelated renders', async () => {
  const { calls } = installApiMock()
  const props = { tabs: ['Board', 'Trading'], leagues: [], onClose: vi.fn() }
  const { rerender, unmount } = render(<CommandPalette {...props} open />)
  const input = screen.getByPlaceholderText(/Search screens/)
  const reads = () => calls.filter(call => call.path === '/api/board')
  await waitFor(() => expect(reads()).toHaveLength(1))
  fireEvent.change(input, { target: { value: 'Trading' } })
  rerender(<CommandPalette {...props} open screenCommands={{}} />)
  expect(input.value).toBe('Trading')
  expect(reads()).toHaveLength(1)
  rerender(<CommandPalette {...props} open={false} />)
  rerender(<CommandPalette {...props} open />)
  await waitFor(() => expect(reads()).toHaveLength(2))
  expect(screen.getByPlaceholderText(/Search screens/).value).toBe('')
  unmount()
  expect(screen.queryByPlaceholderText(/Search screens/)).toBeNull()
})

it('samples the controls mounted with the palette and keeps those commands until the next opening', async () => {
  const { calls } = installApiMock()
  const props = {
    tabs: [], leagues: [], onClose: vi.fn(), screen: 'Board',
    screenCommands: { Board: [{ id: 'choose', label: 'Choose holding', target: 'choose-holding' }] },
  }
  const view = (open, disabled) => <>
    <CommandPalette {...props} open={open} />
    <button type="button" data-cmd="choose-holding" disabled={disabled}>Holding</button>
  </>
  const { rerender, unmount } = render(view(false, true))
  expect(screen.queryByText('Choose holding')).toBeNull()
  rerender(view(true, false))
  expect(await screen.findByText('Choose holding')).toBeTruthy()
  rerender(view(true, true))
  expect(screen.getByText('Choose holding')).toBeTruthy()
  rerender(view(false, true))
  rerender(view(true, true))
  await waitFor(() => expect(calls.filter(call => call.path === '/api/board')).toHaveLength(2))
  expect(screen.queryByText('Choose holding')).toBeNull()
  unmount()
})
