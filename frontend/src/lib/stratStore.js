// Shared Zustand store for Stash → Strat Calculator + Client.txt auto-timer lifecycle.
// Lifting the strat document out of StratCalcView lets background Client.txt events
// pause/resume the active strat's timer and count maps even when another tab is open,
// persisting through the shared debounced autosave controller.
import { ignoredError } from './ignoredError.js'
import { useEffect } from 'react'
import { create } from 'zustand'
import { api, cleanErr, toast } from './api.js'
import { createAutosave } from './autosave.js'
import { registerFlush, isQuitting } from './quitFlush.js'
import { RETRY_MS, sleep, withRetry } from './retry.js'
import { SNAP } from './dests.js'
import { uid } from './session.js'
import * as sc from './stratcalc.js'
import {
  applyClientLogEvent,
  createAutoTimerState,
  noteManualPause,
  noteManualResume,
} from './stratAutoTimer.js'

const newId = (kind) => `${kind}_${uid()}`

const pendingEvents = []   // Client.txt events received before the strat doc hydrated
let loadPromise = null
let inFlight = 0
let retrying = false
let retryGen = 0
let lastError = null   // the newest save failure, shown once the bounded retries give up

function scheduleRetry(getState) {
  const token = ++retryGen
  const stop = () => token !== retryGen || isQuitting()
  ;(async () => {
    await sleep(RETRY_MS[0])
    if (stop()) return
    await withRetry(async () => {
      if (stop()) return
      const doc = getState().doc
      if (!doc || SNAP || getState().saveState !== 'error') return
      retrying = true
      try {
        autosave.save(doc)
        if (!(await autosave.flush())) throw new Error('strat retry failed')
      } finally {
        retrying = false
      }
    }, { delays: RETRY_MS.slice(1), stop })
  })().catch(() => { if (!stop()) toast(cleanErr(lastError), false) })
}

function makeAutosave(setState, getState) {
  const ctrl = createAutosave(
    (calc) => {
      if (SNAP) return Promise.resolve()
      inFlight++
      return Promise.resolve(api.putStratCalc(calc)).finally(() => { inFlight-- })
    },
    700,
    {
      register: false,
      onState: (next) => setState(s => {
        if (retrying && (next === 'saving' || next === '')) return s
        return { saveState: typeof next === 'function' ? next(s.saveState) : next }
      }),
      onError: (e) => {
        lastError = e
        setState({ saveState: 'error' })
        if (retrying) return
        // A failure the retry may still fix says nothing yet; the toast comes only when every retry failed.
        if (isQuitting()) toast(cleanErr(e), false)
        else scheduleRetry(getState)
      },
    },
  )
  ctrl.mount()
  return ctrl
}

let autosave = null

