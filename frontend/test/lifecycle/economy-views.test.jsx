import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { installApiMock } from './setup.js'
import HoldView from '../../src/components/HoldView.jsx'
import MarketView from '../../src/components/MarketView.jsx'
import InflationView from '../../src/components/InflationView.jsx'
import MoversView from '../../src/components/MoversView.jsx'
import { loadIcons } from '../../src/lib/icons.js'
import { api } from '../../src/lib/api.js'

describe('Economy views lifecycles (Hold, Market, Inflation, Movers)', () => {
  beforeEach(async () => {
    installApiMock()
    await loadIcons()
  })

  it('HoldView loads /api/hold and renders ranked rows without errors', async () => {
    const { calls } = installApiMock()
    render(<HoldView />)

    await waitFor(() => {
      expect(calls.some(c => c.path === '/api/hold')).toBe(true)
      expect(screen.getByText('Divine Orb')).toBeTruthy()
    })
  })

  it('keeps one cross-league request across unrelated inflation view rerenders', async () => {
    const { calls } = installApiMock()
    const { rerender, unmount } = render(<InflationView league="A" />)
    const reads = () => calls.filter(c => c.path === '/api/inflation/cross')
    await waitFor(() => expect(reads()).toHaveLength(1))
    rerender(<InflationView league="B" />)
    unmount()
    expect(reads()).toHaveLength(1)
  })

  // QA 2026-11-24: a pair whose history failed to load said "No trades for this pair yet" (or, before the
  // useApi fix, kept drawing the previous pair). A failed load says it failed.
  it('MarketView says a pair history load failed instead of claiming the pair has no trades', async () => {
    const history = vi.spyOn(api, 'history').mockRejectedValue(new Error('Failed to fetch'))
    try {
      render(<MarketView />)
      await waitFor(() => expect(history).toHaveBeenCalled())
      await waitFor(() => expect(screen.getByText('Failed to fetch')).toBeTruthy())
      expect(screen.queryByText('No trades for this pair yet.')).toBeNull()
    } finally { history.mockRestore() }
  })

  it('MarketView loads top markets + edges and queries pair history on click', async () => {
    const { calls } = installApiMock({
      '/api/market/top': [{ a: 'chaos', b: 'exalted', volume_a: 10, volume_b: 100, rate: 10 }],
    })
    const { rerender, unmount } = render(<MarketView />)

    await waitFor(() => {
      expect(calls.some(c => c.path === '/api/market/top')).toBe(true)
      expect(calls.some(c => c.path === '/api/market/edges')).toBe(true)
    })

    const filter = screen.getByPlaceholderText('Filter by currency')
    fireEvent.change(filter, { target: { value: 'chaos' } })
    rerender(<MarketView />)
    expect(filter.value).toBe('chaos')
    expect(calls.filter(c => c.path === '/api/market/edges')).toHaveLength(1)
    const marketTable = await screen.findByRole('columnheader', { name: 'Market' })
    const row = marketTable.closest('table').querySelector('tbody tr')
    expect(row).toBeTruthy()
    fireEvent.click(row)
    await waitFor(() => {
      expect(calls.some(c => c.path === '/api/market/history' &&
        new URL(c.url, 'http://localhost').searchParams.get('a') === 'chaos')).toBe(true)
    })
    unmount()
    expect(calls.filter(c => c.path === '/api/market/history')).toHaveLength(2)
  })

  it('InflationView loads inflation, cross-league, and marketcap endpoints cleanly', async () => {
    const { calls } = installApiMock()
    const { rerender, unmount } = render(<InflationView league="A" />)

    await waitFor(() => {
      expect(calls.some(c => c.path === '/api/inflation')).toBe(true)
      expect(calls.some(c => c.path === '/api/inflation/marketcap')).toBe(true)
    })
    rerender(<InflationView league="A" />)
    expect(calls.filter(c => c.path === '/api/inflation')).toHaveLength(1)
    rerender(<InflationView league="B" />)
    await waitFor(() => expect(calls.filter(c => c.path === '/api/inflation')).toHaveLength(2))
    unmount()
    expect(calls.filter(c => c.path === '/api/inflation/marketcap')).toHaveLength(1)
  })

  it('InflationView labels the actual window honestly and defaults extra watchlist items off until toggled', async () => {
    const nowH = Math.floor(Date.now() / 3600000) * 3600
    const startH = nowH - 14 * 86400
    installApiMock({
      '/api/inflation': {
        anchor: 'lock',
        anchor_name: "Hinekora's Lock",
        anchors: [
          { id: 'divine', name: 'Divine Orb' },
          { id: 'mirror', name: 'Mirror of Kalandra' },
          { id: 'lock', name: "Hinekora's Lock" },
        ],
        basket: {
          points: [{ t: startH, v: 100 }, { t: nowH, v: 108.5 }],
          since_base_pct: 8.5,
          velocity_pct_per_day: 1.2,
          change_24h_pct: 1.1,
        },
        currencies: [
          { id: 'chaos', name: 'Chaos Orb', current: 118, since_base_pct: 18, coverage: 336, default_on: true, points: [{ t: startH, v: 100 }, { t: nowH, v: 118 }] },
          { id: 'omen-of-light', name: 'Omen of Light', current: 106, since_base_pct: 6, coverage: 336, default_on: false, points: [{ t: startH, v: 100 }, { t: nowH, v: 106 }] },
        ],
      },
    })
    render(<InflationView />)

    await waitFor(() => {
      expect(screen.getByText('Last 14 days')).toBeTruthy()
      expect(screen.getByText('7d trend')).toBeTruthy()
    })
    const anchor = document.querySelector('[data-cmd="inflation-anchor"] input')
    expect(screen.getAllByRole('combobox', { name: /^Against\b/ })).toContain(anchor)
    expect(screen.getAllByText('Against').map(label => label.htmlFor)).toContain(anchor.id)

    // Must not falsely claim "Since league start" or "day 0 = 100" for a 14-day window
    expect(screen.queryByText('Since league start')).toBeNull()
    expect(document.body.textContent).not.toContain('day 0 = 100')

    // Chaos Orb starts toggled ON; Omen of Light (default_on: false) starts toggled OFF
    const chaosToggle = screen.getByTitle('Hide Chaos Orb in the graph')
    const omenToggle = screen.getByTitle('Show Omen of Light in the graph')
    expect(chaosToggle).toBeTruthy()
    expect(omenToggle).toBeTruthy()

    // Clicking the extra currency toggle turns it ON
    fireEvent.click(omenToggle)
    await waitFor(() => {
      expect(screen.getByTitle('Hide Omen of Light in the graph')).toBeTruthy()
    })
  })

  it('InflationView does not show previous anchor stats while switching anchors and keeps currency colors stable', async () => {
    const nowH = Math.floor(Date.now() / 3600000) * 3600
    const startH = nowH - 14 * 86400
    let resolveDivine
    const divinePromise = new Promise(r => { resolveDivine = r })
    const anchors = [
      { id: 'divine', name: 'Divine Orb' },
      { id: 'mirror', name: 'Mirror of Kalandra' },
      { id: 'lock', name: "Hinekora's Lock" },
    ]
    const lockPayload = {
      anchor: 'lock', anchor_name: "Hinekora's Lock", anchors,
      basket: { points: [{ t: startH, v: 100 }, { t: nowH, v: 105.9 }], since_base_pct: 5.9, velocity_pct_per_day: 0.6, change_24h_pct: -0.4 },
      currencies: [
        { id: 'divine', name: 'Divine Orb', current: 98, since_base_pct: -2, coverage: 336, default_on: true, points: [{ t: startH, v: 100 }, { t: nowH, v: 98 }] },
        { id: 'chaos', name: 'Chaos Orb', current: 118, since_base_pct: 18, coverage: 336, default_on: true, points: [{ t: startH, v: 100 }, { t: nowH, v: 118 }] },
        { id: 'exalted', name: 'Exalted Orb', current: 69, since_base_pct: -31, coverage: 336, default_on: true, points: [{ t: startH, v: 100 }, { t: nowH, v: 69 }] },
      ],
    }
    const divinePayload = {
      anchor: 'divine', anchor_name: 'Divine Orb', anchors,
      basket: { points: [{ t: startH, v: 100 }, { t: nowH, v: 118.7 }], since_base_pct: 18.7, velocity_pct_per_day: 2.3, change_24h_pct: 0.4 },
      currencies: [
        { id: 'chaos', name: 'Chaos Orb', current: 120, since_base_pct: 20, coverage: 336, default_on: true, points: [{ t: startH, v: 100 }, { t: nowH, v: 120 }] },
        { id: 'exalted', name: 'Exalted Orb', current: 70, since_base_pct: -30, coverage: 336, default_on: true, points: [{ t: startH, v: 100 }, { t: nowH, v: 70 }] },
      ],
    }
    installApiMock({
      '/api/inflation': (rawUrl) => rawUrl.includes('anchor=divine') ? divinePromise : lockPayload,
    })

    render(<InflationView />)
    await waitFor(() => {
      expect(screen.getByText('▲ 5.9%')).toBeTruthy()
    })
    const chaosColorLock = document.querySelector('tbody tr:nth-child(2) .dot-key')?.style.background
    const exaltedColorLock = document.querySelector('tbody tr:nth-child(3) .dot-key')?.style.background

    // Open the anchor CurrencyPicker and select Divine Orb while its fetch is still pending
    const pickerInput = document.querySelector('[data-cmd="inflation-anchor"] input')
    fireEvent.focus(pickerInput)
    fireEvent.change(pickerInput, { target: { value: 'Divine' } })
    const divineOpt = await waitFor(() => document.querySelector('[data-cmd="inflation-anchor"] .cmdk-item'))
    fireEvent.mouseDown(divineOpt)

    // While Divine is loading, Lock's ▲ 5.9% must NOT stay displayed under Divine Orb,
    // and the chart must show Loading… immediately (never flashing "Not enough trades yet").
    expect(screen.queryByText('▲ 5.9%')).toBeNull()
    expect(screen.queryByText(/Not enough trades yet/)).toBeNull()
    expect(screen.getByText('Loading…')).toBeTruthy()

    // Resolve Divine fetch and confirm new data renders with unchanged currency dot colors
    resolveDivine(divinePayload)
    await waitFor(() => {
      expect(screen.getByText('▲ 18.7%')).toBeTruthy()
    })
    const chaosColorDivine = document.querySelector('tbody tr:nth-child(1) .dot-key')?.style.background
    const exaltedColorDivine = document.querySelector('tbody tr:nth-child(2) .dot-key')?.style.background
    expect(chaosColorDivine).toBe(chaosColorLock)
    expect(exaltedColorDivine).toBe(exaltedColorLock)
  })

  it('InflationView shows error notice instead of empty-trades message when anchor switch fails', async () => {
    const nowH = Math.floor(Date.now() / 3600000) * 3600
    const startH = nowH - 14 * 86400
    const anchors = [
      { id: 'divine', name: 'Divine Orb' },
      { id: 'mirror', name: 'Mirror of Kalandra' },
      { id: 'lock', name: "Hinekora's Lock" },
    ]
    installApiMock({
      '/api/inflation': (rawUrl) => {
        if (rawUrl.includes('anchor=mirror')) {
          return new Response('boom', { status: 500 })
        }
        return {
          anchor: 'lock', anchor_name: "Hinekora's Lock", anchors,
          basket: { points: [{ t: startH, v: 100 }, { t: nowH, v: 105.9 }], since_base_pct: 5.9, velocity_pct_per_day: 0.6, change_24h_pct: -0.4 },
          currencies: [
            { id: 'chaos', name: 'Chaos Orb', current: 118, since_base_pct: 18, coverage: 336, default_on: true, points: [{ t: startH, v: 100 }, { t: nowH, v: 118 }] },
          ],
        }
      },
    })

    render(<InflationView />)
    await waitFor(() => {
      expect(screen.getByText('▲ 5.9%')).toBeTruthy()
    })

    const pickerInput = document.querySelector('[data-cmd="inflation-anchor"] input')
    fireEvent.focus(pickerInput)
    fireEvent.change(pickerInput, { target: { value: 'Mirror' } })
    const mirrorOpt = await waitFor(() => document.querySelector('[data-cmd="inflation-anchor"] .cmdk-item'))
    fireEvent.mouseDown(mirrorOpt)

    await waitFor(() => {
      expect(document.querySelector('.notice.error')).toBeTruthy()
    })
    expect(screen.queryByText(/Not enough trades yet/)).toBeNull()
  })

  it('MoversView loads /api/movers and opens asset modal when a mover row is clicked', async () => {
    const { calls } = installApiMock()
    render(<MoversView />)

    await waitFor(() => {
      expect(calls.some(c => c.path === '/api/movers')).toBe(true)
      expect(screen.getAllByText('Divine Orb').length).toBeGreaterThanOrEqual(1)
    })

    fireEvent.click(screen.getAllByText('Divine Orb')[0].closest('tr'))
    await waitFor(() => {
      expect(calls.some(c => c.path === '/api/asset')).toBe(true)
    })
  })
})
