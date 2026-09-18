// Themes — a colour choice and nothing else. A PRESET is a `:root[data-theme="x"]` block in styles.css
// that re-assigns the same tokens; picking one sets that attribute on <html>. A CUSTOM theme (built in
// Settings → Appearance) is the same token table as user data: painted as `data-theme="custom"` plus one
// inline custom property per token on <html>, so every var(--x) in CSS and theme.js follows it. Three
// tiers hold the choice: the settings blob (truth, user data — `theme` + `custom_themes`), localStorage
// (the id, and the active custom table, read before first paint so the app never flashes the default),
// and the desktop shell (the pre-CSS window backdrop, via poe2desktop.setTheme). Nothing here touches
// layout, components or copy.
import { create } from 'zustand'
import { useStatus, onSettingsTheme } from './statusStore.js'
import { TOKEN_KEYS, isCustomId, validTable, sanitizeTable } from './themeDerive.js'

export const THEMES = [
  { id: 'vault', name: 'Vault' },
  { id: 'ash', name: 'Arbiter of Ash' },
  { id: 'divinity', name: 'Arbiter of Divinity' },
  { id: 'sekhemas', name: 'Trial of the Sekhemas' },
  { id: 'vaal', name: 'Vaal' },
]
export const DEFAULT_THEME = 'vault'
const KEY = 'arbiter.theme.v1'
const CUSTOM_KEY = 'arbiter.theme.custom.v1'   // { id, colors } of the ACTIVE custom theme, for bootTheme()
const isPreset = (id) => THEMES.some(t => t.id === id)

// The custom themes as the settings blob carries them: [{ id, name, base, colors }]. Malformed rows are dropped.
export const cleanCustoms = (list) => (Array.isArray(list) ? list : [])
  .filter(t => t && isCustomId(t.id) && validTable(t.colors))
  .map(t => ({ id: t.id, name: String(t.name || 'Custom'), base: t.base || null, colors: sanitizeTable(t.colors) }))

const html = () => document.documentElement
function paintTable(colors) {
  html().dataset.theme = 'custom'
  for (const k of TOKEN_KEYS) html().style.setProperty(k, colors[k])
}
function clearTable() {
  for (const k of TOKEN_KEYS) html().style.removeProperty(k)
}

// Paint a theme on <html>. A preset is an attribute (the default theme is the bare :root, so it carries
// none); a custom id needs its table (`colors`), else it falls back to the default. Returns the id painted.
export function paintTheme(id, colors = null) {
  const custom = isCustomId(id) && colors && validTable(colors)
  const t = custom ? id : (isPreset(id) ? id : DEFAULT_THEME)
  if (custom) paintTable(colors)
  else {
    clearTable()
    if (t === DEFAULT_THEME) delete html().dataset.theme
    else html().dataset.theme = t
  }
  try { localStorage.setItem(KEY, t) } catch {}
  try { if (custom) localStorage.setItem(CUSTOM_KEY, JSON.stringify({ id: t, colors })); else localStorage.removeItem(CUSTOM_KEY) } catch {}
  try { window.poe2desktop?.setTheme?.(custom ? 'custom' : t, custom ? colors['--backdrop'] : undefined) } catch {}
  return t
}

// Before first render: the last-used theme from localStorage (the settings blob reconciles later).
export function bootTheme() {
  let id = DEFAULT_THEME, colors = null
  try {
    id = localStorage.getItem(KEY) || DEFAULT_THEME
    if (isCustomId(id)) { const m = JSON.parse(localStorage.getItem(CUSTOM_KEY) || 'null'); colors = m && m.id === id ? m.colors : null }
  } catch {}
  return paintTheme(id, colors)
}

export const useTheme = create((set, get) => ({
  id: DEFAULT_THEME,
  customs: [],            // the user's custom themes, mirrored from settings.custom_themes
  previewing: false,      // the builder is painting an unsaved table over the chosen theme
  tableOf: (id) => get().customs.find(t => t.id === id)?.colors ?? null,
  // The user picked a theme: paint it now, persist it as a setting.
  apply: (id) => {
    const t = paintTheme(id, get().tableOf(id))
    set({ id: t, previewing: false })
    useStatus.getState().saveSettings({ theme: t }).catch(() => {})
  },
  // Settings arrived (boot / another device): the blob wins over the localStorage mirror.
  sync: (id, customs) => {
    if (Array.isArray(customs)) set({ customs: cleanCustoms(customs) })
    if (!id) return
    const t = paintTheme(id, get().tableOf(id))
    set({ id: t })
  },
  // The builder: replace the custom list (user data → settings), re-painting the chosen theme if it changed.
  saveCustoms: async (list) => {
    const customs = cleanCustoms(list)
    set({ customs })
    await useStatus.getState().saveSettings({ custom_themes: customs })
    const { id, previewing } = get()
    if (isCustomId(id) && !previewing) {
      const colors = customs.find(t => t.id === id)?.colors
      if (colors) paintTheme(id, colors)
      else get().apply(DEFAULT_THEME)   // the chosen theme was deleted
    }
  },
  // Live preview while editing (unsaved): paint the table, remember nothing. `endPreview` restores the choice.
  preview: (colors) => { if (validTable(colors)) { paintTable(colors); set({ previewing: true }) } },
  endPreview: () => { const { id, previewing } = get(); if (!previewing) return; set({ previewing: false }); paintTheme(id, get().tableOf(id)) },
}))

onSettingsTheme((id, customs) => useTheme.getState().sync(id, customs))
