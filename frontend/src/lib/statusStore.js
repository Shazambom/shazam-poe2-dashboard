import { create } from 'zustand'
import { api } from './api.js'
import { nextPollMs } from './capital.js'
import { restoreFailedEdits } from './stash.js'

// The ONE poll of the app-level status: /api/status + /api/capital every 30s (started by App),
// the rate budget, and the saved settings. Views that used to poll /api/session, /api/oauth/status
// or fetch /api/settings on their own read this store; writes to settings go through saveSettings
// so the cached copy never goes stale. `refresh()` is what a view calls after it changed something.
let settingsQueue = Promise.resolve()   // settings writes, serialised (saveSettings)
let capitalQueue = Promise.resolve()    // holdings writes, serialised across mounts (saveCapital)
let failedCounted = new Set()           // recount currencies from a rejected PUT, carried into the next queued PUT
let failedEdits = new Map()             // unsaved edits from a rejected PUT superseded by another queued PUT
// Unsaved Stash edits shared across mounts so an unmount mid-fetch or a failed unmount PUT is never lost.
export const capitalDirty = new Map()

export const useStatus = create((set, get) => ({
  status: null,      // /api/status (league, digest/orderbook feed states, session, oauth, …)
  capital: null,     // /api/capital
  rl: null,          // /api/ratelimits (trade budget for the topbar cluster)
  settings: null,    // /api/settings (the saved user settings)

  capitalSaving: false,   // a holdings write is in flight (the Stash re-reads holdings only after it lands)
  capitalWrites: 0,       // bumped by every holdings write: a poll that started before one never overwrites it
  capitalCreditRev: 0,    // bumped when a sales credit updates holdings (reconciles any mounted Stash editor)
  salesFetching: false,   // true while any Stash sales fetch is in flight (holds edits across remounts)
  capitalStale: false,    // true after a confirmed credit whose capital reload failed (blocks stale re-seeding)
  refresh: async () => {
    const writes = get().capitalWrites
    try {
      const [s, c] = await Promise.all([api.status(), api.capital()])
      set(get().capitalWrites === writes ? { status: s, capital: c, capitalStale: false } : { status: s })
    } catch (e) { console.error(e) }
    api.rateLimits().then(rl => set({ rl })).catch(() => {})
  },
  loadSettings: async () => {
    const s = await api.settings()
    set({ settings: s })
    syncTheme?.(s.theme, s.custom_themes)
    return s
  },
  // The one holdings write: PUT /api/capital, serialised so a flush on unmount cannot overtake a newer write
  // or race a sales fetch on a fresh mount. `counted`: currencies whose total the user typed.
  saveCapital: (entries, counted = [], edits = null) => {
    const prev = capitalQueue
    const run = prev.catch(() => {}).then(async () => {
      const sendCounted = failedCounted.size ? [...new Set([...failedCounted, ...counted])] : counted
      failedCounted.clear()
      const pendingEdits = edits?.size ? restoreFailedEdits(failedEdits, edits) : new Map(failedEdits)
      failedEdits.clear()
      try {
        const c = await api.putCapital(entries, sendCounted)
        set(st => ({ capital: c, capitalWrites: st.capitalWrites + 1, capitalStale: false }))
        return c
      } catch (e) {
        for (const cur of sendCounted) failedCounted.add(cur)
        if (pendingEdits.size) {
          if (capitalQueue === run) {
            const restored = restoreFailedEdits(pendingEdits, capitalDirty)
            capitalDirty.clear()
            for (const [k, v] of restored) capitalDirty.set(k, v)
          } else {
            for (const [k, v] of pendingEdits) failedEdits.set(k, v)
          }
        }
        throw e
      } finally {
        if (capitalQueue === run) set({ capitalSaving: false })
      }
    })
    capitalQueue = run
    set(st => ({ capitalSaving: true, capitalWrites: st.capitalWrites + 1 }))
    return run
  },
  waitCapital: () => {
    const q = capitalQueue
    return q.then(() => true, () => {
      if (capitalQueue === q) capitalQueue = Promise.resolve()
      return false
    })
  },
  // One at a time, in the order made: a later save always lands last (an Arbitrage preset after a pending edit).
  saveSettings: (patch) => {
    const run = settingsQueue.then(() => api.putSettings(patch))
    settingsQueue = run.catch(() => {})
    return run.then(s => { set({ settings: s }); return s })
  },
}))

// themeStore registers this so a loaded settings blob paints its theme (no import cycle).
let syncTheme = null
export const onSettingsTheme = (fn) => { syncTheme = fn }

// The settings blob, fetched once and then served from the store (kept fresh by saveSettings).
export const ensureSettings = () => {
  const st = useStatus.getState()
  return st.settings ? Promise.resolve(st.settings) : st.loadSettings()
}

// Start the 30s status poll (every few seconds while Capital is syncing, lib/capital.js
// nextPollMs); returns the stop function (App owns the lifetime).
export function startStatusPolling(ms = 30000) {
  let t = null, stopped = false
  const tick = async () => {
    await useStatus.getState().refresh()
    if (!stopped) t = setTimeout(tick, nextPollMs(useStatus.getState().capital, ms))
  }
  tick()
  ensureSettings().catch(() => {})
  return () => { stopped = true; clearTimeout(t) }
}
