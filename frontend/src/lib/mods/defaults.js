// The Mods tab's settings shape, persisted under `mods_tools` in the settings blob
// (user.sqlite). `merge` folds a stored partial over these and clamps, so a stale or damaged
// blob never reaches the view.
export const defaults = Object.freeze({ poolId: 'ring', ilvl: 82, floor: 0, tags: [] })

const int = (v, lo, hi, dflt) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && v !== null && v !== '' ? Math.max(lo, Math.min(hi, n)) : dflt
}

export function merge(stored) {
  const s = stored && typeof stored === 'object' ? stored : {}
  return {
    poolId: typeof s.poolId === 'string' && s.poolId ? s.poolId : defaults.poolId,
    ilvl: int(s.ilvl, 1, 100, defaults.ilvl),
    floor: int(s.floor, 0, 100, defaults.floor),
    tags: Array.isArray(s.tags) ? [...new Set(s.tags.filter(t => typeof t === 'string'))] : [],
  }
}
