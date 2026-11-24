import { useLayoutEffect } from 'react'
import { it, expect, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useApi } from '../../src/lib/hooks.js'

it('commits twice for initial load and three times for a complete refetch', async () => {
  const commits = [], first = Promise.withResolvers(), second = Promise.withResolvers()
  const { rerender } = renderHook(index => {
    const state = useApi(() => (index ? second : first).promise, [index])
    useLayoutEffect(() => { commits.push([state.data, state.busy, state.err]) })
  }, { initialProps: 0 })
  await act(async () => first.resolve('first'))
  expect(commits.splice(0)).toEqual([[null, true, null], ['first', false, null]])
  rerender(1)
  await act(async () => second.reject(new Error('failed')))
  expect(commits).toEqual([['first', false, null], ['first', true, null], ['first', false, 'failed']])
})

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

it('commits the old result before the passive refetch publishes busy and rejects late results', async () => {
  const commits = []
  const requests = ['A', 'B', 'C'].map(() => Promise.withResolvers())
  const { rerender, result } = renderHook(index => {
    const state = useApi(() => requests[index].promise, [index])
    useLayoutEffect(() => { commits.push([index, state.data, state.busy]) })
    return state
  }, { initialProps: 0 })
  await act(async () => requests[0].resolve('saved'))
  expect(commits.filter(([index]) => index === 0)).toEqual([[0, null, true], [0, 'saved', false]])
  rerender(1)
  expect(commits.filter(([index]) => index === 1)).toEqual([[1, 'saved', false], [1, 'saved', true]])
  rerender(2)
  await act(async () => requests[1].resolve('superseded'))
  expect(result.current.data).toBe('saved')
  expect(result.current.busy).toBe(true)
  await act(async () => requests[2].resolve('current'))
  expect(result.current.data).toBe('current')
  expect(result.current.busy).toBe(false)
  expect(commits.filter(([index]) => index === 2)).toEqual([[2, 'saved', true], [2, 'current', false]])
})
