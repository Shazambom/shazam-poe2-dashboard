// Recovery from the operations that used to fail silently (operation-failures.test.jsx covers their local
// diagnostics): each test makes the operation fail and asserts the app recovers on its own, and that
// nothing new appears on screen (no toast on the bus, no new text) while it does.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import RecipesView from '../../src/components/RecipesView.jsx'
import SettingsView from '../../src/components/SettingsView.jsx'
import CautionSlider from '../../src/components/CautionSlider.jsx'
import NotificationsPanel from '../../src/components/NotificationsPanel.jsx'
import AccountsPanel from '../../src/components/AccountsPanel.jsx'
import { useStatus } from '../../src/lib/statusStore.js'
import { saveHistoryPrefs } from '../../src/lib/ee2History.js'
import { useWorkspace } from '../../src/lib/workspaceStore.js'
import { useTheme } from '../../src/lib/themeStore.js'
import { api, bus } from '../../src/lib/api.js'
import { installApiMock, jsonResponse } from './setup.js'

let toasts
let offBus
beforeEach(() => {
  vi.useFakeTimers()
  toasts = vi.fn()
  offBus = bus.on(toasts)
})
afterEach(() => {
  offBus()
  vi.useRealTimers()
})

const settle = () => act(async () => {})
const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const fail = () => Promise.reject(new Error('backend unavailable'))

it('recipes: a failed load stays on its loading view, is retried, and fills the view when a retry succeeds', async () => {
  installApiMock()
  const recipe = { id: 'r1', name: 'Shard combine', kind: 'combine', inputs: { shard: 10 }, outputs: { orb: 1 }, enabled: true, note: '' }
  const load = vi.spyOn(api, 'recipes').mockImplementationOnce(fail).mockImplementationOnce(fail).mockResolvedValue([recipe])
  const put = vi.spyOn(api, 'putRecipes').mockImplementation(async (l) => l)
  const view = render(<RecipesView embedded />)
  await settle()
  expect(load).toHaveBeenCalledTimes(1)
  expect(view.container.textContent).toBe('Loading recipes…')
  await advance(1000)
  expect(load).toHaveBeenCalledTimes(2)
  expect(view.container.textContent).toBe('Loading recipes…')
  await advance(4000)
  expect(load).toHaveBeenCalledTimes(3)
  const name = screen.getByLabelText('Recipe name')
  expect(name.value).toBe('Shard combine')
  // Fully initialised, not half: the editor saves edits.
  fireEvent.change(name, { target: { value: 'Shard combine x' } })
  await advance(800)
  expect(put).toHaveBeenCalledTimes(1)
  expect(toasts).not.toHaveBeenCalled()
})

it('recipes: retries are bounded, and stop when the view goes away', async () => {
  installApiMock()
  const load = vi.spyOn(api, 'recipes').mockImplementation(fail)
  const view = render(<RecipesView embedded />)
  await settle()
  await advance(1000 + 4000 + 15000)
  expect(load).toHaveBeenCalledTimes(4)
  await advance(60000)
  expect(load).toHaveBeenCalledTimes(4)
  expect(view.container.textContent).toBe('Loading recipes…')
  view.unmount()

  load.mockClear()
  const again = render(<RecipesView embedded />)
  await settle()
  again.unmount()
  await advance(60000)
  expect(load).toHaveBeenCalledTimes(1)
  expect(toasts).not.toHaveBeenCalled()
})

it('settings: a failed load stays on its loading view and fills the editor when a retry succeeds', async () => {
  installApiMock()
  let down = true
  const real = api.settings
  vi.spyOn(api, 'settings').mockImplementation(() => (down ? fail() : real()))
  const view = render(<SettingsView />)
  await settle()
  expect(view.container.textContent).toBe('Loading settings…')
  await advance(1000)
  expect(view.container.textContent).toBe('Loading settings…')
  down = false
  await advance(4000)
  expect(screen.getByLabelText('Reference currency for values')).toBeTruthy()
  expect(screen.queryByText('Loading settings…')).toBeNull()
  expect(toasts).not.toHaveBeenCalled()
})

// A settings PUT that fails while `down.on`; returns the patches it was sent, in order.
function settingsBackend(down) {
  const sent = []
  installApiMock({
    'PUT /api/settings': (_url, _init, body) => {
      sent.push(body.patch)
      return down.on ? jsonResponse({ detail: 'database is locked' }, 500) : jsonResponse({ ...body.patch })
    },
  })
  return sent
}

