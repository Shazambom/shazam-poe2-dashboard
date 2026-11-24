import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import BoardView from '../../src/components/BoardView.jsx'
import CautionSlider from '../../src/components/CautionSlider.jsx'
import SettingsView from '../../src/components/SettingsView.jsx'
import ThemeBuilder from '../../src/components/ThemeBuilder.jsx'
import { api, bus } from '../../src/lib/api.js'
import { flushForQuit } from '../../src/lib/quitFlush.js'
import { useStatus } from '../../src/lib/statusStore.js'
import { refreshTweaks } from '../../src/lib/tweaks.js'
import GoldValueSlider from '../../src/components/GoldValueSlider.jsx'
import StashView from '../../src/components/StashView.jsx'
import { installApiMock } from './setup.js'

const settle = () => act(async () => {})
const advance = ms => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const events = vi.fn()
let off
beforeEach(() => {
  vi.useFakeTimers()
  installApiMock()
  off = bus.on(events.mockClear())
  refreshTweaks({ tweaks: true })
})
afterEach(() => { off(); vi.useRealTimers() })

it('flushes a caution drag before its timer and retries a failed quit write without a toast', async () => {
  const write = vi.spyOn(api, 'putSettings').mockRejectedValueOnce(new Error('locked')).mockImplementation(async patch => patch)
  render(<CautionSlider value={2} />)
  await settle()
  fireEvent.change(screen.getByRole('slider'), { target: { value: '3' } })
  await advance(100)
  const before = document.body.innerHTML
  const quit = flushForQuit()
  await advance(101)
  expect(await quit).toBe(true)
  expect(write.mock.calls).toEqual([[{ hold_caution: 3 }], [{ hold_caution: 3 }]])
  expect(document.body.innerHTML).toBe(before)
  expect(events).not.toHaveBeenCalled()
})

it('flushes a theme name without waiting for the builder’s debounce', async () => {
  vi.useRealTimers()
  const write = vi.spyOn(api, 'putSettings').mockImplementation(async patch => patch)
  render(<ThemeBuilder />)
  await act(async () => { await vi.dynamicImportSettled() })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  const name = await screen.findByLabelText('Name')
  vi.useFakeTimers()
  fireEvent.change(name, { target: { value: 'Quit draft' } })
  await advance(100)
  await act(async () => { expect(await flushForQuit()).toBe(true) })
  expect(write.mock.calls.at(-1)[0].custom_themes.at(-1).name).toBe('Quit draft')
  expect(name.value).toBe('Quit draft')
  expect(events).not.toHaveBeenCalled()
})

it('recovers a failed currency link but only shows the original first-attempt toast', async () => {
  const map = vi.spyOn(api, 'mapCurrency').mockRejectedValueOnce(new Error('locked')).mockResolvedValue({ ok: true })
  render(<SettingsView currencies={{ unmapped_metadata_ids: ['meta'], currencies: [] }} />)
  await settle()
  fireEvent.change(screen.getByLabelText('Trade currency for meta'), { target: { value: 'chaos' } })
  fireEvent.click(screen.getByRole('button', { name: 'Link', hidden: true }))
  await settle()
  expect(events).not.toHaveBeenCalled()
  const before = document.body.textContent
  await advance(1000)
  expect(map.mock.calls).toEqual([['meta', 'chaos'], ['meta', 'chaos']])
  expect(events.mock.calls).toEqual([[{ text: 'Linked', ok: true }]])
  expect(document.body.textContent).toBe(before)
})

it('bases a second board removal on the retained watchlist after a failed first removal', async () => {
  useStatus.setState({ settings: { watchlist: ['divine', 'chaos'] } })
  const write = vi.spyOn(api, 'putSettings').mockRejectedValueOnce(new Error('locked')).mockImplementation(async patch => patch)
  render(<BoardView />)
  await settle()
  const buttons = screen.getAllByTitle('Remove from board')
  fireEvent.click(buttons[0])
  await settle()
  expect(events).not.toHaveBeenCalled()
  fireEvent.click(buttons[1])
  await advance(1000)
  expect(write.mock.calls.at(-1)).toEqual([{ watchlist: [] }])
  expect(events).not.toHaveBeenCalled()
})

it('keeps independent stash switches and carries them after bounded retries are spent', async () => {
  const write = vi.spyOn(api, 'putSettings').mockRejectedValue(new Error('locked'))
  const { saveSettings } = useStatus.getState()
  useStatus.setState({ settings: { stash_counted: { chaos: true } } })
  const failed = saveSettings({ stash_counted: { divine: false } })
  const outcome = failed.then(() => 'resolved', e => e.message)
  await advance(60000)
  expect(await outcome).toBe('locked')
  expect(write).toHaveBeenCalledTimes(4)
  const shown = useStatus.getState().settings.stash_counted
  write.mockImplementation(async patch => patch)
  await saveSettings({ stash_counted: { exalted: true } })
  expect(shown).toEqual({ chaos: true })
  expect(write.mock.calls.at(-1)).toEqual([{ stash_counted: { exalted: true } }])
  expect(document.body.textContent).toBe('')
  expect(events).not.toHaveBeenCalled()
})

it('flushes an already failed slider write on unmount without repeating its toast', async () => {
  const write = vi.spyOn(api, 'putSettings').mockRejectedValueOnce(new Error('locked')).mockImplementation(async patch => patch)
  const view = render(<GoldValueSlider />)
  await settle()
  fireEvent.change(screen.getByRole('slider'), { target: { value: '6' } })
  await advance(800)
  expect(events).not.toHaveBeenCalled()
  view.unmount()
  await settle()
  expect(write.mock.calls).toEqual([[{ gold_value_per_1k: 0.001 }]])
  await advance(1000)
  expect(write.mock.calls).toEqual([[{ gold_value_per_1k: 0.001 }], [{ gold_value_per_1k: 0.001 }]])
  expect(view.container.innerHTML).toBe('')
  expect(events).not.toHaveBeenCalled()

  // When all retries are exhausted while mounted, the error toast fires once after exhaustion.
  write.mockRejectedValue(new Error('locked'))
  const mounted = render(<GoldValueSlider />)
  await settle()
  fireEvent.change(screen.getByRole('slider'), { target: { value: '5' } })
  await advance(800)
  expect(events).not.toHaveBeenCalled()
  await advance(25000)
  expect(events.mock.calls).toEqual([[{ text: 'locked', ok: false }]])
  mounted.unmount()
})

it('quit recovers a failed detached capital edit from the latest holdings without remounting Stash', async () => {
  await useStatus.getState().refresh()
  const put = vi.spyOn(api, 'putCapital').mockRejectedValueOnce(new Error('locked'))
  const stash = render(<StashView />)
  await settle()
  fireEvent.change(screen.getByLabelText('Divine Orb held'), { target: { value: '25' } })
  stash.unmount()
  await settle()
  expect(events.mock.calls).toEqual([[{ text: 'locked', ok: false }]])
  const capital = useStatus.getState().capital
  useStatus.setState({ capital: { ...capital, rows: [...capital.rows, { currency: 'chaos', qty: 52 }] }, salesFetching: true })
  const quit = flushForQuit()
  await advance(90)
  expect(put).toHaveBeenCalledTimes(1)
  useStatus.setState({ salesFetching: false })
  await advance(20)
  expect(await quit).toBe(true)
  expect(put.mock.calls.at(-1)).toEqual([{ divine: 25, exalted: 500, chaos: 52 }, ['divine']])
  expect(events).toHaveBeenCalledTimes(1)
  expect(stash.container.innerHTML).toBe('')
})
