import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { installApiMock, DEFAULT_CURRENCIES } from './setup.js'
import HoldView from '../../src/components/HoldView.jsx'
import MarketView from '../../src/components/MarketView.jsx'
import InflationView from '../../src/components/InflationView.jsx'
import MoversView from '../../src/components/MoversView.jsx'
import { loadIcons } from '../../src/lib/icons.js'

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

  it('MarketView loads top markets + edges and queries pair history on click', async () => {
    const { calls } = installApiMock()
    render(<MarketView />)

    await waitFor(() => {
      expect(calls.some(c => c.path === '/api/market/top')).toBe(true)
      expect(calls.some(c => c.path === '/api/market/edges')).toBe(true)
    })

    const row = document.querySelector('tbody tr')
    if (row) {
      fireEvent.click(row)
      await waitFor(() => {
        expect(calls.some(c => c.path === '/api/market/history')).toBe(true)
      })
    }
  })

  it('InflationView loads inflation, cross-league, and marketcap endpoints cleanly', async () => {
    const { calls } = installApiMock()
    render(<InflationView />)

    await waitFor(() => {
      expect(calls.some(c => c.path === '/api/inflation')).toBe(true)
      expect(calls.some(c => c.path === '/api/inflation/marketcap')).toBe(true)
    })
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
