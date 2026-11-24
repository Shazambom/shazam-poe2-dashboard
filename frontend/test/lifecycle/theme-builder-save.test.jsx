import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ThemeBuilder from '../../src/components/ThemeBuilder.jsx'
import { api } from '../../src/lib/api.js'
import { flushForQuit } from '../../src/lib/quitFlush.js'
import { useStatus } from '../../src/lib/statusStore.js'
import { derive } from '../../src/lib/themeDerive.js'
import { DEFAULT_THEME, useTheme } from '../../src/lib/themeStore.js'
import { installApiMock } from './setup.js'

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const advance = ms => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

const sampleColors = (gold = '#c89b3c') => derive({
  '--bg': '#0e1014',
  '--panel': '#151820',
  '--ink': '#eef1f6',
  '--gold': gold,
  '--gain': '#4ade80',
  '--loss': '#f87171',
  '--live': '#60a5fa',
  '--digest': '#c084fc',
})

const themeA = () => ({ id: 'custom-aaaaaaaa', name: 'Alpha', base: 'vault', colors: sampleColors('#c89b3c') })
const themeB = () => ({ id: 'custom-bbbbbbbb', name: 'Beta', base: 'ash', colors: sampleColors('#e05a47') })

async function mountBuilder(initialThemes) {
  useTheme.setState({ id: DEFAULT_THEME, customs: initialThemes, previewing: false })
  const view = render(<ThemeBuilder />)
  const createBtn = screen.getByRole('button', { name: /^Create$/i })
  await waitFor(() => { expect(createBtn.disabled).toBe(false) })
  vi.useFakeTimers()
  return view
}

beforeEach(() => {
  installApiMock()
  useStatus.setState({ settings: { theme: DEFAULT_THEME, custom_themes: [] } })
  useTheme.setState({ id: DEFAULT_THEME, customs: [], previewing: false })
})

afterEach(() => {
  cleanup()
  useTheme.setState({ id: DEFAULT_THEME, customs: [], previewing: false })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('preserves both A edit and the duplicate when duplicating within 800 ms', async () => {
  const put = vi.spyOn(api, 'putSettings').mockImplementation(async patch => patch)
  await mountBuilder([themeA()])

  fireEvent.click(screen.getByRole('button', { name: 'Alpha' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Alpha Edited' } })
  await advance(200)

  const row = screen.getByLabelText('Actions for Alpha')
  fireEvent.click(within(row).getByRole('button', { name: 'Duplicate' }))
  await advance(1000)
  await settle()

  const saved = put.mock.calls.at(-1)[0].custom_themes
  expect(saved.map(t => t.name)).toEqual(['Alpha Edited', 'Alpha Edited copy'])
  expect(useTheme.getState().customs.map(t => t.name)).toEqual(['Alpha Edited', 'Alpha Edited copy'])
})

it('preserves both A edit and a newly created theme when clicking Create within 800 ms', async () => {
  const put = vi.spyOn(api, 'putSettings').mockImplementation(async patch => patch)
  await mountBuilder([themeA()])

  fireEvent.click(screen.getByRole('button', { name: 'Alpha' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Alpha Edited' } })
  await advance(200)

  fireEvent.click(screen.getByRole('button', { name: /^Create$/i }))
  await advance(1000)
  await settle()

  const saved = put.mock.calls.at(-1)[0].custom_themes
  expect(saved.map(t => t.name)).toEqual(['Alpha Edited', 'Vault copy'])
  expect(useTheme.getState().customs.map(t => t.name)).toEqual(['Alpha Edited', 'Vault copy'])
})

it('flushes A edit when deleting theme B within 800 ms, and cancels when deleting A itself', async () => {
  const put = vi.spyOn(api, 'putSettings').mockImplementation(async patch => patch)
  vi.stubGlobal('confirm', vi.fn(() => true))
  await mountBuilder([themeA(), themeB()])

  fireEvent.click(screen.getByRole('button', { name: 'Alpha' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Alpha Edited' } })
  await advance(200)

  const rowB = screen.getByLabelText('Actions for Beta')
  fireEvent.click(within(rowB).getByRole('button', { name: 'Delete' }))
  await advance(1000)
  await settle()

  const afterDeleteB = put.mock.calls.at(-1)[0].custom_themes
  expect(afterDeleteB.map(t => t.name)).toEqual(['Alpha Edited'])
  expect(useTheme.getState().customs.map(t => t.name)).toEqual(['Alpha Edited'])

  // Editing A and then deleting A itself cancels the pending edit rather than resurrecting A.
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Alpha About To Delete' } })
  await advance(200)
  const rowA = screen.getByLabelText('Actions for Alpha Edited')
  fireEvent.click(within(rowA).getByRole('button', { name: 'Delete' }))
  await advance(1000)
  await settle()

  expect(put.mock.calls.at(-1)[0].custom_themes).toEqual([])
  expect(useTheme.getState().customs).toEqual([])
})

it('flushes A edit on unmount within 800 ms without firing a second save later', async () => {
  const put = vi.spyOn(api, 'putSettings').mockImplementation(async patch => patch)
  const view = await mountBuilder([themeA()])

  fireEvent.click(screen.getByRole('button', { name: 'Alpha' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Alpha Unmount' } })
  await advance(200)
  expect(put).not.toHaveBeenCalled()

  view.unmount()
  await settle()
  expect(put).toHaveBeenCalledTimes(1)
  expect(put.mock.calls[0][0].custom_themes.map(t => t.name)).toEqual(['Alpha Unmount'])

  await advance(1000)
  expect(put).toHaveBeenCalledTimes(1)
})

it('flushes A edit on quit within 800 ms', async () => {
  const deferred = Promise.withResolvers()
  const put = vi.spyOn(api, 'putSettings').mockReturnValueOnce(deferred.promise)
  await mountBuilder([themeA()])

  fireEvent.click(screen.getByRole('button', { name: 'Alpha' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Alpha Quit' } })
  await advance(200)
  expect(put).not.toHaveBeenCalled()

  let done = false
  const flushing = flushForQuit().then(ok => { done = ok; return ok })
  await settle()

  expect(put).toHaveBeenCalledTimes(1)
  expect(put.mock.calls[0][0].custom_themes.map(t => t.name)).toEqual(['Alpha Quit'])
  expect(done).toBe(false)

  deferred.resolve({ custom_themes: put.mock.calls[0][0].custom_themes })
  expect(await act(async () => flushing)).toBe(true)

  // Also: edit A, click Create within 800 ms, then quit immediately -> both A's edit and the new theme survive.
  put.mockImplementation(async patch => patch)
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Alpha Before Create Quit' } })
  await advance(100)
  fireEvent.click(screen.getByRole('button', { name: /^Create$/i }))
  expect(await act(async () => flushForQuit())).toBe(true)
  expect(put.mock.calls.at(-1)[0].custom_themes.map(t => t.name)).toEqual(['Alpha Before Create Quit', 'Vault copy'])
})
