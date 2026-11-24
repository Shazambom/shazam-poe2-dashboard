import { afterEach, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useLiveSync } from '../../src/lib/liveWiring.js'
import { useWorkspace } from '../../src/lib/workspaceStore.js'
import { liveLabel, usePings } from '../../src/lib/pingStore.js'
import { installApiMock } from './setup.js'

afterEach(() => vi.useRealTimers())

it('rearms a rejected live start without a workspace edit and bounds repeated failures', async () => {
  vi.useFakeTimers()
  installApiMock()
  useWorkspace.setState({ loaded: true, tree: [{ kind: 'search', id: 'row', armed: true, slug: 'saved' }] })
  const start = vi.spyOn(window.poe2desktop.trade, 'startSearch').mockRejectedValue(new Error('disconnected'))
  const { unmount } = renderHook(() => useLiveSync('Test'))
  await act(async () => {})
  expect(start).toHaveBeenCalledTimes(1)
  expect(usePings.getState().searchStates.row).toBeUndefined()
  await act(async () => { await vi.advanceTimersByTimeAsync(120000) })
  expect(start).toHaveBeenCalledTimes(4)
  expect(liveLabel({ armed: true }, usePings.getState().searchStates.row).text).toBe('Reconnecting…')
  start.mockImplementation(async () => {
    usePings.getState().setSearchState({ itemId: 'row', state: 'live' })
    return { ok: true }
  })
  await act(async () => useWorkspace.setState({ loaded: true }))
  expect(start).toHaveBeenCalledTimes(5)
  expect(usePings.getState().searchStates.row.state).toBe('live')
  expect(document.body.textContent).toBe('')
  unmount()
})

// QA 2026-11-24: a watch the trade site rejected showed "Reconnect session", but the button only flipped
// the watch off. It reconnects the account, and the watch starts again once the account is back.
it('Reconnect session on a rejected watch connects the account, then starts the watch again', async () => {
  installApiMock()
  const { default: LiveView } = await import('../../src/components/LiveView.jsx')
  const { fireEvent, render, screen } = await import('@testing-library/react')
  useWorkspace.setState({ loaded: true, tree: [{ kind: 'search', id: 'row', name: 'Circlet', armed: true, slug: 'saved' }] })
  const start = vi.spyOn(window.poe2desktop.trade, 'startSearch').mockResolvedValue({ ok: true })
  const sync = renderHook(() => useLiveSync('Test'))
  await act(async () => {})
  expect(start).toHaveBeenCalledTimes(1)
  // The engine rejected it: auth state, gone from the live set.
  act(() => {
    usePings.getState().setSearchState({ itemId: 'row', state: 'auth', message: 'Reconnect your PoE session' })
    usePings.getState().setEngine({ active: 0, activeIds: [], budgetMax: 20 })
  })
  render(<LiveView league="Test" />)
  const button = screen.getByRole('button', { name: 'Reconnect session' })
  await act(async () => { fireEvent.click(button) })
  expect(window.poe2desktop.connectSession).toHaveBeenCalledTimes(1)
  expect(useWorkspace.getState().tree[0].armed).toBe(true)
  expect(start).toHaveBeenCalledTimes(2)
  sync.unmount()
})
