// Arbitrage presets (settings.ARBITRAGE_PRESETS, served by /api/arbitrage/presets). A pick saves the preset's
// values as ordinary settings; the picked preset is never stored — it is whichever preset the saved values equal,
// so editing any number deselects it. Pure, so the rule is testable.

// True when every value the preset carries is what `settings` holds (nested objects compared key by key).
function holds(settings, values) {
  return Object.entries(values).every(([k, v]) => (v && typeof v === 'object'
    ? settings?.[k] && typeof settings[k] === 'object' && holds(settings[k], v)
    : settings?.[k] === v))
}

export const activePreset = (presets, settings) =>
  (settings && presets.find(p => holds(settings, p.values))?.id) || null