export const useStratStore = create((set, get) => {
  autosave = makeAutosave(set, get)

  return {
    doc: null,
    prices: {},
    uses: [],
    saveState: '',
    autoTimer: createAutoTimerState(),
    watching: false,

    setPrices: (prices) => set({ prices: prices || {} }),
    setWatching: (watching) => set({ watching: !!watching }),

    ensureStrat: () => {
      const cur = get().doc
      if (!cur || cur.strats.length) return
      set({ doc: sc.newStrat(cur, { id: newId('s'), name: sc.nextName(cur), now: Date.now() }) })
    },

    hydrate: (rawCalc, { createIfEmpty = false, prices, uses } = {}) => {
      if (get().doc) {
        const patch = {}
        if (prices !== undefined) patch.prices = prices || {}
        if (uses !== undefined) patch.uses = uses || []
        if (Object.keys(patch).length) set(patch)
        if (createIfEmpty) get().ensureStrat()
        return get().doc
      }
      let doc = sc.normalize(rawCalc)
      if (createIfEmpty && !doc.strats.length) {
        doc = sc.newStrat(doc, { id: newId('s'), name: sc.nextName(doc), now: Date.now() })
      }
      if (!SNAP) autosave.arm()
      let autoTimer = get().autoTimer
      let changed = false
      const queued = pendingEvents.splice(0)
      for (const { ev, now } of queued) {
        const res = applyClientLogEvent(autoTimer, ev, doc, now)
        autoTimer = res.state
        if (res.doc !== doc) { doc = res.doc; changed = true }
      }
      const nextState = { doc, autoTimer }
      if (prices !== undefined) nextState.prices = prices || {}
      if (uses !== undefined) nextState.uses = uses || []
      set(nextState)
      if (changed && !SNAP) { retryGen++; autosave.save(doc) }
      return doc
    },

    load: ({ createIfEmpty = false } = {}) => {
      if (get().doc) {
        if (createIfEmpty) get().ensureStrat()
        return Promise.resolve(get().doc)
      }
      if (loadPromise) {
        return loadPromise.then(() => {
          if (createIfEmpty) get().ensureStrat()
          return get().doc
        })
      }
      loadPromise = api.stratCalc().then(d => (
        get().hydrate(d.calc, { createIfEmpty, prices: d.prices || {}, uses: d.uses || [] })
      )).catch(() => {
        pendingEvents.length = 0
        return null
      }).finally(() => {
        loadPromise = null
      })
      return loadPromise
    },

    change: (fn) => {
      const cur = get().doc
      if (!cur) return
      const next = fn(cur)
      if (next !== cur) {
        set({ doc: next })
        if (!SNAP) { retryGen++; autosave.save(next) }
      }
    },

    applyClientLog: (ev, now = Date.now()) => {
      if (!ev || typeof ev !== 'object') return
      if (!get().watching) set({ watching: true })
      const cur = get().doc
      if (!cur) {
        pendingEvents.push({ ev, now })
        get().load({ createIfEmpty: false })
        return
      }
      const res = applyClientLogEvent(get().autoTimer, ev, cur, now)
      if (res.doc !== cur) {
        set({ doc: res.doc, autoTimer: res.state })
        if (!SNAP) { retryGen++; autosave.save(res.doc) }
      } else if (res.state !== get().autoTimer) {
        set({ autoTimer: res.state })
      }
    },

    noteManualPause: () => set(s => ({ autoTimer: noteManualPause(s.autoTimer) })),
    noteManualResume: () => set(s => ({ autoTimer: noteManualResume(s.autoTimer) })),

    flush: () => {
      retryGen++
      if (!inFlight && get().saveState === 'error') get().resave()
      return autosave.flush()
    },
    // Queue the current document for saving again (a failed write leaves nothing pending); flush() sends it.
    resave: () => {
      const doc = get().doc
      if (doc && !SNAP) autosave.save(doc)
    },

    reset: () => {
      retryGen++
      inFlight = 0
      retrying = false
      autosave.discard()
      autosave.unmount()
      autosave = makeAutosave(set, get)
      pendingEvents.length = 0
      loadPromise = null
      set({
        doc: null,
        prices: {},
        uses: [],
        saveState: '',
        autoTimer: createAutoTimerState(),
        watching: false,
      })
    },
  }
})

registerFlush(() => useStratStore.getState().flush(), { onHide: true })

// Mounted once in App beside useEe2History: subscribes to main's Client.txt events and
// feeds the shared stratStore even while the user is on Board, Stash, or Trading.
// Inert in `?snap=1` mode and on non-desktop web builds.
export function useStratAutoTimer() {
  useEffect(() => {
    if (SNAP) return
    const clientLog = typeof window !== 'undefined' ? window.poe2desktop?.clientLog : null
    if (!clientLog?.onEvent) return
    let live = true
    clientLog.status?.().then(st => {
      if (live) useStratStore.getState().setWatching(!!st?.watching)
    }).catch(() => ignoredError('read client log status'))
    const offStatus = clientLog.onStatus?.(st => {
      if (live) useStratStore.getState().setWatching(!!st?.watching)
    })
    const off = clientLog.onEvent(ev => {
      useStratStore.getState().applyClientLog(ev, Date.now())
    })
    return () => {
      live = false
      offStatus?.()
      off?.()
    }
  }, [])
}
