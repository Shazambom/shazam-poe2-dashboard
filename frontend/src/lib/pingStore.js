import { create } from 'zustand'

// Live-search pings surfaced to the user. Newest first; deduped by listingId so a burst
// doesn't machine-gun; ephemeral (never persisted). Both the VaalPingOrb and the
// most-recent-ping banner read from here — one source of truth ("one button for all
// watches"). Desktop-only source (window.poe2desktop.trade.onPing); dormant on web.
const MAX = 100

export const usePings = create((set, get) => ({
  pings: [],              // newest first
  seen: {},               // listingId -> true (kept small: last MAX)
  unseen: 0,
  engine: { active: 0, budgetMax: 20, rate: {} },
  states: {},             // pingId -> lifecycle state (set by PR6 machine hookups)

  addPing: (p) => {
    if (!p || !p.listingId) return
    const st = get()
    if (st.seen[p.listingId]) return                 // dedup
    const pings = [p, ...st.pings].slice(0, MAX)
    const seen = { ...st.seen, [p.listingId]: true }
    set({ pings, seen, unseen: st.unseen + 1 })
  },
  markSeen: () => set({ unseen: 0 }),
  remove: (pingId) => set(s => ({ pings: s.pings.filter(p => p.pingId !== pingId) })),
  clear: () => set({ pings: [], unseen: 0 }),
  setEngine: (e) => set({ engine: { ...get().engine, ...e } }),
  setState: (pingId, state) => set(s => ({ states: { ...s.states, [pingId]: state } })),

  newest: () => get().pings[0] || null,
}))
