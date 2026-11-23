import { it, expect, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useReprice } from '../../src/lib/useReprice.js'
import { encodeSlug } from '../../src/lib/reprice.js'
import { tradeUrl } from '../../src/lib/session.js'
import { api } from '../../src/lib/api.js'
import { installApiMock } from './setup.js'

it('rechecks the displayed offer when another trade window supplies or outlives cheaper evidence', async () => {
  installApiMock()
  vi.spyOn(api, 'stratPrices').mockResolvedValue({ prices: { divine: 1, chaos: 0.05 } })
  let publish
  vi.spyOn(window.poe2desktop.trade, 'onTap').mockImplementation(cb => { publish = cb; return () => {} })
  const clock = vi.spyOn(Date, 'now')
  const start = Date.now()
  clock.mockReturnValue(start)
  const query = { type: 'test item' }
  const slug = await encodeSlug(query)
  const props = {
    wv: { current: { getWebContentsId: () => 31 } }, node: { kind: 'search', slug },
    league: 'Demo', navUrl: tradeUrl({ slug }, 'Demo'), visible: true,
  }
  const { result, rerender, unmount } = renderHook(() => useReprice(props))
  await waitFor(() => expect(result.current.rowQuery).toEqual(query))
  const body = { query, sort: { price: 'asc' } }
  const price = [{ id: 'divine', text: 'Divine Orb' }, { id: 'chaos', text: 'Chaos Orb' }]
  const sendPage = (wcId, currency) => {
    const id = String(wcId)
    publish({ kind: 'search', wcId, league: 'Demo', body, ids: [id], id })
    publish({ kind: 'fetch', wcId, searchId: id, rows: [{ id, currency, amount: 1 }] })
  }
  await act(async () => { publish({ kind: 'options', wcId: 31, price }); sendPage(31, 'divine') })
  expect(result.current.offer).toBeNull()
  const own = result.current.own
  await act(async () => sendPage(32, 'chaos'))
  expect(result.current.own).toBe(own)
  expect(result.current.offer?.currency).toBe('chaos')
  clock.mockReturnValue(start + 300001)
  rerender()
  expect(result.current.offer?.currency).toBe('chaos')
  act(() => publish({ kind: 'options', wcId: 32, price }))
  expect(result.current.offer).toBeNull()
  unmount()
})

it('cancels listing requests on visibility or window changes and on unmount', () => {
  const cancel = vi.spyOn(window.poe2desktop.trade, 'listingsCancel')
  const fetch = vi.spyOn(window.poe2desktop.trade, 'listings')
  const wv = { current: { getWebContentsId: () => 73 } }
  const props = { wv, navUrl: '', node: null, remountKey: 'A', visible: true }
  const { rerender, unmount } = renderHook(p => useReprice(p), { initialProps: props })
  rerender({ ...props })
  expect(cancel).not.toHaveBeenCalled()
  rerender({ ...props, visible: false })
  expect(cancel).toHaveBeenCalledTimes(1)
  rerender({ ...props, visible: false, remountKey: 'B' })
  expect(cancel).toHaveBeenCalledTimes(2)
  unmount()
  expect(cancel).toHaveBeenCalledTimes(3)
  expect(fetch).not.toHaveBeenCalled()
})
