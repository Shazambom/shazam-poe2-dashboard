import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from '../../src/App.jsx'
import { api, bus } from '../../src/lib/api.js'
import { createSaveQueue } from '../../src/lib/saveQueue.js'
import { persistSettings, useStatus } from '../../src/lib/statusStore.js'
import { installApiMock } from './setup.js'

const settle = () => act(async () => {})
const advance = ms => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const events = vi.fn()
let off

beforeEach(() => {
  vi.useFakeTimers()
  installApiMock({
    '/api/leagues': [{ id: 'A', text: 'A' }, { id: 'B', text: 'B' }],
    '/api/status': {
      league: 'A',
      reference: 'exalted',
      wealth_prices: { exalted: 1, divine: 100, chaos: 5, mirror: 50000 },
      digest_age_s: 120,
      live_pairs: 12,
      session: { connected: false },
    },
  })
  useStatus.setState({ settings: { league: 'A', notifications: {} } })
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} })
  off = bus.on(events.mockClear())
})

afterEach(() => {
  off()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('resolves a non-optimistic save when a retry lands and runs App refreshHeader without a false error toast', async () => {
  let currentLeague = 'A'
  let statusCalls = 0
  vi.spyOn(api, 'status').mockImplementation(async () => {
    statusCalls++
    return {
      league: currentLeague,
      reference: 'exalted',
      wealth_prices: { exalted: 1, divine: 100, chaos: 5, mirror: 50000 },
      digest_age_s: 120,
      live_pairs: 12,
      session: { connected: false },
    }
  })
  const write = vi.spyOn(api, 'putSettings')
    .mockRejectedValueOnce(new Error('locked'))
    .mockImplementation(async patch => {
      if (patch.league) currentLeague = patch.league
      return { league: currentLeague, notifications: {} }
    })

  render(<App />)
  await settle()
  const beforeStatus = statusCalls
  const picker = screen.getByTitle('League — saves on select')
  fireEvent.change(picker, { target: { value: 'B' } })
  await settle()

  // First attempt failed, still retrying: no premature error toast yet.
  expect(write.mock.calls).toEqual([[{ league: 'B' }]])
  expect(events).not.toHaveBeenCalled()

  // Retry lands after 1s: save resolves, App runs refreshHeader, no error toast.
  await advance(1000)
  expect(write.mock.calls).toEqual([[{ league: 'B' }], [{ league: 'B' }]])
  expect(statusCalls).toBeGreaterThan(beforeStatus)
  expect(useStatus.getState().status.league).toBe('B')
  expect(events).not.toHaveBeenCalled()
})

it('drops a non-optimistic save after retries are exhausted so a later unrelated write never carries it', async () => {
  const write = vi.spyOn(api, 'putSettings').mockRejectedValue(new Error('locked'))
  useStatus.setState({ settings: { league: 'A', notifications: {} } })

  const failed = useStatus.getState().saveSettings({ league: 'B' })
  const outcome = failed.then(() => 'resolved', e => e.message)
  await advance(25000)
  expect(await outcome).toBe('locked')
  expect(write).toHaveBeenCalledTimes(4)
  expect(useStatus.getState().settings.league).toBe('A')

  write.mockClear()
  write.mockImplementation(async patch => ({ league: 'A', ...patch }))
  await useStatus.getState().saveSettings({ notifications: { sound: false } })
  expect(write.mock.calls).toEqual([[{ notifications: { sound: false } }]])
})

it('keeps carrying an optimistic save after retries are exhausted', async () => {
  const write = vi.spyOn(api, 'putSettings').mockRejectedValue(new Error('locked'))
  useStatus.setState({ settings: { hold_caution: 2, notifications: {} } })

  const failed = persistSettings({ hold_caution: 4 })
  const outcome = failed.then(() => 'resolved', e => e.message)
  await advance(25000)
  expect(await outcome).toBe('locked')
  expect(write).toHaveBeenCalledTimes(4)
  expect(useStatus.getState().settings.hold_caution).toBe(4)

  write.mockClear()
  write.mockImplementation(async patch => ({ ...useStatus.getState().settings, ...patch }))
  await useStatus.getState().saveSettings({ notifications: { sound: false } })
  expect(write.mock.calls).toEqual([[{ hold_caution: 4, notifications: { sound: false } }]])
})

it('supersedes an older retrying save when a newer save arrives for the same key', async () => {
  const write = vi.fn()
    .mockRejectedValueOnce(new Error('locked'))
    .mockImplementation(async patch => patch)
  const queue = createSaveQueue(write, { delays: [1000, 4000, 15000] })

  const first = queue.save({ league: 'B' })
  await settle()
  expect(write.mock.calls).toEqual([[{ league: 'B' }]])

  const second = queue.save({ league: 'C' })
  await settle()
  expect(await second).toEqual({ league: 'C' })
  await first
  await advance(25000)
  expect(write.mock.calls).toEqual([[{ league: 'B' }], [{ league: 'C' }]])
})

// An older save superseded by a newer one for the same key only lands through the newer one. If the newer
// save fails for good, neither value reached the backend: the older caller must hear failure, not success.
it('rejects an older superseded save when the save that superseded it fails for good', async () => {
  const write = vi.fn().mockRejectedValue(new Error('locked'))
  const queue = createSaveQueue(write, { delays: [1000, 4000, 15000] })
  const first = queue.save({ league: 'B' })
  const firstOutcome = first.then(() => 'resolved', e => e.message)
  await settle()
  const second = queue.save({ league: 'C' })
  const secondOutcome = second.then(() => 'resolved', e => e.message)
  await advance(25000)
  expect(await secondOutcome).toBe('locked')
  expect(await firstOutcome).toBe('locked')
})
