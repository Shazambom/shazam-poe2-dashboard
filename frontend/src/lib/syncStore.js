import { create } from 'zustand'

// The ONE app-wide live-refresh control, surfaced only in the topbar. Replaces the per-view
// auto-refresh toggles that used to live in the Board ("auto 60s") and Arbitrage/Routes ("keep
// fresh 2min"). `auto` is a persisted global preference; each live view keeps its OWN cadence
// (Board 60s, Routes 120s) but gates it on this flag. The manual topbar ⟳ bumps `tick`, which the
// currently-mounted live view watches to refresh what you're looking at now. `busy` lets the active
// view drive the ⟳ spinner. Only one live view is mounted at a time, so there's no cross-talk.
const KEY = 'app.autolive.v1'

export const useSync = create((set, get) => ({
  auto: (() => { try { return localStorage.getItem(KEY) === '1' } catch { return false } })(),
  tick: 0,          // bumped by the topbar ⟳ — active live view refreshes on change
  busy: false,      // active view sets this while refreshing → topbar ⟳ spins

  setAuto: (v) => {
    try { localStorage.setItem(KEY, v ? '1' : '0') } catch {}
    set({ auto: !!v })
  },
  requestRefresh: () => set((s) => ({ tick: s.tick + 1 })),
  setBusy: (b) => set({ busy: !!b }),
}))
