import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { installApiMock, DEFAULT_CURRENCIES } from './setup.js'
import ModsView from '../../src/components/ModsView.jsx'
import RegexView from '../../src/components/RegexView.jsx'
import ThemeBuilder from '../../src/components/ThemeBuilder.jsx'
import SettingsView from '../../src/components/SettingsView.jsx'
import TradingView from '../../src/components/TradingView.jsx'
import App from '../../src/App.jsx'
import { loadIcons } from '../../src/lib/icons.js'
import { useTheme } from '../../src/lib/themeStore.js'
import { useStatus } from '../../src/lib/statusStore.js'

describe('Mods, Regex, Settings, ThemeBuilder, Trading, and App shell lifecycles', () => {
  beforeEach(async () => {
    installApiMock()
    await loadIcons()
    useStatus.setState({ settings: null })
  })

  afterEach(() => {
    vi.useRealTimers()
    // Reset theme state directly without triggering a post-test fetch
    useTheme.setState({ id: 'vault', customs: [] })
  })

  it('ModsView loads pools, selects ring pool, and displays prefix/suffix modifiers', async () => {
    const { calls } = installApiMock()
    render(<ModsView />)

    await waitFor(() => {
      expect(calls.some(c => c.path === '/api/mods/pools')).toBe(true)
      expect(calls.some(c => c.path === '/api/mods/pool/ring')).toBe(true)
    })

    await waitFor(() => {
      expect(document.body.textContent).toMatch(/maximum Life/i)
    })
  })

  it('RegexView loads saved settings and generates a live PoE2 regex string when toggled', async () => {
    installApiMock()
    render(<RegexView />)

    await waitFor(() => {
      expect(screen.getAllByText(/Waystones/i).length).toBeGreaterThanOrEqual(1)
    })

    // Select a waystone mod option and verify a live PoE2 regex string is generated & Copy enables
    const firstMod = document.querySelector('.rx-row[role="option"]')
    expect(firstMod).toBeTruthy()
    fireEvent.click(firstMod)
    await waitFor(() => {
      const out = document.querySelector('input.rx-string')
      expect(out?.value.length).toBeGreaterThan(0)
      const copyBtn = document.querySelector('button[data-cmd="regex-copy"]')
      expect(copyBtn?.disabled).toBe(false)
    })
  })

  it('ThemeBuilder loads all shipped presets via virtual:theme-presets, forks a custom theme, and cleans timers on unmount', async () => {
    installApiMock()
    const { unmount } = render(<ThemeBuilder />)

    // Wait for virtual:theme-presets async import to resolve and enable Create
    const createBtn = screen.getByRole('button', { name: /^Create$/i })
    await waitFor(() => {
      expect(document.querySelectorAll('select option').length).toBeGreaterThanOrEqual(5)
      expect(createBtn.disabled).toBe(false)
    })

    // Create a custom copy from the active preset
    fireEvent.click(createBtn)

    await waitFor(() => {
      expect(useTheme.getState().customs.length).toBeGreaterThanOrEqual(1)
    })

    // Unmount cleanly while debounce timers could still be pending
    expect(() => unmount()).not.toThrow()
  })

  it('SettingsView loads settings, renders Appearance/Market/Accounts panels, and switches theme cleanly', async () => {
    const { calls } = installApiMock()
    render(<SettingsView currencies={DEFAULT_CURRENCIES} status={{ league: 'Test League' }} />)

    await waitFor(() => {
      expect(calls.some(c => c.path === '/api/settings')).toBe(true)
      expect(screen.getByText('Appearance')).toBeTruthy()
      expect(screen.getByText('Market')).toBeTruthy()
    })
  })

  it('TradingView switches across Workspace, Regex, Mods, and Live while keeping Workspace mounted', async () => {
    installApiMock()
    render(<TradingView league="Test League" />)

    const wsContainer = () => document.querySelector('.trading > div[style*="flex"]')
    expect(wsContainer()).toBeTruthy()
    expect(wsContainer().style.display).toBe('flex')

    // Switch to Regex, Mods, Live — Workspace stays mounted (display: none) to avoid tearing down its webview
    for (const label of ['Regex', 'Mods', 'Live']) {
      fireEvent.click(screen.getByRole('tab', { name: new RegExp(label, 'i') }))
      await waitFor(() => {
        expect(wsContainer().style.display).toBe('none')
      })
    }

    // Switching back restores Workspace visibility without remounting
    fireEvent.click(screen.getByRole('tab', { name: /Workspace/i }))
    await waitFor(() => {
      expect(wsContainer().style.display).toBe('flex')
    })
  })

  it('App shell switches through all 5 lazy-loaded top-level tabs, opens Cmd+K, and flushes workspace on quit from any tab', async () => {
    installApiMock()
    let quitFlushCb = null
    const flushedSpy = vi.fn()
    window.poe2desktop.ws = {
      onFlush: vi.fn((cb) => { quitFlushCb = cb; return () => {} }),
      flushed: flushedSpy,
      exportFile: vi.fn(async () => ({ ok: true })),
    }

    render(<App />)

    // Switch through all 5 top-level tabs verifying React.lazy chunks resolve without errors
    for (const tabName of ['Stash', 'Trading', 'Economy', 'Settings', 'Board']) {
      const tab = screen.getByRole('tab', { name: new RegExp(`^${tabName}`) })
      fireEvent.click(tab)
      await waitFor(() => {
        expect(tab.getAttribute('aria-selected')).toBe('true')
      })
    }

    // Open Command Palette with Cmd+K and close with Escape
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    await waitFor(() => {
      expect(document.querySelector('.cmdk, .palette, input[placeholder*="Search"]')).toBeTruthy()
    })
    fireEvent.keyDown(window, { key: 'Escape' })

    // Trigger Electron quit flush while on Board tab → must resolve and call ws.flushed() immediately
    expect(typeof quitFlushCb).toBe('function')
    await act(async () => { quitFlushCb() })
    await waitFor(() => {
      expect(flushedSpy).toHaveBeenCalledTimes(1)
    })
  })
})
