// Recovery from the operations that used to fail silently (operation-failures.test.jsx covers their local
// diagnostics): each test makes the operation fail and asserts the app recovers on its own, and that
// nothing new appears on screen (no toast on the bus, no new text) while it does.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import RecipesView from '../../src/components/RecipesView.jsx'
import { api, bus } from '../../src/lib/api.js'
import { installApiMock } from './setup.js'

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
