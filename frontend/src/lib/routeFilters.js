// The Arbitrage filter form ⇄ the `filters` block of the user's settings (user.sqlite). The form
// shows an unset threshold as a blank box; the backend stores "off" as 0.
export const DEFAULT_FILTERS = {
  min_margin_pct: 0.5, min_margin_ref: 0, max_gold: '', min_margin_per_1k_gold: '',
  min_liquidity_ref: '', min_volume_ref_per_h: '', max_fill_hours: '', max_step_minutes: '', min_velocity: '', exclude_recipes: false, limit: 100, start: '',
}
// Thresholds whose "off" the form shows as a blank box rather than a 0.
const BLANK_WHEN_OFF = ['max_gold', 'min_margin_per_1k_gold', 'min_liquidity_ref', 'min_volume_ref_per_h', 'max_fill_hours', 'max_step_minutes', 'min_velocity']
const NUMERIC = ['min_margin_pct', 'min_margin_ref', ...BLANK_WHEN_OFF]

export function filtersFromSettings(saved = {}) {
  const form = { ...DEFAULT_FILTERS }
  for (const k of Object.keys(DEFAULT_FILTERS)) if (saved[k] !== undefined) form[k] = saved[k]
  for (const k of BLANK_WHEN_OFF) if (!form[k]) form[k] = ''
  return form
}

export function filtersToSave(form) {
  const out = {}
  for (const k of NUMERIC) out[k] = Number(form[k]) || 0
  out.exclude_recipes = !!form.exclude_recipes
  out.limit = Number(form.limit) || DEFAULT_FILTERS.limit
  out.start = form.start ? String(form.start) : ''
  return out
}

// The route search's query: exactly what the form shows (a cleared box as 0 = off, never a blank for
// the server to fill from the saved settings). The server ranks and cuts its list at `limit`; the view
// re-sorts and bands that pool, then shows `form.limit` rows, so the pool is never below the default.
export function streamQuery(form) {
  const q = filtersToSave(form)
  return { ...q, limit: Math.max(DEFAULT_FILTERS.limit, q.limit) }
}
