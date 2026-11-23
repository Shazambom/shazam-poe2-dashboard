import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import App from '../../src/App.jsx'
import ArbitrageAlgorithm from '../../src/components/ArbitrageAlgorithm.jsx'
import GoldValueSlider from '../../src/components/GoldValueSlider.jsx'
import ModsView from '../../src/components/ModsView.jsx'
import RecipesView from '../../src/components/RecipesView.jsx'
import RegexView from '../../src/components/RegexView.jsx'
import RoutesView from '../../src/components/RoutesView.jsx'
import SettingsView from '../../src/components/SettingsView.jsx'
import StashView from '../../src/components/StashView.jsx'
import { api, bus } from '../../src/lib/api.js'
import { useAutosave } from '../../src/lib/hooks.js'
import { useStatus } from '../../src/lib/statusStore.js'
import { refreshTweaks } from '../../src/lib/tweaks.js'
import { installApiMock } from './setup.js'

const settle = () => act(async () => {})
const advance = ms => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const change = (input, value) => fireEvent.change(input, { target: { value } })
const events = vi.fn()
let unsubscribe
beforeEach(() => {
  vi.useFakeTimers()
  installApiMock()
  useStatus.setState({ settings: null })
  refreshTweaks({ tweaks: true })
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} })
  unsubscribe = bus.on(events.mockClear())
})
afterEach(() => { unsubscribe(); vi.unstubAllGlobals(); vi.useRealTimers() })

it.each([
  ['algorithm', ArbitrageAlgorithm, 'max_steps', () => change(screen.getAllByRole('slider')[0], '4')],
  ['gold value', GoldValueSlider, 'gold_value_per_1k', () => change(screen.getByRole('slider'), '6')],
  ['regex', RegexView, 'regex_tools', () => fireEvent.click(document.querySelector('.rx-row[role="option"]'))],
  ['mods', ModsView, 'mods_tools', () => change(screen.getAllByRole('spinbutton')[0], '77')],
  ['settings', SettingsView, 'allow_recipe_edges', () => fireEvent.click(screen.getByRole('switch', { name: 'Use recipe steps' }))],
  ['route filters', RoutesView, 'filters', () => change(screen.getByLabelText('Minimum margin %'), '7')],
  ['recipes', RecipesView, 'recipes', () => fireEvent.click(screen.getByRole('button', { name: 'Add recipe' }))],
])('%s: retries an unmounted editor’s failed PUT without adding anything on screen', async (_name, View, key, edit) => {
  const put = vi.spyOn(api, key === 'recipes' ? 'putRecipes' : 'putSettings').mockRejectedValueOnce(new Error('locked')).mockImplementation(async value => value)
  const view = render(<View />)
  await settle()
  edit()
  view.unmount()
  await settle()
  expect(put).toHaveBeenCalledTimes(1)
  const [sent] = put.mock.calls[0]
  expect(key === 'recipes' ? sent.length === 1 : Object.hasOwn(sent, key)).toBe(true)
  await advance(1000)
  expect(put.mock.calls).toEqual([[sent], [sent]])
  expect(view.container.innerHTML).toBe('')
  expect(events).not.toHaveBeenCalled()
})

it('retries a silently failed preset without a new label or toast', async () => {
  vi.spyOn(api, 'arbitragePresets').mockResolvedValue([{ id: 'p', label: 'Pick me', values: { max_steps: 4 } }])
  const put = vi.spyOn(api, 'putSettings').mockRejectedValueOnce(new Error('locked')).mockResolvedValue({ max_steps: 4 })
  const view = render(<RoutesView />)
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Pick me' }))
  await settle()
  const before = view.container.textContent
  await advance(1000)
  expect(put.mock.calls).toEqual([[{ max_steps: 4 }], [{ max_steps: 4 }]])
  expect(view.container.textContent).toBe(before)
  expect(events).not.toHaveBeenCalled()
})

it('keeps the existing mounted error toast on the first failure, not on each retry', async () => {
  vi.spyOn(api, 'putRecipes').mockRejectedValue(new Error('locked'))
  const view = render(<RecipesView />)
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Add recipe' }))
  await advance(800)
  expect(events).toHaveBeenCalledTimes(1)
  expect(events.mock.calls[0][0].text).toBe('locked')
  const before = view.container.innerHTML
  await advance(20000)
  expect(events).toHaveBeenCalledTimes(1)
  expect(view.container.innerHTML).toBe(before)
  vi.mocked(api.putRecipes).mockImplementation(async list => list)
  fireEvent.click(screen.getByRole('button', { name: 'Add recipe' }))
  await advance(800)
})

