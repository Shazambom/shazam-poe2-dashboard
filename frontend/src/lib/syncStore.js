import { create } from 'zustand'

// The ONE app-wide refresh control, surfaced only in the topbar. The manual ⟳ bumps `tick`, which
// the mounted view watches to reload what you're looking at; `busy` lets that view drive the ⟳
// spinner. (There is no auto toggle: prices come from HOURLY data and each view already keeps
// itself current — Board every 30 s, Arbitrage every 2 min. See docs/market-data-sources.md.)

export const useSync = create((set) => ({
  tick: 0,          // bumped by the topbar ⟳ — the mounted view reloads on change
  busy: false,      // active view sets this while refreshing → topbar ⟳ spins

  requestRefresh: () => set((s) => ({ tick: s.tick + 1 })),
  setBusy: (b) => set({ busy: !!b }),
}))
