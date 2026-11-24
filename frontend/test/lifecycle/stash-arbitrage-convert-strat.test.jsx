import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { installApiMock, DEFAULT_CURRENCIES } from './setup.js'
import StashView from '../../src/components/StashView.jsx'
import RoutesView from '../../src/components/RoutesView.jsx'
import ConvertView from '../../src/components/ConvertView.jsx'
import * as sc from '../../src/lib/stratcalc.js'
import { useStratStore } from '../../src/lib/stratStore.js'
import StratCalcView from '../../src/components/StratCalcView.jsx'
import { useStatus, capitalDirty } from '../../src/lib/statusStore.js'
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
    this.listeners[type] ||= []
    this.listeners[type].push(fn)
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
    const { rerender, unmount } = render(<StashView />)

    await waitFor(() => {
      expect(document.querySelectorAll('input[type="number"], input[inputmode="decimal"], input').length).toBeGreaterThan(0)
    })

    const numInput = Array.from(document.querySelectorAll('input')).find(i => i.value === '10' || i.value === '500')
    expect(numInput).toBeTruthy()

    fireEvent.change(numInput, { target: { value: '25' } })
    rerender(<StashView />)
    expect(numInput.value).toBe('25')
    expect(calls.filter(c => c.method === 'PUT' && c.path === '/api/capital')).toHaveLength(0)
    // Unmount immediately before the autosave debounce fires → unmount flush must persist the edit
    unmount()

    await waitFor(() => {
      const puts = calls.filter(c => c.method === 'PUT' && c.path === '/api/capital')
      expect(puts).toHaveLength(1)
      const lastEntries = puts[puts.length - 1].body.entries
      expect(Object.values(lastEntries)).toContain(25)
    })
  })

  it('discards a held pre-credit balance and seeds the replacement without saving stale quantities', async () => {
    const { calls } = installApiMock()
    const capital = useStatus.getState().capital
    const { unmount } = render(<StashView />)
    const quantity = await screen.findByDisplayValue('10')
    act(() => useStatus.setState({ salesFetching: true }))
    fireEvent.change(quantity, { target: { value: '25' } })
    expect(quantity.value).toBe('25')
    act(() => useStatus.setState({ capitalStale: true, salesFetching: false }))
    expect(screen.getByText('Loading your stash…')).toBeTruthy()
    expect(screen.queryByDisplayValue('25')).toBeNull()
    const rows = capital.rows.map(row => row.currency === 'divine' ? { ...row, qty: 12 } : row)
    act(() => useStatus.setState({ capital: { ...capital, rows }, capitalStale: false }))
    expect(await screen.findByDisplayValue('12')).toBeTruthy()
    unmount()
    expect(calls.filter(call => call.method === 'PUT' && call.path === '/api/capital')).toHaveLength(0)
  })

  it('waits for authoritative holdings and replays restored edits without overwriting a new count', async () => {
    const { calls } = installApiMock()
    const original = useStatus.getState().capital
    const { unmount } = render(<StashView />)
    const old = await screen.findByDisplayValue('10')
    act(() => useStatus.setState({ salesFetching: true }))
    fireEvent.change(old, { target: { value: '25' } })
    act(() => useStatus.setState({ capitalStale: true, capitalSaving: true }))
    expect(screen.getByText('Loading your stash…')).toBeTruthy()
    const credited = { ...original, rows: original.rows.map(row => ({ ...row, qty: row.qty + 2 })) }
    act(() => useStatus.setState({ capital: credited, capitalStale: false }))
    expect(screen.queryByDisplayValue('12')).toBeNull()
    capitalDirty.set('divine', { kind: 'add', delta: 3 })
    act(() => useStatus.setState({ capitalSaving: false }))
    expect(screen.getByDisplayValue('15')).toBeTruthy()
    fireEvent.change(screen.getByDisplayValue('502'), { target: { value: '519' } })
    act(() => useStatus.setState({ capital: { ...credited }, salesFetching: false }))
    expect(screen.getByDisplayValue('519')).toBeTruthy()
    const writes = () => calls.filter(call => call.method === 'PUT' && call.path === '/api/capital')
    expect(writes()).toHaveLength(0)
    unmount()
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0].body.entries).toEqual({ divine: 15, exalted: 519 })
    expect(writes()[0].body.counted).toEqual(['exalted'])
  })

  it('keeps a local counting choice when saved choices for other currencies arrive', async () => {
    const { calls } = installApiMock()
    const { unmount } = render(<StashView />)
    const divine = await screen.findByRole('switch', { name: 'Count Divine Orb toward liquid net worth' })
    const exalted = screen.getByRole('switch', { name: 'Count Exalted Orb toward liquid net worth' })
    expect(divine.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(divine)
    await waitFor(() => expect(calls.filter(c => c.method === 'PUT' && c.path === '/api/settings')).toHaveLength(1))
    act(() => useStatus.setState(s => ({ settings: { ...s.settings, stash_counted: { divine: true, exalted: false } } })))
    expect(divine.getAttribute('aria-checked')).toBe('false')
    expect(exalted.getAttribute('aria-checked')).toBe('false')
    unmount()
    expect(calls.filter(c => c.method === 'PUT' && c.path === '/api/settings')).toHaveLength(1)
  })

  it('leaves the route loading state when the stream reports a failure', async () => {
    installApiMock()
    const { container } = render(<RoutesView />)
    await waitFor(() => expect(container.querySelectorAll('.sk-row')).toHaveLength(6))
    const [stream] = FakeEventSource.instances
    act(() => stream.emit('error', { error: 'backend unavailable' }))
    expect(stream.closed).toBe(true)
    expect(container.querySelectorAll('.sk-row')).toHaveLength(0)
    expect(container.querySelector('[aria-label="searching"]')).toBeNull()
    expect(screen.getByText(/Couldn't load routes: backend unavailable/)).toBeTruthy()
  })

  it('RoutesView streams SSE meta/routes/done and closes EventSource cleanly on unmount', async () => {
    installApiMock()
    const { rerender, unmount } = render(<RoutesView />)

    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1)
    })

    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]
    expect(es.url).toContain('/api/routes/stream')

    act(() => {
      es.emit('meta', { reference: 'exalted', candidates: 12, window_h: 24, capital: { divine: 10 } })
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

    rerender(<RoutesView capital={{ reference: 'exalted' }} />)
    expect(FakeEventSource.instances).toHaveLength(1)
    // The initial, immediate search key settles before the next edit is debounced.
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 550) }) })
    const start = screen.getByLabelText('Start from')
    fireEvent.change(start, { target: { value: 'divine' } })
    expect(start.value).toBe('divine')
    expect(FakeEventSource.instances).toHaveLength(1)
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2))
    expect(FakeEventSource.instances[1].closed).toBe(false)
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
    const { rerender, unmount } = render(<StratCalcView />)

    await waitFor(() => {
      expect(calls.some(c => c.path === '/api/strategy/calc')).toBe(true)
    })
    expect(document.body.textContent.length).toBeGreaterThan(0)
    const maps = await screen.findByLabelText('Maps run')
    fireEvent.focus(maps)
    fireEvent.change(maps, { target: { value: '3*2' } })
    rerender(<StratCalcView currencies={DEFAULT_CURRENCIES} />)
    expect(maps.value).toBe('3*2')
    expect(calls.filter(c => c.path === '/api/strategy/calc' && !c.url.includes('prices=1') && c.method === 'GET')).toHaveLength(1)
    unmount()
    expect(screen.queryByLabelText('Maps run')).toBeNull()
  })
  it('preserves map and tablet prices in their selected currencies when unlinking', async () => {
    const now = Date.now()
    const search = { query: { query: {}, sort: { price: 'asc' } }, league: 'Test League' }
    let doc = sc.newStrat(sc.blankDoc(), { id: 's', name: 'Prices', now })
    doc = sc.addTablet(doc, 's', { id: 't', now })
    doc = sc.recordMapsPrice(sc.linkMaps(doc, 's', search, now), 's', 2, now, 'chaos')
    doc = sc.recordLinkPrice(sc.linkTablet(doc, 's', 't', search, now), 's', 't', 3, now, 'exalted')
    installApiMock({ '/api/strategy/calc': { calc: doc, prices: { chaos: 0.5, exalted: 0.25, divine: 1 }, uses: [] } })
    useStratStore.setState({ doc: null })
    const { unmount } = render(<StratCalcView league="Test League" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Trade search for maps' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }))
    const active = () => sc.activeStrat(useStratStore.getState().doc)
    expect(active().maps).toMatchObject({ price: 4, cur: 'chaos' })
    expect(active().maps.link).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: 'Trade search for Any tablet' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }))
    expect(active().tablets.lines[0]).toMatchObject({ price: 12, cur: 'exalted' })
    expect(active().tablets.lines[0].link).toBeUndefined()
    unmount()
    await useStratStore.getState().flush()
  })

  it('hands updated exchange rates to both unlink actions while the builder is open', async () => {
    const now = Date.now()
    const search = { query: { query: { status: { option: 'securable' } } }, league: 'Test League' }
    let doc = sc.newStrat(sc.blankDoc(), { id: 's', name: 'Prices', now })
    doc = sc.addTablet(doc, 's', { id: 't', now })
    doc = sc.recordMapsPrice(sc.linkMaps(doc, 's', search, now), 's', 2, now, 'chaos')
    doc = sc.recordLinkPrice(sc.linkTablet(doc, 's', 't', search, now), 's', 't', 3, now, 'chaos')
    installApiMock({ '/api/strategy/calc': { calc: doc, prices: { chaos: 1, divine: 1 }, uses: [] } })
    useStratStore.setState({ doc: null })
    const view = render(<StratCalcView league="Test League" />)
    const active = () => sc.activeStrat(useStratStore.getState().doc)
    for (const [label, rate] of [['maps', 0.5], ['Any tablet', 0.25]]) {
      fireEvent.click(await screen.findByRole('button', { name: `Trade search for ${label}` }))
      act(() => useStratStore.getState().setPrices({ divine: 1, chaos: rate }))
      fireEvent.click(screen.getByRole('button', { name: 'Unlink' }))
    }
    expect(active().maps).toMatchObject({ price: 4, cur: 'chaos' })
    expect(active().tablets.lines[0]).toMatchObject({ price: 12, cur: 'chaos' })
    view.unmount()
    await useStratStore.getState().flush()
  })

})
