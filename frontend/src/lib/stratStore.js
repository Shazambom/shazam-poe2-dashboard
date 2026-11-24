// Shared Zustand store for Stash → Strat Calculator + Client.txt auto-timer lifecycle.
// Lifting the strat document out of StratCalcView lets background Client.txt events
// pause/resume the active strat's timer and count maps even when another tab is open,
// persisting through the shared debounced autosave controller.
import { ignoredError } from './ignoredError.js'
import { useEffect } from 'react'
import { create } from 'zustand'
import { api, cleanErr, toast } from './api.js'
import { createAutosave } from './autosave.js'
import { registerFlush } from './quitFlush.js'
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

function makeAutosave(setState) {
  const ctrl = createAutosave(
    (calc) => (SNAP ? Promise.resolve() : api.putStratCalc(calc)),
    700,
    {
      register: false,
      onState: (next) => setState(s => ({ saveState: typeof next === 'function' ? next(s.saveState) : next })),
      onError: (e) => toast(cleanErr(e), false),
    },
  )
  ctrl.mount()
  return ctrl
}

let autosave = null

export const useStratStore = create((set, get) => {
  autosave = makeAutosave(set)

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
      if (changed && !SNAP) autosave.save(doc)
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
        if (!SNAP) autosave.save(next)
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
        if (!SNAP) autosave.save(res.doc)
      } else if (res.state !== get().autoTimer) {
        set({ autoTimer: res.state })
      }
    },

    noteManualPause: () => set(s => ({ autoTimer: noteManualPause(s.autoTimer) })),
    noteManualResume: () => set(s => ({ autoTimer: noteManualResume(s.autoTimer) })),

    flush: () => autosave.flush(),
    // Queue the current document for saving again (a failed write leaves nothing pending); flush() sends it.
    resave: () => {
      const doc = get().doc
      if (doc && !SNAP) autosave.save(doc)
    },

    reset: () => {
      autosave.discard()
      autosave.unmount()
      autosave = makeAutosave(set)
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

registerFlush(retry => {
  const store = useStratStore.getState()
  if (retry) store.resave()
  return store.flush()
}, { onHide: true })

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
