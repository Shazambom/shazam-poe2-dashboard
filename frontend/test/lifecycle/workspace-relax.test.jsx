import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { installApiMock } from './setup.js'
import WorkspaceView from '../../src/components/WorkspaceView.jsx'
import { bus } from '../../src/lib/api.js'
import { useWorkspace, HISTORY_SYS } from '../../src/lib/workspaceStore.js'
import { encodeSlug } from '../../src/lib/reprice.js'

const EE2_RARE_QUERY = {
  query: {
    status: { option: 'securable' },
    stats: [{
      type: 'and',
      filters: [
        { id: 'explicit.stat_life', value: { min: 100 } },
        { id: 'explicit.stat_fire', value: { min: 40 } },
        { id: 'explicit.stat_cold', value: { min: 40 } },
        { id: 'explicit.stat_light', value: { min: 40 } },
        { id: 'explicit.stat_chaos', value: { min: 20 } },
      ],
    }],
    filters: {
      type_filters: { filters: { category: { option: 'accessory.ring' } } },
    },
  },
  sort: { price: 'asc' },
}

const UNIQUE_QUERY = {
  query: {
    status: { option: 'securable' },
    name: 'Headhunter',
    type: 'Heavy Belt',
    stats: [{ type: 'and', filters: [] }],
  },
  sort: { price: 'asc' },
}

function seedTree(activeId = 'h1', extraNodes = []) {
  const rareQ = JSON.stringify(EE2_RARE_QUERY)
  const uniqueQ = JSON.stringify(UNIQUE_QUERY)
  useWorkspace.getState().hydrate({
    version: 2,
    activeId,
    layout: { collapsed: true },
    openTabs: [],
    tree: [
      {
        id: 'hist_folder',
        kind: 'folder',
        name: 'ExiledExchange2 History',
        sys: HISTORY_SYS,
        open: false,
        children: [
          { id: 'h1', kind: 'search', name: 'Doom Band', type: 'search', slug: '', live: false, q: rareQ, auto: false, ts: Date.now() },
          { id: 'h2', kind: 'search', name: 'Headhunter', type: 'search', slug: '', live: false, q: uniqueQ, auto: false, ts: Date.now() },
        ],
      },
      {
        id: 's1',
        kind: 'search',
        name: 'Saved Rare Ring',
        type: 'search',
        slug: 'orig-slug',
        live: false,
        q: rareQ,
        auto: false,
      },
      ...extraNodes,
    ],
  })
  return { rareQ }
}

