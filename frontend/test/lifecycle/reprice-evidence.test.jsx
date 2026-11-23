import { it, expect, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useReprice } from '../../src/lib/useReprice.js'
import { encodeSlug } from '../../src/lib/reprice.js'
import { tradeUrl } from '../../src/lib/session.js'
import { api } from '../../src/lib/api.js'
import { installApiMock } from './setup.js'

it('accepts cheaper sibling evidence from another window only for the selected league', async () => {
  installApiMock()
  vi.spyOn(api, 'stratPrices').mockResolvedValue({ prices: { divine: 1, chaos: 0.05 } })
  let publish
  vi.spyOn(window.poe2desktop.trade, 'onTap').mockImplementation(cb => { publish = cb; return () => {} })
  const query = { type: 'Fixture', status: { option: 'securable' } }
  const slug = await encodeSlug(query)
  const props = {
    wv: { current: { getWebContentsId: () => 31 } }, node: { kind: 'search', slug },
    league: 'Demo', navUrl: tradeUrl({ slug }, 'Demo'), visible: true,
  }
  const { result } = renderHook(() => useReprice(props))
  await waitFor(() => expect(result.current.rowQuery).toEqual(query))
  const send = (wcId, league, currency, search) => {
    const id = String(wcId)
    publish({ kind: 'search', wcId, league, body: { query: search, sort: { price: 'asc' } }, ids: [id], id })
    publish({ kind: 'fetch', wcId, searchId: id, rows: [{ id, currency, amount: 1 }] })
  }
  await act(async () => {
    publish({ kind: 'options', wcId: 31, price: [{ id: 'divine' }, { id: 'chaos' }] })
    send(31, 'Demo', 'divine', query)
  })
  const own = result.current.own
  const filtered = { ...query, filters: { trade_filters: { filters: { price: { option: 'chaos' } } } } }
  await act(async () => send(32, 'Other', 'chaos', filtered))
  expect(result.current.offer).toBeNull()
  await act(async () => send(33, 'Demo', 'chaos', filtered))
  expect(result.current.own).toBe(own)
  expect(result.current.offer?.currency).toBe('chaos')
  expect(result.current.state).toBe('reprice')
  expect(window.poe2desktop.trade.recheck).not.toHaveBeenCalled()
})
