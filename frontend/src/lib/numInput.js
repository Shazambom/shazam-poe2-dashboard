// The exact-number box's rule (components/Num.jsx). Pure.

// What a keystroke applies: the whole number typed when it lies in [min, max], else null (wait).
// A cleared or out-of-range box mid-edit must not snap, or the next digit lands on the snapped value.
export function typed(raw, min, max) {
  if (String(raw).trim() === '') return null
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n >= min && n <= max ? n : null
}

// What the box settles to when it loses focus: clamped to the range; blank or garbage is the minimum.
export function settle(raw, min, max) {
  if (String(raw).trim() === '') return min
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min
}
