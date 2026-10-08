// Yield as a tier badge (owner, 2026-10-08: "players know what a tier list is"). A loop's yield (velocity: profit per
// hour per 1k gold) is placed among the loops on screen by its share of the best one: S from TIER_SHARES.S up, then
// A, B, and C below. Relative to the list shown, so there is always an S; the ranking still sorts on the real value.
export const TIER_SHARES = { S: 0.8, A: 0.5, B: 0.2 }

const tierOf = (share) => (share >= TIER_SHARES.S ? 'S' : share >= TIER_SHARES.A ? 'A' : share >= TIER_SHARES.B ? 'B' : 'C')

// `yields`: one per row; Infinity = free gold (always S); null/undefined = unknown (no tier).
export function yieldTiers(yields) {
  const known = yields.filter(v => v != null && Number.isFinite(v))
  if (!known.length) return yields.map(v => (v === Infinity ? 'S' : null))
  const best = Math.max(...known), worst = Math.min(...known)
  // A list that is negative throughout still runs from its best to its worst: share is the distance from the worst.
  const share = best > 0 ? (v) => Math.max(0, v / best) : (v) => (best === worst ? 1 : (v - worst) / (best - worst))
  return yields.map(v => (v === Infinity ? 'S' : v == null || !Number.isFinite(v) ? null : tierOf(share(v))))
}
