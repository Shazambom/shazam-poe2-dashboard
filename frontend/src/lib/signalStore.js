import { create } from 'zustand'
import { api } from './api.js'

// Market SIGNALS inbox — the Phase-4 'what's about to move' feed. Deliberately SEPARATE from the
// live trade-ping store (pingStore): these are server-computed, PERSISTENT (dismissals live
// server-side in signals_ack) and economy-wide, not ephemeral live-search hits tied to the Trading
// tab. /api/signals is the source of truth; this store just mirrors the last poll. `unseen` = the
// un-dismissed count that badges the Divine orb. Indexed byName because NAME is the join key with
// CardDetail (whose rows carry a currency id, not the numeric item_id the signal carries).
// Un-acked signals in `next` whose identity (item + spike day) was not in `prev` — the "something
// changed" that earns a ping. Pure, so the rule is testable without React or a network.
export function newSignals(prev, next) {
  const seen = new Set(prev.map(sigKey))
  return next.filter(s => !s.acked && !seen.has(sigKey(s)))
}

export const useSignals = create((set, get) => ({
  signals: [],       // [{item_id, name, t, mp_dist, vol_z, close, acked}]
  league: null,
  unseen: 0,
  loaded: false,
  byName: {},        // name -> signal (CardDetail's 'why it fired' lookup)
  lastNew: null,     // { at, signals } — set when a poll finds NEW un-acked signals (App pings on it)

  refresh: async () => {
    try {
      const d = await api.signals()
      const signals = d.signals || []
      const prev = get()
      // Only a CHANGE pings: the first load establishes the state (the orb still lights up).
      const fresh = prev.loaded ? newSignals(prev.signals, signals) : []
      set({
        signals, league: d.league ?? null,
        unseen: d.unseen ?? signals.filter(s => !s.acked).length,
        byName: Object.fromEntries(signals.map(s => [s.name, s])),
        loaded: true,
        ...(fresh.length ? { lastNew: { at: Date.now(), signals: fresh } } : {}),
      })
    } catch { /* down sidecar/endpoint → just keep the last state; never throw into the UI */ }
  },
  ack: async (keys) => { try { await api.ackSignals(keys, false) } finally { await get().refresh() } },
  ackAll: async () => { try { await api.ackSignals(null, true) } finally { await get().refresh() } },
}))

// sig identity used for dismissals — must match backend signalsack.sig_key ("item_id:t").
export const sigKey = (s) => `${s.item_id}:${s.t}`

// The recurring inbox poll (the sidecar recomputes signals in the background; this is how the UI
// notices). Also re-polls when the window comes back to the foreground. Returns the stop fn.
export function startSignalPolling(ms = 60000) {
  const refresh = () => useSignals.getState().refresh()
  refresh()
  const t = setInterval(refresh, ms)
  const onVis = () => { if (document.visibilityState === 'visible') refresh() }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
  return () => { clearInterval(t); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis) }
}