it('retains a failed generic payload until the next explicit flush', async () => {
  const put = vi.fn().mockRejectedValueOnce(new Error('locked')).mockResolvedValue(true)
  const { result, unmount } = renderHook(() => useAutosave(put))
  act(() => { result.current.arm(); result.current.save('draft') })
  unmount()
  await settle()
  expect(await result.current.flush()).toBe(true)
  expect(put.mock.calls).toEqual([['draft'], ['draft']])
  expect(document.body.textContent).toBe('')
  expect(events).not.toHaveBeenCalled()
})

it('serializes a newer setting behind an in-flight retry, never replaying the older value', async () => {
  const retry = Promise.withResolvers()
  const put = vi.spyOn(api, 'putSettings').mockRejectedValueOnce(new Error('locked')).mockReturnValueOnce(retry.promise).mockImplementation(async patch => patch)
  const { saveSettings } = useStatus.getState()
  await expect(saveSettings({ theme: 'old' })).rejects.toThrow('locked')
  await advance(1000)
  const latest = saveSettings({ theme: 'new' })
  await settle()
  expect(put.mock.calls).toEqual([[{ theme: 'old' }], [{ theme: 'old' }]])
  retry.resolve({ theme: 'old' })
  await latest
  await advance(60000)
  expect(put.mock.calls.at(-1)).toEqual([{ theme: 'new' }])
  expect(document.body.textContent).toBe('')
  expect(events).not.toHaveBeenCalled()
})

it('App quit carries the failed setting and a capital edit made 100 ms before quit', async () => {
  const bridge = window.poe2desktop.ws
  const onFlush = vi.spyOn(bridge, 'onFlush')
  const flushed = vi.spyOn(bridge, 'flushed')
  const settings = vi.spyOn(api, 'putSettings').mockRejectedValueOnce(new Error('locked')).mockImplementation(async patch => patch)
  const capital = vi.spyOn(api, 'putCapital')
  vi.useRealTimers()
  render(<App />)
  await settle()
  fireEvent.click(screen.getByRole('tab', { name: /^Stash/ }))
  const input = await screen.findByLabelText('Divine Orb held')
  vi.useFakeTimers()
  await expect(useStatus.getState().saveSettings({ stash_unit: 'exalted' })).rejects.toThrow('locked')
  change(input, '25')
  await advance(100)
  expect(capital).not.toHaveBeenCalled()
  const before = document.body.textContent
  await act(async () => onFlush.mock.calls.at(-1)[0]())
  expect(flushed).toHaveBeenCalledTimes(1)
  expect(settings.mock.calls).toEqual([[{ stash_unit: 'exalted' }], [{ stash_unit: 'exalted' }]])
  expect(capital.mock.calls[0][0].divine).toBe(25)
  expect(document.body.textContent.replace('saved ✓', '')).toBe(before.replace('saving…', ''))
  expect(events).not.toHaveBeenCalled()
})

it('leaves failed capital with the existing recount recovery on remount', async () => {
  await useStatus.getState().refresh()
  const put = vi.spyOn(api, 'putCapital').mockRejectedValueOnce(new Error('locked'))
  const first = render(<StashView />)
  await settle()
  change(screen.getByLabelText('Divine Orb held'), '23')
  first.unmount()
  await settle()
  expect(events.mock.calls).toEqual([[{ text: 'locked', ok: false }]])
  render(<StashView />)
  await settle()
  expect(screen.getByLabelText('Divine Orb held').value).toBe('23')
  await advance(700)
  expect(put.mock.calls.map(([entries, counted]) => [entries.divine, counted])).toEqual([[23, ['divine']], [23, ['divine']]])
  expect(first.container.innerHTML).toBe('')
  expect(events).toHaveBeenCalledTimes(1)
})

it('signals quit inside main’s second even when a settings PUT never settles', async () => {
  const bridge = window.poe2desktop.ws
  const onFlush = vi.spyOn(bridge, 'onFlush')
  const flushed = vi.spyOn(bridge, 'flushed')
  const put = Promise.withResolvers()
  vi.spyOn(api, 'putSettings').mockReturnValue(put.promise)
  render(<App />)
  await settle()
  const write = useStatus.getState().saveSettings({ hold_caution: 2 })
  await act(async () => onFlush.mock.calls.at(-1)[0]())
  expect(flushed).not.toHaveBeenCalled()
  await advance(999)
  expect(flushed).toHaveBeenCalledTimes(1)
  await act(async () => { put.resolve({ hold_caution: 2 }); await write })
  expect(events).not.toHaveBeenCalled()
})
