import { it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useRelax } from '../../src/lib/useRelax.js'
import { INSTANT_BUYOUT } from '../../src/lib/regex/trade.js'

function rareQuery(mods) {
  return {
    status: { ...INSTANT_BUYOUT },
    stats: [{ type: 'and', filters: mods.map(id => ({ id, value: { min: 10 } })) }],
  }
}

const modsA = ['explicit.stat_life', 'explicit.stat_fire', 'explicit.stat_cold']
const modsB = ['explicit.stat_armour', 'explicit.stat_spirit', 'explicit.stat_chaos']
const node = (id, mods) => ({ id, kind: 'search', q: JSON.stringify({ query: rareQuery(mods) }) })

async function switchRow({ reset, fresh }) {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected request'))
  const relax = vi.spyOn(window.poe2desktop.trade, 'relax').mockResolvedValue({
    ok: true, total: 1, rows: [{ amount: 1, currency: 'divine' }],
  })
  const first = node('first', modsA)
  const second = node('second', modsB)
  const { result, rerender, unmount } = renderHook(({ row, page }) => useRelax({
    node: row, page, league: 'Demo', remountKey: row.id, prices: { divine: 1 },
  }), { initialProps: { row: first, page: null } })
  await act(async () => { await result.current.apply() })
  const built = JSON.parse(new URL(result.current.relaxUrl).searchParams.get('q'))
  expect(built.query.status).toEqual(INSTANT_BUYOUT)
  const oldPage = { search: { id: 'same-id', body: built } }
  rerender({ row: first, page: oldPage })
  if (reset) act(() => result.current.reset())

  const observed = fresh ? { search: { id: 'same-id', body: { query: rareQuery(fresh) } } } : oldPage
  rerender({ row: second, page: observed })
  const tick = result.current.relaxTick
  // A fetch can update the attached page's rows without starting a new search.
  rerender({ row: second, page: { ...observed, rows: {} } })
  expect(result.current.relaxUrl).toBeNull()
  expect(result.current.relaxTick).toBe(tick)
  expect(relax).toHaveBeenCalledTimes(1)
  expect(window.poe2desktop.openTrade).not.toHaveBeenCalled()
  await act(async () => { await result.current.apply() })
  expect(relax).toHaveBeenCalledTimes(2)
  const requested = relax.mock.calls.map(([payload]) => payload.query)
  expect(requested.map(q => q.status)).toEqual([INSTANT_BUYOUT, INSTANT_BUYOUT])
  expect(requested[1].stats[0].filters.map(f => f.id)).toEqual(fresh || modsB)
  expect(JSON.parse(new URL(result.current.relaxUrl).searchParams.get('q')).query.status).toEqual(INSTANT_BUYOUT)
  expect(fetch).not.toHaveBeenCalled()
  unmount()
}

it('ignores the outgoing relaxed search after Exact and another render on the next saved row', async () => {
  await switchRow({ reset: true })
})

it('ignores the outgoing relaxed search when switching directly to the next saved row', async () => {
  await switchRow({ reset: false })
})

it('accepts a newly observed search on the next row even when the site reuses its search id', async () => {
  await switchRow({ reset: false, fresh: ['explicit.stat_mana', 'explicit.stat_accuracy', 'explicit.stat_strength'] })
})
