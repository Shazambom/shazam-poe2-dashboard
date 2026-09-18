// Theme presets — a colour choice and nothing else. A preset is a `:root[data-theme="x"]` block in
// styles.css that re-assigns the same tokens; picking one sets that attribute on <html>. Three
// tiers hold the choice: the settings blob (truth, user data), localStorage (read before first
// paint so the app never flashes the default theme), and the desktop shell (the pre-CSS window
// backdrop, via poe2desktop.setTheme). Nothing here touches layout, components or copy.
import { create } from 'zustand'
import { useStatus, onSettingsTheme } from './statusStore.js'

export const THEMES = [
  { id: 'vault', name: 'Vault' },
  { id: 'ash', name: 'Arbiter of Ash' },
  { id: 'divinity', name: 'Arbiter of Divinity' },
  { id: 'sekhemas', name: 'Trial of the Sekhemas' },
  { id: 'vaal', name: 'Vaal' },
]
export const DEFAULT_THEME = 'vault'
const KEY = 'arbiter.theme.v1'
const valid = (id) => (THEMES.some(t => t.id === id) ? id : DEFAULT_THEME)

// Paint the theme on <html>. The default theme is the bare :root, so it carries no attribute.
export function paintTheme(id) {
  const t = valid(id)
  if (t === DEFAULT_THEME) delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
  try { localStorage.setItem(KEY, t) } catch {}
  try { window.poe2desktop?.setTheme?.(t) } catch {}
  return t
}

// Before first render: the last-used theme from localStorage (the settings blob reconciles later).
export function bootTheme() {
  let t = DEFAULT_THEME
  try { t = valid(localStorage.getItem(KEY) || DEFAULT_THEME) } catch {}
  return paintTheme(t)
}

export const useTheme = create((set) => ({
  id: DEFAULT_THEME,
  // The user picked a theme: paint it now, persist it as a setting.
  apply: (id) => {
    const t = paintTheme(id)
    set({ id: t })
    useStatus.getState().saveSettings({ theme: t }).catch(() => {})
  },
  // Settings arrived (boot / another device): the blob wins over the localStorage mirror.
  sync: (id) => { if (!id) return; const t = paintTheme(id); set({ id: t }) },
}))

onSettingsTheme((id) => useTheme.getState().sync(id))
