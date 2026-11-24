import { it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import RecipesView from '../../src/components/RecipesView.jsx'
import SettingsView from '../../src/components/SettingsView.jsx'
import TradingSettings from '../../src/components/TradingSettings.jsx'
import { api, bus } from '../../src/lib/api.js'
import { installApiMock } from './setup.js'

it('keeps recipes and settings in their loading views when the initial reads reject', async () => {
  installApiMock()
  const debug = vi.spyOn(console, 'debug')
  vi.spyOn(api, 'recipes').mockRejectedValue(new Error('read failed'))
  vi.spyOn(api, 'settings').mockRejectedValue(new Error('read failed'))
  const recipes = render(<RecipesView />)
  render(<SettingsView />)
  await act(async () => {})
  expect(screen.getByText('Loading recipes…')).toBeTruthy()
  expect(screen.getByText('Loading settings…')).toBeTruthy()
  expect(debug).toHaveBeenCalledWith('[Arbiter]', 'load recipes')
  expect(debug).toHaveBeenCalledWith('[Arbiter]', 'load settings editor')
  recipes.unmount()
})

it('keeps workspace import and hotkey failures in the local console', async () => {
  const debug = vi.spyOn(console, 'debug')
  const event = vi.fn()
  const off = bus.on(event)
  const previous = window.poe2desktop.hotkey
  window.poe2desktop.hotkey = {
    get: vi.fn(async () => ({ combo: 'Control+H' })),
    set: vi.fn().mockRejectedValue(new Error('registration failed')),
  }
  try {
    render(<TradingSettings />)
    await act(async () => {})
    const current = screen.getByRole('button', { name: 'Focus hotkey' })
    expect(current.textContent).toBe('Control+H')
    const file = { text: vi.fn().mockRejectedValue(new Error('read failed')) }
    fireEvent.change(screen.getByLabelText('Import searches file'), { target: { files: [file] } })
    fireEvent.click(current)
    fireEvent.keyDown(current, { key: 'k', ctrlKey: true })
    await act(async () => {})
    expect(file.text).toHaveBeenCalledTimes(1)
    expect(window.poe2desktop.hotkey.set).toHaveBeenCalledWith('CommandOrControl+K')
    expect(current.textContent).toBe('Control+H')
    expect(event).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledWith('[Arbiter]', 'read workspace import')
    expect(debug).toHaveBeenCalledWith('[Arbiter]', 'register focus hotkey')
  } finally {
    window.poe2desktop.hotkey = previous
    off()
  }
})
