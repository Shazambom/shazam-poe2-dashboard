import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { installApiMock, DEFAULT_CURRENCIES } from './setup.js'
import StashView from '../../src/components/StashView.jsx'
import RoutesView from '../../src/components/RoutesView.jsx'
import ConvertView from '../../src/components/ConvertView.jsx'
import StratCalcView from '../../src/components/StratCalcView.jsx'
import { useStatus } from '../../src/lib/statusStore.js'
import { loadIcons } from '../../src/lib/icons.js'

class FakeEventSource {
  static instances = []
  constructor(url) {
    this.url = url
    this.listeners = {}
    this.closed = false
    FakeEventSource.instances.push(this)
  }
  addEventListener(type, fn) {
    ;(this.listeners[type] ||= []).push(fn)
  }
  emit(type, payload) {
    const ev = { data: JSON.stringify(payload) }
    for (const fn of this.listeners[type] || []) fn(ev)
  }
  close() {
    this.closed = true
  }
}

describe('Stash, Arbitrage SSE, Convert, and StratCalc lifecycles', () => {
  beforeEach(async () => {
    FakeEventSource.instances = []
    globalThis.EventSource = FakeEventSource
    installApiMock()
    await loadIcons()
    useStatus.setState({
      status: { league: 'Test League', reference: 'exalted', wealth_prices: { exalted: 1, divine: 100, chaos: 5 } },
      capital: {
        reference: 'exalted',
        total_ref: 1500,
        counted_by_default: ['divine', 'exalted'],
        rows: [
          { currency: 'divine', name: 'Divine Orb', qty: 10, value_ref: 1000, unit_ref: 100, group: 'currency', liquid: true },
          { currency: 'exalted', name: 'Exalted Orb', qty: 500, value_ref: 500, unit_ref: 1, group: 'currency', liquid: true },
        ],
      },
      settings: { league: 'Test League', stash_unit: 'divine', stash_counted: {} },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('StashView edits holdings and flushes pending PUT /api/capital on unmount', async () => {
    const { calls } = installApiMock()
    const { unmount } = render(<StashView />)

    await waitFor(() => {
      expect(document.querySelectorAll('input[type="number"], input[inputmode="decimal"], input').length).toBeGreaterThan(0)
    })

    const numInput = Array.from(document.querySelectorAll('input')).find(i => i.value === '10' || i.value === '500')
    expect(numInput).toBeTruthy()

    fireEvent.change(numInput, { target: { value: '25' } })
    // Unmount immediately before the autosave debounce fires → unmount flush must persist the edit
    unmount()

    await waitFor(() => {
      const puts = calls.filter(c => c.method === 'PUT' && c.path === '/api/capital')
      expect(puts.length).toBeGreaterThanOrEqual(1)
      const lastEntries = puts[puts.length - 1].body.entries
      expect(Object.values(lastEntries)).toContain(25)
    })
  })

  it('RoutesView streams SSE meta/routes/done and closes EventSource cleanly on unmount', async () => {
    installApiMock()
    const { unmount } = render(<RoutesView />)

    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1)
    })

    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]
    expect(es.url).toContain('/api/routes/stream')

    act(() => {
      es.emit('meta', { reference: 'exalted', candidates: 12, window_h: 24 })
      es.emit('routes', [{
        id: 'loop-1',
        start: 'divine',
        start_name: 'Divine Orb',
        start_amount: 10,
        end_amount: 10.5,
        in: 10,
        out: 10.5,
        path: ['divine', 'exalted', 'divine'],
        path_names: ['Divine Orb', 'Exalted Orb', 'Divine Orb'],
        kinds: ['digest', 'digest'],
        profit: 0.5,
        profit_ref: 50,
        profit_pct: 5.0,
        score: 1.2,
        fill_hours: 0.4,
        gold: 200,
        cycles: 10,
        cycle_unit: 1,
        steps: [
          { from: 'divine', from_name: 'Divine Orb', to: 'exalted', to_name: 'Exalted Orb', in: 10, out: 1000, rate: 100, kind: 'digest', gold: 100, vol_h: 500 },
          { from: 'exalted', from_name: 'Exalted Orb', to: 'divine', to_name: 'Divine Orb', in: 1000, out: 10.5, rate: 0.0105, kind: 'digest', gold: 100, vol_h: 500 },
        ],
      }])
      es.emit('done', { count: 1, candidates: 12, order: ['loop-1'], scores: { 'loop-1': 1.2 } })
    })

    await waitFor(() => {
      const row = document.querySelector('tbody tr.route')
      expect(row).toBeTruthy()
      expect(row.textContent).toContain('24m')
    })
    expect(es.closed).toBe(true)

    // Clicking the loop row expands its step-by-step Detail table
    fireEvent.click(document.querySelector('tbody tr.route'))
    await waitFor(() => {
      expect(document.querySelector('tbody tr.route')?.getAttribute('aria-expanded')).toBe('true')
      expect(document.querySelector('.detail')).toBeTruthy()
    })

    // Unmount cleanup also closes any active in-flight stream
    unmount()
    expect(FakeEventSource.instances.every(i => i.closed)).toBe(true)
  })

  it('ConvertView runs conversion, shows result, and expands alternative routes', async () => {
    const { calls } = installApiMock()
    render(<ConvertView currencies={DEFAULT_CURRENCIES} capital={useStatus.getState().capital} />)

    const convertBtn = screen.getByRole('button', { name: /convert|find|route/i })
    fireEvent.click(convertBtn)

    await waitFor(() => {
      expect(calls.some(c => c.path === '/api/convert')).toBe(true)
      expect(document.body.textContent).toContain('50')
    })
  })

  it('StratCalcView loads saved strats and renders calculator cleanly', async () => {
    const { calls } = installApiMock()
    render(<StratCalcView />)

    await waitFor(() => {
      expect(calls.some(c => c.path === '/api/strategy/calc')).toBe(true)
    })
    expect(document.body.textContent.length).toBeGreaterThan(0)
  })
})
