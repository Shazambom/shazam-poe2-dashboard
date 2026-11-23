import { describe, it, test, expect, vi, beforeEach, afterEach } from 'vitest'
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
    const { calls } = installApiMock()
    const { rerender, unmount } = render(<RegexView />)

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
    const draft = document.querySelector('input.rx-string').value
    rerender(<RegexView />)
    expect(document.querySelector('input.rx-string').value).toBe(draft)
    expect(calls.filter(c => c.method === 'GET' && c.path === '/api/settings')).toHaveLength(1)
    unmount()
    await waitFor(() => expect(calls.filter(c => c.method === 'PUT' && c.path === '/api/settings')).toHaveLength(1))
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

    const name = await screen.findByLabelText('Name')
    const save = vi.spyOn(useTheme.getState(), 'saveCustoms')
    vi.useFakeTimers()
    fireEvent.change(name, { target: { value: 'Unsaved name' } })
    act(() => useTheme.setState(s => ({ customs: s.customs.map(t => ({ ...t, name: 'Stored name' })) })))
    expect(name.value).toBe('Unsaved name')
    expect(() => unmount()).not.toThrow()
    act(() => vi.advanceTimersByTime(1000))
    expect(save).not.toHaveBeenCalled()
  })

  it('SettingsView loads settings, renders Appearance/Market/Accounts panels, and switches theme cleanly', async () => {
    const { calls } = installApiMock()
    const { rerender, unmount } = render(<SettingsView currencies={DEFAULT_CURRENCIES} />)

    await waitFor(() => {
      expect(calls.some(c => c.path === '/api/settings')).toBe(true)
      expect(screen.getByText('Appearance')).toBeTruthy()
      expect(screen.getByText('Market')).toBeTruthy()
    })
    const reads = calls.filter(c => c.path === '/api/settings').length
    rerender(<SettingsView currencies={{ ...DEFAULT_CURRENCIES }} />)
    expect(calls.filter(c => c.path === '/api/settings')).toHaveLength(reads)
    unmount()
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(0)
  })

  it('reads the update channel once when settings opens', async () => {
    const getChannel = vi.spyOn(window.poe2desktop, 'getChannel')
    const { rerender, unmount } = render(<SettingsView />)
    await screen.findByText('Diagnostics')
    const reads = getChannel.mock.calls.length
    expect(reads).toBeGreaterThan(0)
    rerender(<SettingsView currencies={DEFAULT_CURRENCIES} />)
    unmount()
    expect(getChannel).toHaveBeenCalledTimes(reads)
  })

  test('it probes once the Diagnostics section is opened', async () => {
    const { calls } = installApiMock()
    const { unmount } = render(<SettingsView />)
    const details = (await screen.findByText('Diagnostics')).closest('details')
    expect(calls.filter(c => c.path === '/api/diag')).toHaveLength(0)
    details.open = true
    fireEvent(details, new Event('toggle'))
    await waitFor(() => expect(calls.filter(c => c.path === '/api/diag')).toHaveLength(1))
    details.open = false
    fireEvent(details, new Event('toggle'))
    details.open = true
    fireEvent(details, new Event('toggle'))
    unmount()
    expect(calls.filter(c => c.path === '/api/diag')).toHaveLength(1)
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

  it('opens an off-board currency by its display name in the app-wide card', async () => {
    const { calls } = installApiMock()
    render(<App />)
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const input = await screen.findByPlaceholderText('Search screens, actions, currencies…')
    fireEvent.change(input, { target: { value: 'Mirror of Kalandra' } })
    fireEvent.click(await screen.findByText('Mirror of Kalandra', { selector: '.cmdk-label' }))
    await waitFor(() => {
      const asset = calls.find(c => c.path === '/api/asset')
      expect(new URL(asset?.url || '/', 'http://localhost').searchParams.get('q')).toBe('Mirror of Kalandra')
      expect(document.querySelector('.card-detail')).toBeTruthy()
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
