import { it, expect, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useApi } from '../../src/lib/hooks.js'

it('loads once per input, keeps the last result while busy and ignores superseded and post-unmount responses', async () => {
  const requests = []
  const load = vi.fn(() => {
    const pending = Promise.withResolvers()
    requests.push(pending)
    return pending.promise
  })
  const { result, rerender, unmount } = renderHook(id => useApi(() => load(id), [id]), { initialProps: 'A' })
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
  await act(async () => { requests[0].resolve('first'); await requests[0].promise })
  rerender('A')
  expect(result.current.data).toBe('first')
  expect(result.current.busy).toBe(false)
  rerender('B')
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  expect(result.current.data).toBe('first')
  expect(result.current.busy).toBe(true)
  rerender('C')
  await waitFor(() => expect(load).toHaveBeenCalledTimes(3))
  await act(async () => { requests[1].resolve('superseded'); await requests[1].promise })
  expect(result.current.data).toBe('first')
  expect(result.current.busy).toBe(true)
  unmount()
  await act(async () => { requests[2].resolve('late'); await requests[2].promise })
  expect(load.mock.calls).toEqual([['A'], ['B'], ['C']])
  expect(result.current.data).toBe('first')
})
