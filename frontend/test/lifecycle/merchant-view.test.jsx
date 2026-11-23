import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { installApiMock } from './setup.js'
import StashTab from '../../src/components/StashTab.jsx'
import MerchantView, { _resetMerchantCache } from '../../src/components/MerchantView.jsx'
import { useStatus } from '../../src/lib/statusStore.js'
import { useSync } from '../../src/lib/syncStore.js'
import { useWorkspace } from '../../src/lib/workspaceStore.js'
import { nav } from '../../src/lib/nav.js'
import { loadIcons } from '../../src/lib/icons.js'

const NOW = Date.now()
const DAY = 24 * 3600 * 1000
const isoAgoDays = (d) => new Date(NOW - d * DAY).toISOString()

describe('Stash → Merchant (MerchantView) lifecycle', () => {
  let origDesktop

  beforeEach(async () => {
    origDesktop = window.poe2desktop
    _resetMerchantCache()
    localStorage.clear()
    useSync.setState({ tick: 0 })
    const nowSec = Math.floor(NOW / 1000)
    installApiMock({
      '/api/inflation': {
        anchor: 'divine',
        currencies: [
          { id: 'exalted', points: [{ t: nowSec - 14 * 86400, v: 100 }, { t: nowSec, v: 130 }], current: 130 },
        ],
      },
      '/api/strategy/calc': {
        prices: { divine: 1, exalted: 0.01, chaos: 0.05 },
      },
    })
    await loadIcons()
    useStatus.setState({
      status: {
        league: 'Test League',
        reference: 'exalted',
        wealth_prices: { exalted: 1, divine: 100, chaos: 5 },
        oauth: { logged_in: true, username: 'OAuthShop#1234' },
      },
      settings: { league: 'Test League' },
    })
    useWorkspace.setState({ loaded: true, loadError: null, tree: [], activeId: null })
    window.poe2desktop = {
      ...origDesktop,
      merchant: {
        fetch: vi.fn(async () => ({
          ok: true,
          total: 3,
          truncated: false,
          remainingIds: 0,
          apiCapReached: false,
          sort: 'price_desc',
          fetchedAt: NOW,
          rows: [
            {
              id: 'a1',
              indexed: isoAgoDays(14),
              amount: 200,
              currency: 'exalted',
              name: 'Headhunter',
              typeLine: 'Heavy Belt',
              baseType: 'Heavy Belt',
              rarity: 'Unique',
              icon: null,
              ilvl: 82,
              note: '~b/o 200 exalted',
              stashName: 'Ange',
              item: { name: 'Headhunter', typeLine: 'Heavy Belt', rarity: 'Unique', frameType: 3, ilvl: 82 },
            },
            {
              id: 'a2',
              indexed: isoAgoDays(0.5),
              amount: 3,
              currency: 'divine',
              name: 'Bramble Finger',
              typeLine: 'Gold Ring',
              baseType: 'Gold Ring',
              rarity: 'Rare',
              icon: null,
              ilvl: 81,
              note: '~b/o 3 divine',
              stashName: 'Ange',
              item: { name: 'Bramble Finger', typeLine: 'Gold Ring', rarity: 'Rare', frameType: 2, ilvl: 81 },
            },
            {
              id: 'a3',
              indexed: isoAgoDays(7),
              amount: 1,
              currency: 'chaos',
              name: 'Worn Slippers',
              typeLine: 'Silk Slippers',
              baseType: 'Silk Slippers',
              rarity: 'Rare',
              icon: null,
              ilvl: 78,
              note: '~b/o 1 chaos',
              stashName: 'Dump',
              item: { name: 'Worn Slippers', typeLine: 'Silk Slippers', rarity: 'Rare', frameType: 2, ilvl: 78 },
            },
          ],
        })),
        priceCheck: vi.fn(async () => ({
          ok: true,
          total: 12,
          listings: [
            { amount: 150, currency: 'exalted' },
            { amount: 180, currency: 'exalted' },
          ],
        })),
        cancel: vi.fn(async () => ({ ok: true })),
      },
    }
  })

  afterEach(() => {
    window.poe2desktop = origDesktop
    _resetMerchantCache()
    localStorage.clear()
  })

  it('StashTab displays Stash | Merchant | Arbitrage | Strat Calculator and clicking Merchant auto-loads immediately with no Load shop button or selector', async () => {
    render(<StashTab league="Test League" capital={null} status={null} currencies={[]} />)
    const tabs = Array.from(document.querySelectorAll('.subtabs button')).map(b => b.textContent.trim())
    expect(tabs).toEqual(['Stash', 'Merchant', 'Arbitrage', 'Strat Calculator'])
    fireEvent.click(screen.getByRole('tab', { name: 'Merchant' }))
    expect(screen.queryByLabelText('PoE account name')).toBeNull()
    expect(screen.queryByRole('button', { name: /^load shop$/i })).toBeNull()
    await waitFor(() => expect(screen.getByText('Headhunter')).toBeTruthy())
  })

  it('auto-loads logged-in OAuth account on mount, refreshes on sync tick, and reuses cache across remounts without re-fetching', async () => {
    const first = render(<MerchantView league="Test League" />)
    expect(screen.queryByLabelText('PoE account name')).toBeNull()
    expect(screen.queryByRole('button', { name: /^load shop$/i })).toBeNull()

    await waitFor(() => expect(screen.getByText('Headhunter')).toBeTruthy())
    expect(window.poe2desktop.merchant.fetch).toHaveBeenCalledTimes(1)
    expect(window.poe2desktop.merchant.fetch).toHaveBeenCalledWith({
      league: 'Test League',
      account: 'OAuthShop#1234',
      sort: 'price_desc',
      more: false,
    })
    expect(document.querySelector('.merchant-summary')).toBeTruthy()
    expect(document.querySelector('.merchant-acct-chip')).toBeNull()

    // Top-bar ⟳ sync tick triggers manual shop refresh
    useSync.setState(s => ({ tick: s.tick + 1 }))
    await waitFor(() => expect(window.poe2desktop.merchant.fetch).toHaveBeenCalledTimes(2))
    first.unmount()

    // Remounting shows cached listings immediately without calling fetch again
    const second = render(<MerchantView league="Test League" />)
    expect(screen.getByText('Headhunter')).toBeTruthy()
    expect(window.poe2desktop.merchant.fetch).toHaveBeenCalledTimes(2)
    second.unmount()
  })

  it('filters verdicts, searches inline, copies Ange regex, runs inline floor check on Uniques, opens Rares in Workspace, and marks done with Undo', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const goTradingSpy = vi.spyOn(nav, 'goTrading')

    render(<MerchantView league="Test League" />)
    await waitFor(() => expect(screen.getByText('Headhunter')).toBeTruthy())

    // Currency-watch banner appears for exalted drop
    expect(screen.getByText(/dropped 23% vs Divine/i)).toBeTruthy()

    // Filter Reprice shows only Headhunter
    fireEvent.click(screen.getByRole('button', { name: /^Reprice \(1\)/i }))
    expect(screen.getByText('Headhunter')).toBeTruthy()
    expect(screen.queryByText('Bramble Finger')).toBeNull()

    // Inline Check runs merchant.priceCheck without navigating away
    fireEvent.click(screen.getByRole('button', { name: /check floor for headhunter/i }))
    await waitFor(() => expect(window.poe2desktop.merchant.priceCheck).toHaveBeenCalledTimes(1))
    expect(goTradingSpy).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText(/Floor/i)).toBeTruthy())

    // Find copies ^Headhunter$
    fireEvent.click(screen.getByRole('button', { name: /find headhunter in ange/i }))
    expect(writeText).toHaveBeenCalledWith('^Headhunter$')

    // Back to All -> inline search filters by stash tab name
    fireEvent.click(screen.getByRole('button', { name: /^All \(3\)/i }))
    fireEvent.change(screen.getByLabelText('Find in shop'), { target: { value: 'dump' } })
    expect(screen.getByText('Worn Slippers')).toBeTruthy()
    expect(screen.queryByText('Headhunter')).toBeNull()

    // Rare row opens Workspace directly
    fireEvent.click(screen.getByRole('button', { name: /open worn slippers in workspace/i }))
    expect(goTradingSpy).toHaveBeenCalledWith('workspace')
    expect(useWorkspace.getState().tree[0].name).toBe('Worn Slippers')

    // Toolbar Seg has 4 options (All, Reprice, Cut, Vendor), Find exposes data-cmd="merchant-find", and no account selector exists
    expect(document.querySelectorAll('.merchant-head .seg button').length).toBe(4)
    expect(document.querySelector('[data-cmd="merchant-find"]')).toBeTruthy()
    expect(document.querySelector('.merchant-acct-chip')).toBeNull()

    // Mark done hides item, Reset keeps inline Undo visible, and Undo restores the done state
    fireEvent.change(screen.getByLabelText('Find in shop'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /mark worn slippers done/i }))
    expect(screen.queryByText('Worn Slippers')).toBeNull()
    expect(screen.getByText(/1 done/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Reset$/i }))
    expect(screen.getByText('Worn Slippers')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Undo$/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Undo$/i }))
    expect(screen.queryByText('Worn Slippers')).toBeNull()
    expect(screen.getByText(/1 done/i)).toBeTruthy()
  })

  it('auto-loads with desktop PoE session without OAuth, prompts Connect when signed out, and shows Retry on fetch error', async () => {
    // Signed out: shows Connect PoE account CTA instead of any account input or Load button
    useStatus.setState({
      status: {
        league: 'Test League',
        reference: 'exalted',
        wealth_prices: { exalted: 1, divine: 100, chaos: 5 },
        oauth: { logged_in: false, username: null },
        session: { connected: false },
      },
      settings: { league: 'Test League' },
    })
    const signedOut = render(<MerchantView league="Test League" />)
    expect(screen.queryByLabelText('PoE account name')).toBeNull()
    expect(screen.queryByRole('button', { name: /^load shop$/i })).toBeNull()
    expect(screen.getByRole('button', { name: /connect poe account/i })).toBeTruthy()
    expect(window.poe2desktop.merchant.fetch).not.toHaveBeenCalled()
    signedOut.unmount()

    // Desktop session connected without OAuth: auto-loads omitting account param so main resolves session account
    useStatus.setState({
      status: {
        league: 'Test League',
        reference: 'exalted',
        wealth_prices: { exalted: 1, divine: 100, chaos: 5 },
        oauth: { logged_in: false, username: null },
        session: { connected: true },
      },
      settings: { league: 'Test League' },
    })
    const sessionView = render(<MerchantView league="Test League" />)
    await waitFor(() => expect(screen.getByText('Headhunter')).toBeTruthy())
    expect(window.poe2desktop.merchant.fetch).toHaveBeenCalledWith({
      league: 'Test League',
      sort: 'price_desc',
      more: false,
    })
    sessionView.unmount()

    // Error state exposes Retry without an upfront Load shop gate
    _resetMerchantCache()
    window.poe2desktop.merchant.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'rate' })
      .mockResolvedValueOnce({
        ok: true,
        account: 'Session#1',
        total: 1,
        truncated: false,
        remainingIds: 0,
        apiCapReached: false,
        sort: 'price_desc',
        fetchedAt: NOW,
        rows: [{
          id: 'r1',
          indexed: isoAgoDays(5),
          amount: 10,
          currency: 'chaos',
          name: 'Retry Belt',
          typeLine: 'Heavy Belt',
          baseType: 'Heavy Belt',
          rarity: 'Unique',
          icon: null,
          ilvl: 82,
          stashName: 'Ange',
          item: { name: 'Retry Belt', typeLine: 'Heavy Belt', rarity: 'Unique', frameType: 3, ilvl: 82 },
        }],
      })
    render(<MerchantView league="Test League" />)
    await waitFor(() => expect(screen.getByRole('button', { name: /^retry$/i })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^retry$/i }))
    await waitFor(() => expect(screen.getByText('Retry Belt')).toBeTruthy())
  })

  it('shows Load next 50 pagination, switches to Fetch oldest without cancelling, preserves page-2 done marks on partial refresh, and renders desktop-only notice on web', async () => {
    window.poe2desktop.merchant.fetch = vi.fn(async ({ sort, more }) => ({
      ok: true,
      account: 'OAuthShop#1234',
      total: 120,
      truncated: true,
      remainingIds: more ? 0 : 50,
      apiCapReached: !!more,
      sort,
      fetchedAt: NOW,
      cursorExpiresAt: NOW + 300_000,
      rows: sort === 'oldest'
        ? [{
            id: 'old1',
            indexed: isoAgoDays(20),
            amount: 10,
            currency: 'chaos',
            name: 'Ancient Relic',
            typeLine: 'Heavy Belt',
            baseType: 'Heavy Belt',
            rarity: 'Unique',
            icon: null,
            ilvl: 82,
            stashName: 'Ange',
            item: { name: 'Ancient Relic', typeLine: 'Heavy Belt', rarity: 'Unique', frameType: 3, ilvl: 82 },
          }]
        : [{
            id: more ? 'p2' : 'p1',
            indexed: isoAgoDays(10),
            amount: more ? 5 : 50,
            currency: 'divine',
            name: more ? 'Page Two Shield' : 'Page One Belt',
            typeLine: 'Heavy Belt',
            baseType: 'Heavy Belt',
            rarity: 'Unique',
            icon: null,
            ilvl: 82,
            stashName: 'Ange',
            item: { name: more ? 'Page Two Shield' : 'Page One Belt', typeLine: 'Heavy Belt', rarity: 'Unique', frameType: 3, ilvl: 82 },
          }],
    }))

    const { unmount } = render(<MerchantView league="Test League" />)
    await waitFor(() => expect(screen.getByText('Page One Belt')).toBeTruthy())
    expect(screen.getByText(/Showing 1 of 120 listings/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /load next 50/i }))
    await waitFor(() => expect(screen.getByText('Page Two Shield')).toBeTruthy())
    expect(window.poe2desktop.merchant.fetch).toHaveBeenLastCalledWith({
      league: 'Test League',
      account: 'OAuthShop#1234',
      sort: 'price_desc',
      more: true,
    })

    // Mark page-2 item done, then trigger a truncated page-1 refresh -> page-2 done mark must survive
    fireEvent.click(screen.getByRole('button', { name: /mark page two shield done/i }))
    expect(screen.getByText(/1 done/i)).toBeTruthy()
    useSync.setState(s => ({ tick: s.tick + 1 }))
    await waitFor(() => expect(window.poe2desktop.merchant.fetch).toHaveBeenCalledTimes(3))
    expect(screen.getByText(/1 done/i)).toBeTruthy()

    // Switch fetch order to oldest: must cancel only scope:'fetch' and render Ancient Relic
    window.poe2desktop.merchant.cancel.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /fetch oldest instead/i }))
    await waitFor(() => expect(screen.getByText('Ancient Relic')).toBeTruthy())
    expect(window.poe2desktop.merchant.fetch).toHaveBeenLastCalledWith({
      league: 'Test League',
      account: 'OAuthShop#1234',
      sort: 'oldest',
      more: false,
    })
    expect(window.poe2desktop.merchant.cancel).toHaveBeenCalledWith({ scope: 'fetch' })
    expect(window.poe2desktop.merchant.cancel).not.toHaveBeenCalledWith({ scope: 'all' })
    unmount()

    // Web mode notice
    window.poe2desktop = undefined
    render(<MerchantView league="Test League" />)
    expect(screen.getByText(/desktop-only/i)).toBeTruthy()
  })

  it('connects to shared subsystems: common-scale Ask, Economy -> Inflation, Rare relaxQuery fallback, Workspace search reuse, and local /api/sales comps', async () => {
    const nowSec = Math.floor(NOW / 1000)
    installApiMock({
      '/api/inflation': {
        anchor: 'divine',
        currencies: [
          { id: 'exalted', points: [{ t: nowSec - 14 * 86400, v: 100 }, { t: nowSec, v: 130 }], current: 130 },
        ],
      },
      '/api/strategy/calc': {
        prices: { divine: 1, exalted: 0.01, chaos: 0.05 },
      },
      '/api/sales': {
        rows: [
          {
            time: isoAgoDays(2),
            item_id: 's1',
            price: { amount: 240, currency: 'exalted' },
            item: { name: 'Headhunter', typeLine: 'Heavy Belt', rarity: 'Unique' },
          },
        ],
      },
    })

    // Seed Workspace with an existing saved search for Headhunter
    useWorkspace.setState({
      loaded: true,
      loadError: null,
      activeId: null,
      tree: [
        {
          id: 'ws-hh',
          kind: 'search',
          name: 'Headhunter',
          q: JSON.stringify({ query: { name: 'Headhunter', type: 'Heavy Belt' } }),
        },
      ],
    })

    // Add a Rare with matchedMods that returns 0 exact comps then 2 relaxed comps (with cheaper currency deeper)
    window.poe2desktop.merchant.fetch = vi.fn(async () => ({
      ok: true,
      total: 2,
      truncated: false,
      remainingIds: 0,
      apiCapReached: false,
      sort: 'price_desc',
      fetchedAt: NOW,
      rows: [
        {
          id: 'hh1',
          indexed: isoAgoDays(10),
          amount: 200,
          currency: 'exalted',
          name: 'Headhunter',
          typeLine: 'Heavy Belt',
          baseType: 'Heavy Belt',
          rarity: 'Unique',
          icon: null,
          ilvl: 82,
          note: '~b/o 200 exalted',
          stashName: 'Ange',
          item: { name: 'Headhunter', typeLine: 'Heavy Belt', rarity: 'Unique', frameType: 3, ilvl: 82 },
        },
        {
          id: 'rare1',
          indexed: isoAgoDays(5),
          amount: 3,
          currency: 'divine',
          name: 'Storm Coil',
          typeLine: 'Gold Ring',
          baseType: 'Gold Ring',
          rarity: 'Rare',
          icon: null,
          ilvl: 81,
          note: '~b/o 3 divine',
          stashName: 'Ange',
          matchedMods: {
            category: 'accessory.ring',
            mods: [
              { ids: ['explicit.stat_3299347043'], value: 80 },
              { ids: ['explicit.stat_3372524247'], value: 40 },
            ],
          },
          item: { name: 'Storm Coil', typeLine: 'Gold Ring', rarity: 'Rare', frameType: 2, ilvl: 81 },
        },
      ],
    }))

    window.poe2desktop.merchant.priceCheck = vi.fn()
      .mockResolvedValueOnce({ ok: true, total: 0, listings: [] })
      .mockResolvedValueOnce({
        ok: true,
        total: 8,
        listings: [
          { amount: 250, currency: 'exalted' },
          { amount: 30, currency: 'chaos' },
        ],
      })

    const goEconomySpy = vi.spyOn(nav, 'goEconomy')
    const goTradingSpy = vi.spyOn(nav, 'goTrading')

    render(<MerchantView league="Test League" />)
    await waitFor(() => expect(screen.getByText('Headhunter')).toBeTruthy())

    // Common-scale Ask column shows muted equivalent next to 200 ex (when shop is in divine)
    expect(document.querySelector('.merchant-ask-equiv')).toBeTruthy()

    // Currency Watch banner links directly to Economy -> Inflation
    fireEvent.click(screen.getByRole('button', { name: /inflation/i }))
    expect(goEconomySpy).toHaveBeenCalledWith('inflation')

    // Expanding Headhunter shows local /api/sales comp and focuses existing saved Workspace search without duplicating
    fireEvent.click(screen.getByText('Headhunter').closest('button'))
    await waitFor(() => expect(screen.getByText(/your sales history/i)).toBeTruthy())
    expect(screen.getByText(/240/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /open saved search/i }))
    expect(useWorkspace.getState().activeId).toBe('ws-hh')
    expect(useWorkspace.getState().tree.length).toBe(1)
    expect(goTradingSpy).toHaveBeenCalledWith('workspace')

    // Mod-filtered Rare checks inline, auto-relaxes when exact search returns 0 comps, and flags cheaper currency
    fireEvent.click(screen.getByRole('button', { name: /check floor for storm coil/i }))
    await waitFor(() => expect(window.poe2desktop.merchant.priceCheck).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText(/Close/i)).toBeTruthy())
    fireEvent.click(screen.getByText('Storm Coil').closest('button'))
    await waitFor(() => expect(screen.getByText(/Close-enough match/i)).toBeTruthy())
    const floorNote = document.querySelector('.merchant-floor-note')
    expect(floorNote?.textContent || '').toMatch(/Relaxed \d+\/\d+/)
    expect(floorNote?.textContent || '').not.toContain('[object Object]')
    expect(screen.getByText(/Cheaper in/i)).toBeTruthy()
  })

  it('invalidates session shop cache on disconnect or session switch so Account A listings never appear under Account B', async () => {
    let currentAccount = 'AccountA#1111'
    window.poe2desktop.merchant.fetch = vi.fn(async () => ({
      ok: true,
      account: currentAccount,
      total: 1,
      truncated: false,
      remainingIds: 0,
      apiCapReached: false,
      sort: 'price_desc',
      fetchedAt: NOW,
      rows: [{
        id: `row-${currentAccount}`,
        indexed: isoAgoDays(1),
        amount: 5,
        currency: 'divine',
        name: currentAccount === 'AccountA#1111' ? 'Account A Sword' : 'Account B Bow',
        typeLine: 'Heavy Belt',
        baseType: 'Heavy Belt',
        rarity: 'Unique',
        icon: null,
        ilvl: 82,
        stashName: 'Ange',
        item: { name: currentAccount === 'AccountA#1111' ? 'Account A Sword' : 'Account B Bow', typeLine: 'Heavy Belt', rarity: 'Unique', frameType: 3, ilvl: 82 },
      }],
    }))

    useStatus.setState({
      status: {
        league: 'Test League',
        reference: 'exalted',
        wealth_prices: { exalted: 1, divine: 100, chaos: 5 },
        oauth: { logged_in: false, username: null },
        session: { connected: true, set_at: 1000 },
      },
      settings: { league: 'Test League' },
    })

    const first = render(<MerchantView league="Test League" />)
    await waitFor(() => expect(screen.getByText('Account A Sword')).toBeTruthy())
    expect(window.poe2desktop.merchant.fetch).toHaveBeenCalledTimes(1)
    first.unmount()

    // Switch session (new set_at, e.g. via Settings -> Account disconnect + reconnect as Account B)
    currentAccount = 'AccountB#2222'
    useStatus.setState({
      status: {
        league: 'Test League',
        reference: 'exalted',
        wealth_prices: { exalted: 1, divine: 100, chaos: 5 },
        oauth: { logged_in: false, username: null },
        session: { connected: true, set_at: 2000 },
      },
      settings: { league: 'Test League' },
    })

    const second = render(<MerchantView league="Test League" />)
    await waitFor(() => expect(screen.getByText('Account B Bow')).toBeTruthy())
    expect(screen.queryByText('Account A Sword')).toBeNull()
    expect(window.poe2desktop.merchant.fetch).toHaveBeenCalledTimes(2)
    second.unmount()
  })

  it('preserves session-only resolved account and doneMap across unmount/remount cache hits', async () => {
    window.poe2desktop.merchant.fetch = vi.fn(async () => ({
      ok: true,
      account: 'SessionOnly#7777',
      total: 2,
      truncated: false,
      remainingIds: 0,
      apiCapReached: false,
      sort: 'price_desc',
      fetchedAt: NOW,
      rows: [
        {
          id: 's-item-1',
          indexed: isoAgoDays(7),
          amount: 10,
          currency: 'chaos',
          name: 'Session First Item',
          typeLine: 'Heavy Belt',
          baseType: 'Heavy Belt',
          rarity: 'Unique',
          icon: null,
          ilvl: 82,
          stashName: 'Ange',
          item: { name: 'Session First Item', typeLine: 'Heavy Belt', rarity: 'Unique', frameType: 3, ilvl: 82 },
        },
        {
          id: 's-item-2',
          indexed: isoAgoDays(7),
          amount: 20,
          currency: 'chaos',
          name: 'Session Second Item',
          typeLine: 'Heavy Belt',
          baseType: 'Heavy Belt',
          rarity: 'Unique',
          icon: null,
          ilvl: 82,
          stashName: 'Ange',
          item: { name: 'Session Second Item', typeLine: 'Heavy Belt', rarity: 'Unique', frameType: 3, ilvl: 82 },
        },
      ],
    }))

    useStatus.setState({
      status: {
        league: 'Test League',
        reference: 'exalted',
        wealth_prices: { exalted: 1, divine: 100, chaos: 5 },
        oauth: { logged_in: false, username: null },
        session: { connected: true, set_at: 1234 },
      },
      settings: { league: 'Test League' },
    })

    const first = render(<MerchantView league="Test League" />)
    await waitFor(() => expect(screen.getByText('Session First Item')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /mark session first item done/i }))
    expect(screen.queryByText('Session First Item')).toBeNull()
    expect(screen.getByText(/1 done/i)).toBeTruthy()
    first.unmount()

    // Remount hits shopCache (0 extra fetches) and must preserve doneKey + doneMap + write new done marks
    const second = render(<MerchantView league="Test League" />)
    expect(screen.queryByText('Session First Item')).toBeNull()
    expect(screen.getByText('Session Second Item')).toBeTruthy()
    expect(screen.getByText(/1 done/i)).toBeTruthy()
    expect(window.poe2desktop.merchant.fetch).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /mark session second item done/i }))
    expect(screen.getByText(/2 done/i)).toBeTruthy()
    const stored = JSON.parse(localStorage.getItem('arbiter:merchant-done:Test League|sessiononly#7777'))
    expect(Object.keys(stored).sort()).toEqual(['s-item-1', 's-item-2'])
    second.unmount()
  })

  it('shows Connect PoE account (not Retry) when an existing session fails with auth and immediately reloads after reconnecting', async () => {
    installApiMock({
      '/api/status': {
        league: 'Test League',
        reference: 'exalted',
        wealth_prices: { exalted: 1, divine: 100, chaos: 5 },
        session: { connected: true },
        oauth: { logged_in: false, username: null },
      },
      '/api/strategy/calc': { prices: { divine: 1, exalted: 0.01, chaos: 0.05 } },
    })
    useStatus.setState({
      status: {
        league: 'Test League',
        reference: 'exalted',
        wealth_prices: { exalted: 1, divine: 100, chaos: 5 },
        session: { connected: true },
        oauth: { logged_in: false, username: null },
      },
    })
    window.poe2desktop.connectSession = vi.fn(async () => ({ ok: true, message: 'Connected' }))
    window.poe2desktop.merchant.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'auth', status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        account: 'Reconnected#1234',
        total: 1,
        truncated: false,
        remainingIds: 0,
        apiCapReached: false,
        sort: 'price_desc',
        fetchedAt: NOW,
        rows: [{
          id: 'rc1',
          indexed: isoAgoDays(1),
          amount: 5,
          currency: 'divine',
          name: 'Fresh Ring',
          typeLine: 'Gold Ring',
          baseType: 'Gold Ring',
          rarity: 'Unique',
          icon: null,
          ilvl: 82,
          stashName: 'Ange',
          item: { name: 'Fresh Ring', typeLine: 'Gold Ring', rarity: 'Unique', frameType: 3, ilvl: 82 },
        }],
      })

    render(<MerchantView league="Test League" />)
    await waitFor(() => expect(screen.getByRole('button', { name: /connect poe account/i })).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^retry$/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /connect poe account/i }))
    await waitFor(() => expect(screen.getByText('Fresh Ring')).toBeTruthy())
    expect(window.poe2desktop.connectSession).toHaveBeenCalledTimes(1)
    expect(window.poe2desktop.merchant.fetch).toHaveBeenCalledTimes(2)
  })
})
