import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { installApiMock } from './setup.js'
import LiveView from '../../src/components/LiveView.jsx'
import PingButton from '../../src/components/PingButton.jsx'
import VaalPingOrb from '../../src/components/VaalPingOrb.jsx'
import { usePings } from '../../src/lib/pingStore.js'
import { useWorkspace } from '../../src/lib/workspaceStore.js'

function makePing(overrides = {}) {
  const now = Date.now()
  const uid = Math.random().toString(36).slice(2)
  return {
    pingId: `p-${uid}`,
    listingId: `l-${uid}`,
    itemId: 'search-1',
    item: { name: 'Divine Orb', typeLine: 'Currency' },
    price: { amount: 1, currency: 'divine' },
    online: 'online',
    token: 'tok-abc',
    tokenExp: now + 300_000,
    at: now,
    flags: {},
    ...overrides,
  }
}

describe('Trading → Live, PingButton, and VaalPingOrb lifecycles', () => {
  beforeEach(() => {
    installApiMock()
    usePings.getState().clear()
    useWorkspace.setState({ tree: [], loaded: true })
    window.poe2desktop.trade.teleport = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resets newest PingButton to enabled when a fresh ping arrives after an expired ping (Sol regression)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-21T18:00:00Z'))

    render(<LiveView league="Test League" />)
    expect(screen.getByText(/Press Go live on a search/i)).toBeTruthy()

    // 1. Push short-lived Divine Orb ping and let it expire.
    act(() => {
      usePings.getState().addPing(makePing({
        pingId: 'ping-divine',
        listingId: 'list-divine',
        item: { name: 'Divine Orb' },
        tokenExp: Date.now() + 2000,
      }))
    })

    let newestBtn = document.querySelector('.live-newest button.teleport')
    expect(newestBtn.textContent).toBe('Travel to hideout')
    expect(newestBtn.disabled).toBe(false)

    act(() => { vi.advanceTimersByTime(2500) })
    newestBtn = document.querySelector('.live-newest button.teleport')
    expect(newestBtn.textContent).toBe('Expired')
    expect(newestBtn.disabled).toBe(true)

    // 2. Without clearing, push a fresh Chaos Orb ping.
    act(() => {
      usePings.getState().addPing(makePing({
        pingId: 'ping-chaos',
        listingId: 'list-chaos',
        item: { name: 'Chaos Orb' },
        tokenExp: Date.now() + 120_000,
      }))
    })

    newestBtn = document.querySelector('.live-newest button.teleport')
    expect(document.querySelector('.live-newest .ping-name').textContent).toBe('Chaos Orb')
    expect(newestBtn.textContent).toBe('Travel to hideout')
    expect(newestBtn.disabled).toBe(false)

    // Previous Divine Orb ping moved to Recent and remains Expired & disabled.
    const recentBtn = document.querySelector('.live-recent button.teleport')
    expect(document.querySelector('.live-recent .ping-name').textContent).toBe('Divine Orb')
    expect(recentBtn.textContent).toBe('Expired')
    expect(recentBtn.disabled).toBe(true)
  })

  it('walks PingButton through sending → pending, gone, rateLimited → auto-reset, and stale timers', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-21T18:00:00Z'))

    // 1. Happy teleport: fresh → sending (double-click prevented) → pending (Sent ✓)
    let resolveTeleport
    window.poe2desktop.trade.teleport.mockImplementation(() => new Promise(r => { resolveTeleport = r }))

    const { rerender } = render(<PingButton ping={makePing({ pingId: 'p1', listingId: 'l1' })} />)
    const btn = () => screen.getByRole('button')
    expect(btn().textContent).toBe('Travel to hideout')

    fireEvent.click(btn())
    expect(btn().textContent).toBe('Travelling…')
    expect(btn().disabled).toBe(true)
    fireEvent.click(btn())
    expect(window.poe2desktop.trade.teleport).toHaveBeenCalledTimes(1)

    await act(async () => { resolveTeleport({ success: true }) })
    expect(btn().textContent).toBe('Sent ✓')
    expect(btn().disabled).toBe(true)

    // 2. Swapping ping prop in place resets to fresh and ignores stale replies
    let resolveSlow
    window.poe2desktop.trade.teleport.mockImplementation(() => new Promise(r => { resolveSlow = r }))
    rerender(<PingButton ping={makePing({ pingId: 'p2', listingId: 'l2' })} />)
    expect(btn().textContent).toBe('Travel to hideout')
    expect(btn().disabled).toBe(false)
    fireEvent.click(btn())
    expect(btn().textContent).toBe('Travelling…')

    // New ping arrives while p2 teleport is still in flight
    rerender(<PingButton ping={makePing({ pingId: 'p3', listingId: 'l3' })} />)
    expect(btn().textContent).toBe('Travel to hideout')
    await act(async () => { resolveSlow({ success: false }) })
    // Stale p2 failure must NOT mark p3 as Sold / gone
    expect(btn().textContent).toBe('Travel to hideout')
    expect(btn().disabled).toBe(false)

    // 3. Rate-limited recovers automatically after 30s
    window.poe2desktop.trade.teleport.mockResolvedValue({ success: false, error: 'RATE_LIMITED', retryAfter: 30 })
    await act(async () => { fireEvent.click(btn()) })
    expect(btn().textContent).toBe('Rate-limited')
    expect(btn().disabled).toBe(true)
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(btn().textContent).toBe('Travel to hideout')
    expect(btn().disabled).toBe(false)

    // 4. Fresh → stale after 45s (before 300s tokenExp)
    act(() => { vi.advanceTimersByTime(45_000) })
    expect(btn().textContent).toBe('Travel (stale)')
    expect(btn().disabled).toBe(false)
  })

  it('stops VaalPingOrb 1s interval once the newest ping becomes cold and bounds seen cache', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-21T18:00:00Z'))

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')

    render(<VaalPingOrb onClick={() => {}} />)
    expect(setIntervalSpy).not.toHaveBeenCalled()

    act(() => {
      usePings.getState().addPing(makePing({ pingId: 'orb-1', listingId: 'orb-l1', at: Date.now() }))
    })
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.vaal-orb.hot')).toBeTruthy()

    // Within 90s of expiry → cooling; past expiry → cold and interval cleared
    act(() => { vi.advanceTimersByTime(220_000) })
    expect(document.querySelector('.vaal-orb.cooling')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(90_000) })
    expect(document.querySelector('.vaal-orb.cold')).toBeTruthy()
    expect(clearIntervalSpy).toHaveBeenCalled()

    // Verify pingStore.seen stays bounded under heavy bursts and resets on clear()
    act(() => {
      for (let i = 0; i < 250; i++) {
        usePings.getState().addPing(makePing({ pingId: `burst-${i}`, listingId: `list-${i}` }))
      }
    })
    expect(Object.keys(usePings.getState().seen).length).toBeLessThanOrEqual(200)
    expect(usePings.getState().pings.length).toBeLessThanOrEqual(100)
    act(() => { usePings.getState().clear() })
    expect(Object.keys(usePings.getState().seen).length).toBe(0)
  })
})