it('caution: a failed save keeps the user\'s value and is retried until it lands', async () => {
  const down = { on: true }
  const sent = settingsBackend(down)
  const view = render(<CautionSlider value={2} range={[0, 6]} />)
  await settle()
  const before = view.container.innerHTML.replace(/value="[^"]*"/, '').replace(/<b>[^<]*<\/b>/, '')
  fireEvent.change(screen.getByRole('slider'), { target: { value: '3.5' } })
  await advance(350)
  expect(sent).toEqual([{ hold_caution: 3.5 }])
  expect(screen.getByText('3.5')).toBeTruthy()
  expect(useStatus.getState().settings.hold_caution).toBe(3.5)
  await advance(1000)
  expect(sent).toHaveLength(2)
  down.on = false
  await advance(4000)
  expect(sent).toEqual([{ hold_caution: 3.5 }, { hold_caution: 3.5 }, { hold_caution: 3.5 }])
  await advance(60000)
  expect(sent).toHaveLength(3)
  expect(screen.getByText('3.5')).toBeTruthy()
  expect(useStatus.getState().settings.hold_caution).toBe(3.5)
  // Nothing new on screen: the same markup, only the value moved.
  expect(view.container.innerHTML.replace(/value="[^"]*"/, '').replace(/<b>[^<]*<\/b>/, '')).toBe(before)
  expect(toasts).not.toHaveBeenCalled()
})

it('caution: a newer value cuts the wait short and the older one is never sent after it', async () => {
  const down = { on: true }
  const sent = settingsBackend(down)
  render(<CautionSlider value={2} range={[0, 6]} />)
  await settle()
  fireEvent.change(screen.getByRole('slider'), { target: { value: '3' } })
  await advance(350)
  down.on = false
  fireEvent.change(screen.getByRole('slider'), { target: { value: '4' } })
  await advance(350)
  expect(sent).toEqual([{ hold_caution: 3 }, { hold_caution: 4 }])
  await advance(60000)
  expect(sent).toHaveLength(2)
  expect(useStatus.getState().settings.hold_caution).toBe(4)
})

it('caution: retries are bounded; the kept value goes out with the next change', async () => {
  const down = { on: true }
  const sent = settingsBackend(down)
  render(<CautionSlider value={2} range={[0, 6]} />)
  await settle()
  fireEvent.change(screen.getByRole('slider'), { target: { value: '5' } })
  await advance(350)
  await advance(1000 + 4000 + 15000)
  expect(sent).toHaveLength(4)
  await advance(120000)
  expect(sent).toHaveLength(4)
  expect(screen.getByText('5.0')).toBeTruthy()
  down.on = false
  fireEvent.change(screen.getByRole('slider'), { target: { value: '5.5' } })
  await advance(350)
  expect(sent.at(-1)).toEqual({ hold_caution: 5.5 })
  expect(toasts).not.toHaveBeenCalled()
})

it('notifications: a failed save keeps the switch where the user put it and is retried until it lands', async () => {
  const down = { on: true }
  const sent = settingsBackend(down)
  const view = render(<NotificationsPanel />)
  await settle()
  const banner = () => screen.getAllByRole('switch')[0]
  const was = banner().getAttribute('aria-checked') === 'true'
  const before = view.container.textContent
  fireEvent.click(banner())
  await settle()
  expect(sent).toHaveLength(1)
  expect(sent[0].notifications.live.banner).toBe(!was)
  await advance(1000)
  expect(sent).toHaveLength(2)
  expect(banner().getAttribute('aria-checked')).toBe(String(!was))
  expect(useStatus.getState().settings.notifications.live.banner).toBe(!was)
  down.on = false
  await advance(4000)
  expect(sent).toHaveLength(3)
  expect(sent[2].notifications.live.banner).toBe(!was)
  await advance(60000)
  expect(sent).toHaveLength(3)
  expect(banner().getAttribute('aria-checked')).toBe(String(!was))
  expect(view.container.textContent).toBe(before)
  expect(toasts).not.toHaveBeenCalled()
})

it('EE2 history: a failed save keeps the preference in effect and is retried until it lands', async () => {
  const down = { on: true }
  const sent = settingsBackend(down)
  const saved = saveHistoryPrefs({ waystoneStats: false })
  await settle()
  expect(sent).toHaveLength(1)
  expect(sent[0].ee2History.waystoneStats).toBe(false)
  expect(useWorkspace.getState().historyPrefs.waystoneStats).toBe(false)
  await advance(1000)
  expect(sent).toHaveLength(2)
  down.on = false
  await advance(4000)
  expect(sent).toHaveLength(3)
  expect(sent[2].ee2History.waystoneStats).toBe(false)
  expect((await saved).waystoneStats).toBe(false)
  await advance(60000)
  expect(sent).toHaveLength(3)
  expect(useWorkspace.getState().historyPrefs.waystoneStats).toBe(false)
  expect(toasts).not.toHaveBeenCalled()
})

it('theme: a failed save keeps the chosen theme painted, even across a settings load, and is retried until it lands', async () => {
  const down = { on: true }
  const sent = []
  installApiMock({
    'GET /api/settings': { league: 'Test League', reference: 'exalted', theme: 'ash', notifications: {} },
    'PUT /api/settings': (_url, _init, body) => {
      sent.push(body.patch)
      return down.on ? jsonResponse({ detail: 'database is locked' }, 500) : jsonResponse({ theme: 'ash', ...body.patch })
    },
  })
  useTheme.getState().apply('vaal')
  await settle()
  expect(sent).toEqual([{ theme: 'vaal' }])
  expect(document.documentElement.dataset.theme).toBe('vaal')
  await act(async () => { await useStatus.getState().loadSettings() })   // the saved blob still says 'ash'
  expect(document.documentElement.dataset.theme).toBe('vaal')
  expect(useTheme.getState().id).toBe('vaal')
  await advance(1000)
  expect(sent).toHaveLength(2)
  down.on = false
  await advance(4000)
  expect(sent).toEqual([{ theme: 'vaal' }, { theme: 'vaal' }, { theme: 'vaal' }])
  await advance(60000)
  expect(sent).toHaveLength(3)
  expect(document.documentElement.dataset.theme).toBe('vaal')
  expect(toasts).not.toHaveBeenCalled()
  useTheme.getState().apply('vault')
  await settle()
})

it('release channel: when the switch fails, it ends on the channel actually in effect, with no new message', async () => {
  installApiMock()
  const desk = window.poe2desktop
  let inEffect = { beta: false, locked: false, tweaks: false }
  const getChannel = vi.spyOn(desk, 'getChannel').mockImplementation(async () => inEffect)
  vi.spyOn(desk, 'setChannel').mockImplementation(async () => {
    inEffect = { beta: true, locked: false, tweaks: true }   // main switched, then the reply was lost
    throw new Error('reply was never sent')
  })
  render(<SettingsView />)
  await settle()
  const beta = screen.getByRole('switch', { name: /Beta updates/ })
  expect(beta.getAttribute('aria-checked')).toBe('false')
  const reads = getChannel.mock.calls.length
  fireEvent.click(beta)
  await settle()
  expect(getChannel.mock.calls.length).toBeGreaterThan(reads)
  expect(screen.getByRole('switch', { name: /Beta updates/ }).getAttribute('aria-checked')).toBe('true')

  // A switch that did not happen: the toggle stays on the channel in effect.
  const before = document.body.textContent
  vi.spyOn(desk, 'setChannel').mockRejectedValue(new Error('settings file locked'))
  fireEvent.click(screen.getByRole('switch', { name: /Beta updates/ }))
  await settle()
  expect(screen.getByRole('switch', { name: /Beta updates/ }).getAttribute('aria-checked')).toBe('true')
  expect(document.body.textContent).toBe(before)
  expect(toasts).not.toHaveBeenCalled()
})

it('login cookie: a failed mirror into the app session is retried in the background until it lands', async () => {
  installApiMock()
  vi.spyOn(api, 'connectSession').mockResolvedValue({ message: 'Connected as Exile' })
  const desk = window.poe2desktop
  const setCookie = vi.spyOn(desk, 'setCookie')
    .mockRejectedValueOnce(new Error('ipc closed'))
    .mockResolvedValueOnce({ ok: false, message: 'cookie store busy' })
    .mockResolvedValue({ ok: true })
  const view = render(<AccountsPanel />)
  await settle()
  fireEvent.change(screen.getByPlaceholderText('POESESSID'), { target: { value: 'abc123' } })
  fireEvent.click(screen.getByRole('button', { name: 'Use this cookie' }))
  await settle()
  expect(setCookie).toHaveBeenCalledTimes(1)
  expect(screen.getByText('Connected as Exile')).toBeTruthy()
  const after = view.container.textContent
  await advance(1000)
  expect(setCookie).toHaveBeenCalledTimes(2)
  await advance(4000)
  expect(setCookie).toHaveBeenCalledTimes(3)
  expect(setCookie.mock.calls.every(c => c[0] === 'abc123')).toBe(true)
  await advance(60000)
  expect(setCookie).toHaveBeenCalledTimes(3)
  expect(view.container.textContent).toBe(after)
  expect(toasts).not.toHaveBeenCalled()
})

it('login cookie: a pending mirror retry never overwrites a newer cookie', async () => {
  installApiMock()
  vi.spyOn(api, 'connectSession').mockResolvedValue({ message: 'Connected' })
  const setCookie = vi.spyOn(window.poe2desktop, 'setCookie').mockRejectedValueOnce(new Error('ipc closed')).mockResolvedValue({ ok: true })
  render(<AccountsPanel />)
  await settle()
  fireEvent.change(screen.getByPlaceholderText('POESESSID'), { target: { value: 'old' } })
  fireEvent.click(screen.getByRole('button', { name: 'Use this cookie' }))
  await settle()
  fireEvent.change(screen.getByPlaceholderText('POESESSID'), { target: { value: 'new' } })
  fireEvent.click(screen.getByRole('button', { name: 'Use this cookie' }))
  await settle()
  await advance(60000)
  expect(setCookie.mock.calls.map(c => c[0])).toEqual(['old', 'new'])
})
