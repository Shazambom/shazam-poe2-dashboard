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
  searchStates: {},       // search node id -> { state: live|auth|reconnecting|error, message }

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
  setSearchState: ({ itemId, state, message }) =>
    set(s => ({ searchStates: { ...s.searchStates, [itemId]: { state, message } } })),
  clearSearchState: (itemId) => set(s => { const n = { ...s.searchStates }; delete n[itemId]; return { searchStates: n } }),

  newest: () => get().pings[0] || null,
}))

// The Live toggle's label for a search node, from its persisted `armed` flag and the engine's
// last reported state for it. Pure, so the mapping is testable without React.
export function liveLabel(node, st) {
  if (!node.armed) return { text: 'Go live', title: '' }
  switch (st?.state) {
    case 'live': return { text: 'Live ●', title: 'Connected' }
    case 'auth': return { text: 'Reconnect session', title: st.message || 'Reconnect your PoE session' }
    case 'reconnecting': return { text: 'Reconnecting…', title: st.message || '' }
    case 'error': return { text: 'Error', title: st.message || '' }
    default: return { text: 'Live …', title: 'Connecting' }
  }
}