describe('WorkspaceView Close-enough fuzzy rare finder lifecycle', () => {
  // useReprice registers its onTap listener once per module load; keep the captured callback across tests.
  let tapHandler = null
  let navHandler = null
  let apiCalls

  beforeEach(() => {
    navHandler = null
    const apiMock = installApiMock({
      '/api/strategy/calc': {
        calc: null,
        prices: { divine: 1, chaos: 0.09, vaal: 0.012, exalted: 0.0015 },
        uses: [],
      },
    })
    apiCalls = apiMock.calls
    if (!tapHandler) {
      window.poe2desktop.trade.onTap = vi.fn((cb) => { tapHandler = cb; return () => {} })
    }
    window.poe2desktop.trade.onWebviewNav = vi.fn((cb) => { navHandler = cb; return () => {} })
    window.poe2desktop.trade.listingsCancel = vi.fn(async () => ({ ok: true }))
    window.poe2desktop.trade.relaxCancel = vi.fn(async () => ({ ok: true }))
    window.poe2desktop.trade.relax = vi.fn(async () => ({
      ok: true,
      searchId: 'RX1',
      total: 12,
      rows: [
        { id: 'r0', amount: 17, currency: 'chaos' },
        { id: 'r1', amount: 100, currency: 'vaal' },
      ],
    }))
  })

  const savedMods = ['explicit.stat_armour', 'explicit.stat_spirit', 'explicit.stat_accuracy']

  // The outgoing guest can still report its address or listings while the next
  // saved link is being decoded locally. Only a user click should broaden it.
  async function switchToCompressedSearch(afterExact) {
    const body = structuredClone(EE2_RARE_QUERY)
    body.query.stats[0].filters = savedMods.map(id => ({ id, value: { min: 10 } }))
    const next = { id: 'next', kind: 'search', name: 'Saved armour search', slug: await encodeSlug(body.query) }
    const first = { id: 'first', kind: 'search', name: 'Saved life search', slug: await encodeSlug(EE2_RARE_QUERY.query) }
    seedTree(afterExact ? first.id : 's1', [first, next])
    const request = window.poe2desktop.trade.relax
    const guest = () => document.querySelector('webview')
    const contents = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getWebContentsId')
    Object.defineProperty(HTMLElement.prototype, 'getWebContentsId', { configurable: true, value: () => 79 })
    try {
      const { rerender, unmount } = render(<WorkspaceView league="Test League" visible />)
      fireEvent.click(await screen.findByRole('button', { name: 'Close enough' }))
      await screen.findByText('Relaxed')
      const url = guest().getAttribute('src')
      const previous = JSON.parse(new URL(url).searchParams.get('q'))
      expect(previous.query.status.option).toBe('securable')
      act(() => tapHandler({ kind: 'search', wcId: 79, id: 'previous', league: 'Test League', body: previous, ids: [] }))
      if (afterExact) fireEvent.click(screen.getByRole('button', { name: 'Exact' }))
      else await act(async () => navHandler({ wcId: 79, phase: 'stop', url }))
      act(() => useWorkspace.getState().setActive(next.id))
      const selected = guest()
      const address = selected.getAttribute('src')
      expect(address).toContain(next.slug)
      rerender(<WorkspaceView league="Test League" visible />)
      act(() => tapHandler({ kind: 'fetch', wcId: 79, searchId: 'previous', rows: [] }))
      const broaden = await screen.findByRole('button', { name: 'Close enough' })
      expect(guest()).toBe(selected)
      expect(selected.getAttribute('src')).toBe(address)
      expect(request).toHaveBeenCalledTimes(1)
      fireEvent.click(broaden)
      await screen.findByText('Relaxed')
      expect(request).toHaveBeenCalledTimes(2)
      const queries = request.mock.calls.map(([payload]) => payload.query)
      expect(queries.map(query => query.status.option)).toEqual(['securable', 'securable'])
      expect(JSON.parse(new URL(guest().getAttribute('src')).searchParams.get('q')).query.status.option).toBe('securable')
      expect(apiCalls.every(call => call.url.startsWith('/api/'))).toBe(true)
      unmount()
      return queries[1].stats[0].filters.map(filter => filter.id)
    } finally {
      if (contents) Object.defineProperty(HTMLElement.prototype, 'getWebContentsId', contents)
      else Reflect.deleteProperty(HTMLElement.prototype, 'getWebContentsId')
    }
  }

  it('broadens the newly selected saved link after the outgoing relaxed webview reports its address', async () => {
    expect(await switchToCompressedSearch(false)).toEqual(savedMods)
  })

  it('broadens the newly selected saved link after Exact on another compressed search', async () => {
    expect(await switchToCompressedSearch(true)).toEqual(savedMods)
  })

  it('shows Close enough on EE2 History rare, highlights on empty exact, shows Relaxing…, applies real-rate currency selection, relaxes further, snaps back to Exact, and never mutates node.q', async () => {
    const { rareQ } = seedTree('h1')
    let resolveRelax
    window.poe2desktop.trade.relax = vi.fn(() => new Promise(res => { resolveRelax = res }))

    render(<WorkspaceView league="Test League" visible={true} />)

    const wv = document.querySelector('webview')
    expect(wv).toBeTruthy()
    wv.getWebContentsId = () => 77
    const originalSrc = wv.getAttribute('src')

    // Chip starts quiet (.find) before TAP reports 0 results.
    const chip = await screen.findByRole('button', { name: 'Close enough' })
    expect(chip.className).toContain('find')
    expect(chip.getAttribute('title')).not.toMatch(/real rates|85%/i)

    // Emit TAP options + empty exact search -> chip promotes to .act.
    expect(typeof tapHandler).toBe('function')
    act(() => {
      tapHandler({ kind: 'options', wcId: 77, price: [{ id: 'chaos', text: 'Chaos Orb' }, { id: 'vaal', text: 'Vaal Orb' }] })
      tapHandler({ kind: 'search', wcId: 77, league: 'Test League', id: 'E0', body: EE2_RARE_QUERY, ids: [], total: 0 })
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Close enough' }).className).toContain('act')
    })

    // Click Close enough -> shows Relaxing… while in flight.
    fireEvent.click(screen.getByRole('button', { name: 'Close enough' }))
    await waitFor(() => {
      const status = screen.getByText('Relaxing…')
      expect(status.getAttribute('role')).toBe('status')
    })

    // Resolve level 1 relax response (17 chaos = 1.53 div vs 100 vaal = 1.20 div -> picks vaal).
    await act(async () => {
      resolveRelax({
        ok: true,
        searchId: 'RX1',
        total: 12,
        rows: [
          { id: 'r0', amount: 17, currency: 'chaos' },
          { id: 'r1', amount: 100, currency: 'vaal' },
        ],
      })
    })

    await waitFor(() => {
      expect(screen.getByText('Relaxed')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Relax further' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Exact' })).toBeTruthy()
    })

    expect(window.poe2desktop.trade.relax).toHaveBeenCalledTimes(1)
    const call1 = window.poe2desktop.trade.relax.mock.calls[0][0]
    expect(call1.league).toBe('Test League')
    expect(call1.query.stats[0].type).toBe('count')
    expect(call1.query.stats[0].value.min).toBe(4)

    // Webview URL switched to ephemeral relaxed ?q= URL, priced in real-rate cheapest currency (vaal).
    const relaxedWv = document.querySelector('webview')
    const relaxedSrc = relaxedWv.getAttribute('src')
    expect(relaxedSrc).not.toBe(originalSrc)
    const decodedRelaxed = JSON.parse(new URL(relaxedSrc).searchParams.get('q'))
    expect(decodedRelaxed.query.stats[0].type).toBe('count')
    expect(decodedRelaxed.query.stats[0].value.min).toBe(4)
    expect(decodedRelaxed.query.filters.trade_filters.filters.price.option).toBe('vaal')

    // Underlying EE2 History node was NEVER mutated.
    expect(useWorkspace.getState().nodeById('h1').q).toBe(rareQ)

    // Click Relax further -> level 2 (min: 3) and Relax further disappears.
    window.poe2desktop.trade.relax = vi.fn(async () => ({
      ok: true,
      searchId: 'RX2',
      total: 40,
      rows: [{ id: 'r2', amount: 10, currency: 'chaos' }],
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Relax further' }))
    await waitFor(() => {
      expect(screen.getByText('Relaxed')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Relax further' })).toBeNull()
    })
    expect(window.poe2desktop.trade.relax.mock.calls[0][0].query.stats[0].value.min).toBe(3)

    // Click Exact -> snaps straight back to original exact URL, uses relaxCancel (not listingsCancel), restores Close enough chip.
    const listingsCancelsBefore = window.poe2desktop.trade.listingsCancel.mock.calls.length
    const relaxCancelsBefore = window.poe2desktop.trade.relaxCancel.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Exact' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Close enough' })).toBeTruthy()
      expect(document.querySelector('webview').getAttribute('src')).toBe(originalSrc)
    })
    expect(window.poe2desktop.trade.relaxCancel.mock.calls.length).toBeGreaterThan(relaxCancelsBefore)
    expect(window.poe2desktop.trade.listingsCancel.mock.calls.length).toBe(listingsCancelsBefore)
    expect(useWorkspace.getState().nodeById('h1').q).toBe(rareQ)
  })

  it('works on saved slug-only rare searches, never overwrites saved node.slug while relaxed or after visibility toggle (C2), and hides chip for ineligible items (C3)', async () => {
    const gzipSlug = await encodeSlug(EE2_RARE_QUERY.query)
    seedTree('slugOnly', [{
      id: 'slugOnly',
      kind: 'search',
      name: 'Slug Rare Ring',
      type: 'search',
      slug: gzipSlug,
      live: false,
      auto: false,
    }])
    const { rerender } = render(<WorkspaceView league="Test League" visible={true} />)
    const wv = document.querySelector('webview')
    wv.getWebContentsId = () => 88

    fireEvent.click(await screen.findByRole('button', { name: 'Close enough' }))
    await waitFor(() => expect(screen.getByText('Relaxed')).toBeTruthy())

    // Simulate trade site redirecting relaxed ?q= to a new slug while relaxed.
    const wvNow = document.querySelector('webview')
    wvNow.getWebContentsId = () => 88
    act(() => {
      navHandler?.({ wcId: 88, phase: 'nav', url: 'https://www.pathofexile.com/trade2/search/poe2/Test%20League/RELAXED_SLUG' })
    })
    expect(useWorkspace.getState().nodeById('slugOnly').slug).toBe(gzipSlug)

    // C2: Hiding Workspace while relaxed remounts back to exact slug URL (bumping relaxTick) so no stale redirect lingers.
    rerender(<WorkspaceView league="Test League" visible={false} />)
    await waitFor(() => {
      expect(document.querySelector('webview').getAttribute('src')).toContain(gzipSlug)
    })
    rerender(<WorkspaceView league="Test League" visible={true} />)

    // Switch to ineligible unique row -> resets relaxation, cancels in-flight relax, and hides chip (no TAP leak from Row A, C3).
    const relaxCancelBefore = window.poe2desktop.trade.relaxCancel.mock.calls.length
    act(() => { useWorkspace.getState().setActive('h2') })
    await waitFor(() => {
      expect(screen.queryByText('Relaxed')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Close enough' })).toBeNull()
      expect(window.poe2desktop.trade.relaxCancel.mock.calls.length).toBeGreaterThan(relaxCancelBefore)
    })
  })

  it('shows No matches when relaxed search returns 0, preserves exact TAP page on Exact (C4), and resets/cancels when leaving Workspace', async () => {
    window.poe2desktop.trade.relax = vi.fn(async () => ({ ok: true, searchId: 'RX0', total: 0, rows: [] }))
    seedTree('h1')
    const { rerender } = render(<WorkspaceView league="Test League" visible={true} />)
    const wv = document.querySelector('webview')
    wv.getWebContentsId = () => 91

    act(() => {
      tapHandler?.({ kind: 'search', wcId: 91, league: 'Test League', id: 'E_EXACT', body: EE2_RARE_QUERY, ids: [], total: 0 })
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close enough' }).className).toContain('act'))

    fireEvent.click(screen.getByRole('button', { name: 'Close enough' }))
    await waitFor(() => {
      expect(screen.getByText('No matches')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Relax further' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Exact' })).toBeTruthy()
    })

    // C4: Clicking Exact after No matches (relaxUrl === null) must NOT blacklist the exact TAP page or call listingsCancel.
    const listingsBefore = window.poe2desktop.trade.listingsCancel.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Exact' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close enough' })).toBeTruthy())
    expect(window.poe2desktop.trade.listingsCancel.mock.calls.length).toBe(listingsBefore)

    // Re-trigger No matches, then hide Workspace -> cancels via relaxCancel and resets.
    fireEvent.click(screen.getByRole('button', { name: 'Close enough' }))
    await waitFor(() => expect(screen.getByText('No matches')).toBeTruthy())
    const relaxCancelBefore = window.poe2desktop.trade.relaxCancel.mock.calls.length
    rerender(<WorkspaceView league="Test League" visible={false} />)
    await waitFor(() => {
      expect(window.poe2desktop.trade.relaxCancel.mock.calls.length).toBeGreaterThan(relaxCancelBefore)
    })
    rerender(<WorkspaceView league="Test League" visible={true} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Close enough' })).toBeTruthy()
      expect(screen.queryByText('No matches')).toBeNull()
    })
  })

  it('remounts latest captured slug on Exact (C5) and uses live webview TAP search over stale disabled node.q', async () => {
    const disabledQ = JSON.stringify({
      query: {
        status: { option: 'securable' },
        stats: [{
          type: 'and',
          filters: [
            { id: 'explicit.stat_life', value: { min: 100 }, disabled: true },
            { id: 'explicit.stat_fire', value: { min: 40 }, disabled: true },
            { id: 'explicit.stat_cold', value: { min: 40 }, disabled: true },
          ],
        }],
        filters: { type_filters: { filters: { category: { option: 'armour.chest' } } } },
      },
      sort: { price: 'asc' },
    })
    seedTree('h_disabled', [{
      id: 'h_disabled',
      kind: 'search',
      name: 'Hate Pelt Soldier Cuirass',
      type: 'search',
      slug: '',
      live: false,
      q: disabledQ,
      auto: false,
      ts: Date.now(),
    }])
    render(<WorkspaceView league="Test League" visible={true} />)
    const wv = document.querySelector('webview')
    wv.getWebContentsId = () => 99

    // Initially all 3 stats are disabled in node.q, so Close enough is hidden.
    expect(screen.queryByRole('button', { name: 'Close enough' })).toBeNull()

    // User ticks all 3 mods inside the embedded trade window and runs a search (0 results).
    const tickedQuery = {
      status: { option: 'securable' },
      stats: [{
        type: 'and',
        filters: [
          { id: 'explicit.stat_life', value: { min: 100 } },
          { id: 'explicit.stat_fire', value: { min: 40 } },
          { id: 'explicit.stat_cold', value: { min: 40 } },
        ],
      }],
      filters: { type_filters: { filters: { category: { option: 'armour.chest' } } } },
    }
    act(() => {
      tapHandler?.({
        kind: 'search',
        wcId: 99,
        league: 'Test League',
        id: 'S_TICKED',
        total: 0,
        ids: [],
        body: { query: tickedQuery, sort: { price: 'asc' } },
      })
    })

    // Close enough should immediately appear (highlighted because total === 0) and relax the 3 ticked mods.
    const chip = await screen.findByRole('button', { name: 'Close enough' })
    expect(chip.className).toContain('act')
    fireEvent.click(chip)
    await waitFor(() => expect(screen.getByText('Relaxed')).toBeTruthy())
    expect(window.poe2desktop.trade.relax.mock.calls[0][0].query.stats[0].value.min).toBe(2)

    // C5: If a saved search had its slug updated before Relax, Exact remounts the latest slug from store.
    act(() => { useWorkspace.getState().setField('h_disabled', { slug: 'CAPTURED_NEW_SLUG' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Exact' }))
    await waitFor(() => {
      expect(screen.queryByText('Relaxed')).toBeNull()
      expect(document.querySelector('webview').getAttribute('src')).toContain('CAPTURED_NEW_SLUG')
    })
  })

  it('the trade window\'s address is recomputed on a reload (↻), from the saved row', () => {
    seedTree('s1')
    const { unmount } = render(<WorkspaceView league="Test League" visible />)
    const first = document.querySelector('webview')
    expect(first.getAttribute('src')).toContain('orig-slug')
    act(() => useWorkspace.getState().setField('s1', { slug: 'replacement' }))
    expect(document.querySelector('webview')).toBe(first)
    expect(first.getAttribute('src')).toContain('orig-slug')
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    const second = document.querySelector('webview')
    expect(second).not.toBe(first)
    expect(second.getAttribute('src')).toContain('replacement')
    unmount()
    expect(document.querySelector('webview')).toBeNull()
  })

  it('surfaces rate/auth relax errors via toast and stays silent on cancelled', async () => {
    const events = []
    const off = bus.on((t) => events.push(t))
    try {
      seedTree('h1')
      render(<WorkspaceView league="Test League" visible={true} />)

      window.poe2desktop.trade.relax = vi.fn(async () => ({ ok: false, error: 'rate' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Close enough' }))
      await waitFor(() => expect(events.length).toBe(1))
      expect(events[0].ok).toBe(false)
      expect(events[0].text).toMatch(/rate limited/i)

      window.poe2desktop.trade.relax = vi.fn(async () => ({ ok: false, error: 'auth' }))
      fireEvent.click(screen.getByRole('button', { name: 'Close enough' }))
      await waitFor(() => expect(events.length).toBe(2))
      expect(events[1].text).toMatch(/connect your poe session/i)

      window.poe2desktop.trade.relax = vi.fn(async () => ({ ok: false, error: 'cancelled' }))
      fireEvent.click(screen.getByRole('button', { name: 'Close enough' }))
      await new Promise(r => { setTimeout(r, 20) })
      expect(events.length).toBe(2)
    } finally {
      off()
    }
  })

  it('refuses to overwrite a ?q= node with an empty slug after a /login -> /oauth bounce and replays the query once', async () => {
    const rareQ = JSON.stringify(EE2_RARE_QUERY)
    seedTree('q_node', [{
      id: 'q_node',
      kind: 'search',
      name: 'Merchant Floor Check',
      type: 'search',
      slug: '',
      live: false,
      q: rareQ,
      auto: false,
    }])
    const { rerender, unmount } = render(<WorkspaceView league="Test League" visible={true} />)
    const wv = document.querySelector('webview')
    wv.getWebContentsId = () => 101
    const origSrc = wv.getAttribute('src')
    expect(origSrc).toContain('?q=')
    rerender(<WorkspaceView league="Test League" visible={true} />)
    expect(document.querySelector('webview')).toBe(wv)

    // Simulate GGG sign-in redirect stripping ?q= and landing on an empty-search slug.
    act(() => {
      navHandler?.({ wcId: 101, phase: 'nav', url: 'https://www.pathofexile.com/login' })
      navHandler?.({ wcId: 101, phase: 'nav', url: 'https://www.pathofexile.com/oauth/authorize?client_id=trade' })
      navHandler?.({ wcId: 101, phase: 'nav', url: 'https://www.pathofexile.com/trade2/search/poe2/Test%20League/EMPTY_AUTH_SLUG' })
    })

    await waitFor(() => {
      const node = useWorkspace.getState().nodeById('q_node')
      expect(node.slug).toBe('')
      expect(node.q).toBe(rareQ)
      expect(document.querySelector('webview').getAttribute('src')).toBe(origSrc)
    })

    // Once the replayed ?q= URL lands cleanly on a real slug (no new auth bounce), it captures normally.
    const replayedWv = document.querySelector('webview')
    replayedWv.getWebContentsId = () => 102
    act(() => {
      navHandler?.({ wcId: 102, phase: 'nav', url: 'https://www.pathofexile.com/trade2/search/poe2/Test%20League/REAL_QUERY_SLUG' })
    })
    expect(useWorkspace.getState().nodeById('q_node').slug).toBe('REAL_QUERY_SLUG')
    unmount()
    expect(document.querySelector('webview')).toBeNull()
  })

  it('never leaks an idle rare row baseQueryRef when switching to an ineligible Unique or a different Rare before TAP fires', async () => {
    const secondRareQ = JSON.stringify({
      query: {
        status: { option: 'securable' },
        stats: [{
          type: 'and',
          filters: [
            { id: 'explicit.stat_es', value: { min: 200 } },
            { id: 'explicit.stat_int', value: { min: 40 } },
            { id: 'explicit.stat_spirit', value: { min: 50 } },
          ],
        }],
        filters: { type_filters: { filters: { category: { option: 'armour.chest' } } } },
      },
      sort: { price: 'asc' },
    })
    seedTree('h1', [{
      id: 'h3',
      kind: 'search',
      name: 'Woe Mantle',
      type: 'search',
      slug: '',
      live: false,
      q: secondRareQ,
      auto: false,
      ts: Date.now(),
    }])

    render(<WorkspaceView league="Test League" visible={true} />)
    // Start idle on EE2 rare h1 (never clicked Close enough, no TAP search emitted).
    expect(await screen.findByRole('button', { name: 'Close enough' })).toBeTruthy()

    // Switch to ineligible Unique h2 -> Close enough chip must disappear immediately (not kept alive by stale baseQueryRef).
    act(() => { useWorkspace.getState().setActive('h2') })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Close enough' })).toBeNull()
    })

    // Switch back to h1 (idle), then directly to distinct Rare h3 -> clicking Close enough must relax h3's stats, never h1's.
    act(() => { useWorkspace.getState().setActive('h1') })
    expect(await screen.findByRole('button', { name: 'Close enough' })).toBeTruthy()
    act(() => { useWorkspace.getState().setActive('h3') })
    fireEvent.click(await screen.findByRole('button', { name: 'Close enough' }))
    await waitFor(() => expect(window.poe2desktop.trade.relax).toHaveBeenCalledTimes(1))
    const sentIds = window.poe2desktop.trade.relax.mock.calls[0][0].query.stats[0].filters.map(f => f.id)
    expect(sentIds).toEqual(['explicit.stat_es', 'explicit.stat_int', 'explicit.stat_spirit'])
  })

  it('keeps the new saved row and webview address when a late fetch belongs to the old relaxed page', async () => {
    const newMods = ['explicit.stat_armour', 'explicit.stat_spirit', 'explicit.stat_accuracy']
    const body = structuredClone(EE2_RARE_QUERY)
    body.query.stats[0].filters = newMods.map(id => ({ id, value: { min: 10 } }))
    seedTree('s1', [{ id: 's2', kind: 'search', name: 'New rare', q: JSON.stringify(body) }])
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getWebContentsId')
    Object.defineProperty(HTMLElement.prototype, 'getWebContentsId', { configurable: true, value: () => 71 })
    try {
      const { rerender, unmount } = render(<WorkspaceView league="Test League" visible />)
      fireEvent.click(await screen.findByRole('button', { name: 'Close enough' }))
      await screen.findByText('Relaxed')
      const guest = () => document.querySelector('webview')
      const previous = JSON.parse(new URL(guest().getAttribute('src')).searchParams.get('q'))
      expect(previous.query.status.option).toBe('securable')
      act(() => tapHandler({ kind: 'search', wcId: 71, id: 'late', league: 'Test League', body: previous, ids: [] }))
      fireEvent.click(screen.getByRole('button', { name: 'Exact' }))
      act(() => useWorkspace.getState().setActive('s2'))
      const selected = guest()
      const address = selected.getAttribute('src')
      expect(JSON.parse(new URL(address).searchParams.get('q')).query).toEqual(body.query)
      rerender(<WorkspaceView league="Test League" visible />)
      act(() => tapHandler({ kind: 'fetch', wcId: 71, searchId: 'late', rows: [] }))
      expect(guest()).toBe(selected)
      expect(selected.getAttribute('src')).toBe(address)
      expect(window.poe2desktop.trade.relax).toHaveBeenCalledTimes(1)
      fireEvent.click(await screen.findByRole('button', { name: 'Close enough' }))
      await waitFor(() => expect(window.poe2desktop.trade.relax).toHaveBeenCalledTimes(2))
      const sent = window.poe2desktop.trade.relax.mock.calls[1][0].query
      expect(sent.stats[0].filters.map(f => f.id)).toEqual(newMods)
      expect(sent.status.option).toBe('securable')
      unmount()
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, 'getWebContentsId', descriptor)
      else Reflect.deleteProperty(HTMLElement.prototype, 'getWebContentsId')
    }
  })

  it('shows a clickable Connect PoE account button when trade.relax fails with auth on an already-connected session and immediately re-runs relax after reconnecting', async () => {
    const { useStatus } = await import('../../src/lib/statusStore.js')
    installApiMock({
      '/api/status': {
        league: 'Test League',
        reference: 'exalted',
        session: { connected: true },
        oauth: { logged_in: false, username: null },
      },
      '/api/strategy/calc': {
        calc: null,
        prices: { divine: 1, chaos: 0.09, vaal: 0.012, exalted: 0.0015 },
        uses: [],
      },
    })
    useStatus.setState({
      status: {
        league: 'Test League',
        reference: 'exalted',
        session: { connected: true },
        oauth: { logged_in: false, username: null },
      },
    })
    window.poe2desktop.connectSession = vi.fn(async () => ({ ok: true, message: 'Connected' }))
    window.poe2desktop.trade.relax = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'auth', status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        searchId: 'RX_AUTH_OK',
        total: 9,
        rows: [{ id: 'r1', amount: 15, currency: 'chaos' }],
      })

    seedTree('h1')
    render(<WorkspaceView league="Test League" visible={true} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Close enough' }))
    const connectBtn = await screen.findByRole('button', { name: /connect poe account/i })
    expect(connectBtn).toBeTruthy()

    fireEvent.click(connectBtn)
    await waitFor(() => expect(screen.getByText('Relaxed')).toBeTruthy())
    expect(window.poe2desktop.connectSession).toHaveBeenCalledTimes(1)
    expect(window.poe2desktop.trade.relax).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: /connect poe account/i })).toBeNull()
  })
})

