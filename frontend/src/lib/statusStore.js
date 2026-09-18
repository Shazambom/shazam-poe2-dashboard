import { create } from 'zustand'
import { api } from './api.js'

// The ONE poll of the app-level status: /api/status + /api/capital every 30s (started by App),
// the rate budget, and the saved settings. Views that used to poll /api/session, /api/oauth/status
// or fetch /api/settings on their own read this store; writes to settings go through saveSettings
// so the cached copy never goes stale. `refresh()` is what a view calls after it changed something.
export const useStatus = create((set, get) => ({
  status: null,      // /api/status (league, digest/orderbook feed states, session, oauth, …)
  capital: null,     // /api/capital
  rl: null,          // /api/ratelimits (trade budget for the topbar cluster)
  settings: null,    // /api/settings (the saved user settings)

  refresh: async () => {
    try {
      const [s, c] = await Promise.all([api.status(), api.capital()])
      set({ status: s, capital: c })
    } catch (e) { console.error(e) }
    api.rateLimits().then(rl => set({ rl })).catch(() => {})
  },
  loadSettings: async () => {
    const s = await api.settings()
    set({ settings: s })
    syncTheme?.(s.theme, s.custom_themes)
    return s
  },
  saveSettings: async (patch) => {
    const s = await api.putSettings(patch)
    set({ settings: s })
    return s
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

// Start the 30s status poll; returns the stop function (App owns the lifetime).
export function startStatusPolling(ms = 30000) {
  const st = useStatus.getState()
  st.refresh()
  ensureSettings().catch(() => {})
  const t = setInterval(() => useStatus.getState().refresh(), ms)
  return () => clearInterval(t)
}
