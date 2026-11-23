import { useLayoutEffect } from 'react'
import { it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useReprice } from '../../src/lib/useReprice.js'
import * as session from '../../src/lib/session.js'

it('publishes the old same-row query, clears during decode, then publishes only the current address', async () => {
  const decodes = new Map(['first', 'second', 'late', 'final'].map(key => [key, Promise.withResolvers()]))
  vi.spyOn(session, 'searchOfLink').mockImplementation(url => decodes.get(url).promise)
  const commits = []
  const wv = { current: null }
  const { result, rerender } = renderHook(({ id, url }) => {
    const { rowQuery } = useReprice({ wv, node: { id, kind: 'search' }, navUrl: url, league: 'Test' })
    useLayoutEffect(() => { commits.push([url, rowQuery?.type ?? null]) })
    return rowQuery
  }, { initialProps: { id: 1, url: 'first' } })
  const finish = url => act(async () => decodes.get(url).resolve({ query: { type: url, status: { option: 'securable' } } }))
  await finish('first')
  rerender({ id: 1, url: 'second' })
  expect(commits.filter(([url]) => url === 'second')).toEqual([['second', 'first'], ['second', null]])
  await finish('second')
  expect(result.current?.type).toBe('second')
  rerender({ id: 2, url: 'late' })
  expect(commits.filter(([url]) => url === 'late').every(([, type]) => type === null)).toBe(true)
  rerender({ id: 2, url: 'final' })
  await finish('final')
  await finish('late')
  expect(result.current?.type).toBe('final')
})
