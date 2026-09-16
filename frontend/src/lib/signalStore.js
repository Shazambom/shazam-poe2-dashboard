import { create } from 'zustand'
import { api } from './api.js'

// Market SIGNALS inbox — the Phase-4 'what's about to move' feed. Deliberately SEPARATE from the
// live trade-ping store (pingStore): these are server-computed, PERSISTENT (dismissals live
// server-side in signals_ack) and economy-wide, not ephemeral live-search hits tied to the Trading
// tab. /api/signals is the source of truth; this store just mirrors the last poll. `unseen` = the
// un-dismissed count that badges the Divine orb. Indexed byName because NAME is the join key with
// CardDetail (whose rows carry a currency id, not the numeric item_id the signal carries).
export const useSignals = create((set, get) => ({
  signals: [],       // [{item_id, name, t, mp_dist, vol_z, close, acked}]
  league: null,
  unseen: 0,
  loaded: false,
  byName: {},        // name -> signal (CardDetail's 'why it fired' lookup)

  refresh: async () => {
    try {
      const d = await api.signals()
      const signals = d.signals || []
      set({
        signals, league: d.league ?? null,
        unseen: d.unseen ?? signals.filter(s => !s.acked).length,
        byName: Object.fromEntries(signals.map(s => [s.name, s])),
        loaded: true,
      })
    } catch { /* down sidecar/endpoint → just keep the last state; never throw into the UI */ }
  },
  ack: async (keys) => { try { await api.ackSignals(keys, false) } finally { await get().refresh() } },
  ackAll: async () => { try { await api.ackSignals(null, true) } finally { await get().refresh() } },
}))

// sig identity used for dismissals — must match backend signalsack.sig_key ("item_id:t").
export const sigKey = (s) => `${s.item_id}:${s.t}`
