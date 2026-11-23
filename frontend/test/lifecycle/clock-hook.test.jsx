import { it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import StratCalcView from '../../src/components/StratCalcView.jsx'
import { useStratStore } from '../../src/lib/stratStore.js'
import * as sc from '../../src/lib/stratcalc.js'
import { installApiMock } from './setup.js'

it('ticks each running strategy clock once a second and releases its intervals on pause and unmount', async () => {
  vi.useFakeTimers()
  try {
    const now = Date.now()
    const saved = sc.newStrat(sc.blankDoc(), { id: 's', name: 'Clock', now })
    installApiMock({ '/api/strategy/calc': { calc: saved, prices: { divine: 1 }, uses: [] } })
    useStratStore.getState().reset()
    const interval = vi.spyOn(globalThis, 'setInterval')
    const clear = vi.spyOn(globalThis, 'clearInterval')
    const { rerender, unmount } = render(<StratCalcView league="A" />)
    await act(async () => {})
    const timers = () => interval.mock.calls.flatMap(([, delay], i) => delay === 1000 ? [interval.mock.results[i].value] : [])
    expect(timers()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Start', exact: true }))
    const running = timers()
    expect(running).toHaveLength(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    expect(screen.getByTitle('Edit time').textContent).toBe(sc.clock(2000))
    const timeBox = screen.getByTitle('Edit time')
    fireEvent.click(timeBox)
    const draft = document.querySelector('.scalc-clock-in')
    fireEvent.change(draft, { target: { value: '1h22m' } })
    rerender(<StratCalcView league="A" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(draft.value).toBe('1h22m')
    expect(timers()).toEqual(running)
    fireEvent.keyDown(draft, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Pause', exact: true }))
    for (const id of running) expect(clear).toHaveBeenCalledWith(id)
    const paused = screen.getByTitle('Edit time').textContent
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(screen.getByTitle('Edit time').textContent).toBe(paused)
    fireEvent.click(screen.getByRole('button', { name: 'Resume', exact: true }))
    const resumed = timers().slice(running.length)
    expect(resumed).toHaveLength(2)
    unmount()
    for (const id of resumed) expect(clear).toHaveBeenCalledWith(id)
    await useStratStore.getState().flush()
  } finally {
    vi.useRealTimers()
  }
})
