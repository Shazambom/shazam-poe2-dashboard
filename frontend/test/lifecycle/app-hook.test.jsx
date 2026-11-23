import { it, expect } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../../src/App.jsx'
import { bus } from '../../src/lib/api.js'
import { useSignals } from '../../src/lib/signalStore.js'
import { installApiMock } from './setup.js'

it('opens the signaled currency once and releases the notification listener on unmount', async () => {
  const { calls } = installApiMock()
  const events = []
  const off = bus.on(event => { if (event.id === 'signals' && event.node) events.push(event) })
  try {
    const { rerender, unmount } = render(<App />)
    act(() => useSignals.setState({ lastNew: { at: 1, signals: [{ name: 'Chaos Orb' }] } }))
    await screen.findByText(/1 new market signal/)
    rerender(<App />)
    expect(events).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(calls.filter(c => c.path === '/api/asset')).toHaveLength(1))
    unmount()
    act(() => useSignals.setState({ lastNew: { at: 2, signals: [{ name: 'Divine Orb' }] } }))
    expect(events).toHaveLength(1)
  } finally {
    off()
    useSignals.setState({ lastNew: null })
  }
})

it('opens the Board before routing an OAuth callback to Settings and consumes its URL once', async () => {
  const { calls } = installApiMock()
  const original = window.location.href
  try {
    window.history.replaceState({}, '', '/?oauth=ok')
    const { rerender, unmount } = render(<App />)
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe('true'))
    expect(window.location.search).toBe('')
    const reads = () => calls.filter(c => c.path === '/api/board').length
    expect(reads()).toBeGreaterThan(0)
    const count = reads()
    rerender(<App />)
    expect(reads()).toBe(count)
    unmount()
  } finally {
    window.history.replaceState({}, '', original)
  }
})
