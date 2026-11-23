import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { installApiMock } from './setup.js'
import BoardView from '../../src/components/BoardView.jsx'
import Cur from '../../src/components/Cur.jsx'
import { loadIcons } from '../../src/lib/icons.js'

describe('Board, CardDetail, and Cur icon lifecycles', () => {
  beforeEach(async () => {
    installApiMock()
    await loadIcons()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads board cards, renders icons, and opens CardDetail on card click', async () => {
    const { calls } = installApiMock()
    const onOpen = vi.fn()
    render(<BoardView onOpen={onOpen} />)

    await waitFor(() => {
      expect(screen.getAllByText('Divine Orb').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('Chaos Orb').length).toBeGreaterThanOrEqual(1)
    })

    // Currency images rendered with real src URLs
    const imgs = document.querySelectorAll('img.cur-img')
    expect(imgs.length).toBeGreaterThanOrEqual(2)
    expect(Array.from(imgs).every(img => img.getAttribute('src')?.startsWith('https://'))).toBe(true)

    // Clicking a card invokes onOpen (or opens detail inside BoardView)
    const divineEl = screen.getAllByText('Divine Orb')[0]
    fireEvent.click(divineEl.closest('.card, button, [role="button"]') || divineEl)
    await waitFor(() => {
      const openedModal = document.querySelector('.modal, .detail-modal, .card-detail')
      expect(onOpen.mock.calls.length > 0 || Boolean(openedModal) || calls.some(c => c.path === '/api/asset')).toBe(true)
    })
  })

  it('isolates broken icon retry epochs so healthy Cur icons never remount on a sibling 404', () => {
    vi.useFakeTimers()
    const { unmount } = render(
      <div>
        <Cur id="divine" size={18} />
        <Cur id="chaos" size={18} />
      </div>
    )

    const imgs = document.querySelectorAll('img.cur-img')
    expect(imgs.length).toBe(2)
    const divineImg = imgs[0]
    const chaosImg = imgs[1]

    // Mark only Chaos Orb image as broken; Cur hides broken img until retry epoch bumps
    fireEvent.error(chaosImg)
    expect(document.querySelectorAll('img.cur-img').length).toBe(1)
    expect(document.querySelectorAll('img.cur-img')[0]).toBe(divineImg)

    // Advance past the shared 5s icon retry timer
    act(() => { vi.advanceTimersByTime(5100) })

    // Healthy Divine Orb img MUST still be the exact same DOM node (not remounted)
    const afterImgs = document.querySelectorAll('img.cur-img')
    expect(afterImgs.length).toBe(2)
    expect(afterImgs[0]).toBe(divineImg)
    // Broken Chaos Orb retried and mounted a fresh img element
    expect(afterImgs[1]).not.toBe(chaosImg)
    fireEvent.error(afterImgs[1])
    unmount()
    act(() => { vi.advanceTimersByTime(20000) })
    expect(document.querySelectorAll('img.cur-img')).toHaveLength(0)
  })
})
