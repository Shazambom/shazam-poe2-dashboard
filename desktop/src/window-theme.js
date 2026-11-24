// Window backdrop colour for the chosen UI theme (presets mirror --backdrop in styles.css; a custom theme
// brings its own hex).
'use strict'
const { ignored } = require('./ignored.js')

const BACKDROPS = {   // painted before the CSS loads
  vault: '#191b22', ash: '#331f24', divinity: '#e9d2ae', sekhemas: '#101012', vaal: '#160d0c', azmeri: '#2f3640',
}
const BACKDROP_HEX = /^#[0-9a-f]{6}$/i

/** @param {{ theme?: string, customBackdrop?: string }} s */
const windowBackdrop = (s) => (s.theme === 'custom' && BACKDROP_HEX.test(s.customBackdrop || '') ? s.customBackdrop : BACKDROPS[s.theme] || BACKDROPS.vault)

/**
 * Validates a theme request, persists it via `save(patch)`, and recolours `win`.
 * @param {unknown} id
 * @param {unknown} backdrop
 * @param {(patch: Record<string, string>) => boolean} save
 * @param {{ isDestroyed(): boolean, setBackgroundColor(color: string): void } | null} win
 */
function applyWindowTheme(id, backdrop, save, win) {
  if (typeof id !== 'string') return false
  /** @type {Record<string, string>} */
  const patch = { theme: id }
  if (id === 'custom') {
    if (!BACKDROP_HEX.test(String(backdrop || ''))) return false
    patch.customBackdrop = String(backdrop).toLowerCase()
  } else if (!BACKDROPS[id]) return false
  if (!save(patch)) return false
  try { if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackdrop(patch)) } catch (e) { ignored('window:backdrop', e) }
  return true
}

module.exports = { windowBackdrop, applyWindowTheme }
