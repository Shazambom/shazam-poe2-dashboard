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
