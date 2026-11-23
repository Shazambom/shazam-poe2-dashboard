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

it('resets the selected command and filter and samples the newly enabled control on reopen', async () => {
  installApiMock()
  const command = vi.fn()
  const view = (open, enabled) => <>
    <CommandPalette open={open} onClose={() => {}} tabs={['Alpha', 'Alpine']} leagues={[]} screen="Board"
      screenCommands={{ Board: [{ id: 'mounted', label: 'Board command', target: 'mounted', run: command }] }} />
    <button type="button" data-cmd="mounted" disabled={!enabled}>Target</button>
  </>
  const { rerender } = render(view(true, false))
  const field = () => screen.getByPlaceholderText(/Search screens/)
  fireEvent.change(field(), { target: { value: 'Al' } })
  fireEvent.keyDown(field(), { key: 'ArrowDown' })
  expect(document.querySelector('.cmdk-item.sel .cmdk-label').textContent).toBe('Alpine')
  rerender(view(false, false))
  rerender(view(true, true))
  expect(field().value).toBe('')
  expect(document.querySelector('.cmdk-item.sel .cmdk-label').textContent).toBe('Board command')
  fireEvent.keyDown(field(), { key: 'Enter' })
  expect(command).toHaveBeenCalledTimes(1)
})
