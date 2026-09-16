import { create } from 'zustand'

// The ONE app-wide time horizon (lookback window). Every view that used to carry its own
// 24h/3d/7d/14d or 1d/3d/7d picker now reads this — Board %/spark, Movers, Hold, and the shared
// CardDetail/asset modal. Persisted to localStorage so it survives sessions (a pure UI preference,
// no backend round-trip). League-day-indexed views (Inflation, Market cap, cross-league, pair
// history) are EXEMPT — they don't take a lookback window.
const KEY = 'app.horizon.v1'
export const HORIZONS = [['24h', 24], ['3d', 72], ['7d', 168], ['14d', 336]]
const HOURS = HORIZONS.map(([, h]) => h)

const load = () => {
  const n = Number(localStorage.getItem(KEY))
  return HOURS.includes(n) ? n : 24
}

export const useHorizon = create((set) => ({
  hours: load(),
  setHours: (h) => {
    if (!HOURS.includes(h)) return
    try { localStorage.setItem(KEY, String(h)) } catch {}
    set({ hours: h })
  },
}))
