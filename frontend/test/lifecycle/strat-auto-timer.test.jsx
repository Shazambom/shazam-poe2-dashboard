import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, waitFor, act } from '@testing-library/react'
import { installApiMock, DEFAULT_CURRENCIES } from './setup.js'
import StratCalcView from '../../src/components/StratCalcView.jsx'
import { useStratStore, useStratAutoTimer } from '../../src/lib/stratStore.js'
import { loadIcons } from '../../src/lib/icons.js'
import * as sc from '../../src/lib/stratcalc.js'

function BackgroundHost() {
  useStratAutoTimer()
  return <div data-testid="other-tab">Board</div>
}

function makeSavedCalc(overrides = {}) {
  let d = sc.blankDoc()
  d = sc.newStrat(d, { id: 's1', name: 'Breach Farm', now: 1000 })
  if (Object.keys(overrides).length) d = sc.edit(d, 's1', s => ({ ...s, ...overrides }), 1000)
  return d
}

describe('Client.txt auto-timer React lifecycle', () => {
  let emitLog
  let unsubscribed
  let watchingFlag

  beforeEach(async () => {
    unsubscribed = false
    watchingFlag = true
    emitLog = null
    useStratStore.getState().reset()
    window.poe2desktop.clientLog = {
      onEvent: vi.fn((cb) => {
        emitLog = cb
        return () => { unsubscribed = true }
      }),
      status: vi.fn(async () => ({ watching: watchingFlag })),
    }
    installApiMock()
    await loadIcons()
  })

  afterEach(() => {
    useStratStore.getState().reset()
    vi.useRealTimers()
  })

  it('updates and persists active strat on Client.txt events even while on another tab, then renders live state in StratCalcView', async () => {
    const saved = makeSavedCalc()
    const { calls } = installApiMock({
      '/api/strategy/calc': { calc: saved, prices: { divine: 1, exalted: 0.01, chaos: 0.05 }, uses: [] },
    })

    const host = render(<BackgroundHost />)
    await waitFor(() => {
      expect(window.poe2desktop.clientLog.onEvent).toHaveBeenCalledTimes(1)
      expect(useStratStore.getState().watching).toBe(true)
    })

    // Fire area-gen + combat zone while StratCalcView is NOT mounted
    act(() => {
      emitLog({ type: 'area-gen', level: 80, areaId: 'MapCrypt', seed: '424242', ts: 100 })
      emitLog({ type: 'zone', zone: 'Crypt', ts: 101 })
    })

    await waitFor(() => {
      const s = sc.activeStrat(useStratStore.getState().doc)
      expect(s).toBeTruthy()
      expect(s.maps.count).toBe(1)
      expect(sc.running(s.timer)).toBe(true)
    })

    // Flush or wait for autosave PUT
    await act(async () => {
      await useStratStore.getState().flush()
    })
    const puts = calls.filter(c => c.method === 'PUT' && c.path === '/api/strategy/calc')
    expect(puts.length).toBeGreaterThanOrEqual(1)
    expect(sc.activeStrat(puts[puts.length - 1].body.calc).maps.count).toBe(1)

    // Hideout pauses; re-entering same map resumes without incrementing count
    act(() => {
      emitLog({ type: 'zone', zone: 'Limestone Hideout', ts: 150 })
    })
    expect(sc.running(sc.activeStrat(useStratStore.getState().doc).timer)).toBe(false)

    act(() => {
      emitLog({ type: 'zone', zone: 'Crypt', ts: 170 })
    })
    expect(sc.running(sc.activeStrat(useStratStore.getState().doc).timer)).toBe(true)
    expect(sc.activeStrat(useStratStore.getState().doc).maps.count).toBe(1)

    // Mount StratCalcView -> shows updated count, running Pause button, and passive Auto cue
    const view = render(<StratCalcView league="Test League" currencies={DEFAULT_CURRENCIES} />)
    await waitFor(() => {
      expect(view.getByLabelText('Maps run').value).toBe('1')
      expect(view.getByRole('button', { name: 'Pause' })).toBeTruthy()
      expect(view.getByTitle('Auto-timer active (Client.txt)')).toBeTruthy()
    })

    // User manually clicks Pause inside map seed 424242 -> re-entering Crypt stays paused
    fireEvent.click(view.getByRole('button', { name: 'Pause' }))
    expect(sc.running(sc.activeStrat(useStratStore.getState().doc).timer)).toBe(false)

    act(() => {
      emitLog({ type: 'zone', zone: 'Limestone Hideout', ts: 200 })
      emitLog({ type: 'zone', zone: 'Crypt', ts: 210 })
    })
    expect(sc.running(sc.activeStrat(useStratStore.getState().doc).timer)).toBe(false)

    // Next distinct map seed resumes and counts +1
    act(() => {
      emitLog({ type: 'area-gen', level: 80, areaId: 'MapSavannah', seed: '999999', ts: 240 })
      emitLog({ type: 'zone', zone: 'Savannah', ts: 241 })
    })
    await waitFor(() => {
      expect(view.getByLabelText('Maps run').value).toBe('2')
      expect(sc.running(sc.activeStrat(useStratStore.getState().doc).timer)).toBe(true)
    })

    view.unmount()
    host.unmount()
    expect(unsubscribed).toBe(true)
  })

  it('hides passive Auto cue when Client.txt is not being watched', async () => {
    watchingFlag = false
    installApiMock({
      '/api/strategy/calc': { calc: makeSavedCalc(), prices: { divine: 1 }, uses: [] },
    })

    const host = render(<BackgroundHost />)
    const view = render(<StratCalcView league="Test League" currencies={DEFAULT_CURRENCIES} />)
    await waitFor(() => {
      expect(view.getByLabelText('Maps run')).toBeTruthy()
    })
    expect(view.queryByTitle('Auto-timer active (Client.txt)')).toBeNull()
    view.unmount()
    host.unmount()
  })

  it('deduplicates concurrent GET /api/strategy/calc between background Client.txt and StratCalcView mount, and preserves background updates across async file import', async () => {
    const saved = makeSavedCalc()
    let resolveCalc
    let getCalcCalls = 0
    installApiMock({
      'GET /api/strategy/calc': (rawUrl) => {
        if (rawUrl.includes('prices=1')) return { prices: { divine: 1 }, uses: [] }
        getCalcCalls += 1
        return new Promise((res) => {
          resolveCalc = () => res({ calc: saved, prices: { divine: 1 }, uses: [] })
        })
      },
    })

    const host = render(<BackgroundHost />)
    await waitFor(() => expect(window.poe2desktop.clientLog.onEvent).toHaveBeenCalledTimes(1))

    // Trigger lazy load from background Client.txt, then mount StratCalcView before GET settles.
    act(() => { emitLog({ type: 'area-gen', level: 80, areaId: 'MapCrypt', seed: '111', ts: 100 }) })
    const view = render(<StratCalcView league="Test League" currencies={DEFAULT_CURRENCIES} />)
    expect(getCalcCalls).toBe(1)

    await act(async () => { resolveCalc() })
    await waitFor(() => expect(view.getByLabelText('Maps run')).toBeTruthy())
    expect(getCalcCalls).toBe(1)

    // Start async file import, fire a background map entry before file.text() resolves -> both must survive!
    let resolveText
    const exportPayload = sc.exportStrats(makeSavedCalc(), 's1', 2000)
    const fakeFile = { text: () => new Promise(r => { resolveText = () => r(exportPayload) }) }
    const fileInput = view.container.querySelector('input[type="file"]')
    fireEvent.change(fileInput, { target: { files: [fakeFile] } })

    act(() => {
      emitLog({ type: 'area-gen', level: 80, areaId: 'MapCrypt', seed: '222', ts: 200 })
      emitLog({ type: 'zone', zone: 'Crypt', ts: 201 })
    })
    expect(sc.activeStrat(useStratStore.getState().doc).maps.count).toBe(1)

    await act(async () => { resolveText() })
    await waitFor(() => expect(useStratStore.getState().doc.strats.length).toBe(2))
    const orig = useStratStore.getState().doc.strats.find(s => s.id === 's1')
    expect(orig.maps.count).toBe(1)
    expect(sc.running(orig.timer)).toBe(true)

    view.unmount()
    host.unmount()
  })

  it('activates Auto cue when watcher starts late via onStatus or when a Client.txt event arrives after an initial watching:false status', async () => {
    watchingFlag = false
    let emitStatus = null
    window.poe2desktop.clientLog.onStatus = vi.fn((cb) => {
      emitStatus = cb
      return () => {}
    })
    installApiMock({
      '/api/strategy/calc': { calc: makeSavedCalc(), prices: { divine: 1 }, uses: [] },
    })

    const host = render(<BackgroundHost />)
    const view = render(<StratCalcView league="Test League" currencies={DEFAULT_CURRENCIES} />)
    await waitFor(() => expect(view.getByLabelText('Maps run')).toBeTruthy())
    expect(view.queryByTitle('Auto-timer active (Client.txt)')).toBeNull()

    // Late status notification flips watching true
    act(() => { emitStatus?.({ watching: true }) })
    await waitFor(() => expect(view.getByTitle('Auto-timer active (Client.txt)')).toBeTruthy())

    // Even if watching is false again, any incoming Client.txt event sets watching true
    act(() => { useStratStore.getState().setWatching(false) })
    expect(view.queryByTitle('Auto-timer active (Client.txt)')).toBeNull()
    act(() => { emitLog({ type: 'zone', zone: 'Crypt', ts: 500 }) })
    await waitFor(() => expect(view.getByTitle('Auto-timer active (Client.txt)')).toBeTruthy())

    view.unmount()
    host.unmount()
  })
})
