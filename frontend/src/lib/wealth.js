import { fmt } from './api.js'

// THE wealth-display rule. Under the hood every amount of wealth is kept in the reference
// currency (exalted by default) — that is the honest baseline for comparing worth. Large numbers
// stop meaning anything to a human, so at the DISPLAY layer an amount is re-denominated into the
// first tier it clears: ≥1,000,000 ex → mirrors, ≥1000 ex → divines, ≥100 ex → chaos, else the
// reference itself. A tier is cleared only once the amount is worth at least one of its currency
// (owner, 2026-10-12: net worth stays in divines until it exceeds a mirror's value).
// Prices (reference per unit) come from /api/status `wealth_prices`; a missing price falls through
// to the next tier, and a tier that IS the reference is a no-op. One table, one function —
// every "N ex" the UI shows goes through <Wealth> / wealthText.
export const WEALTH_TIERS = [['mirror', 1_000_000], ['divine', 1000], ['chaos', 100]]   // [unit, min reference amount], richest first

// The Stash's net worth on Auto (owner, 2026-10-12): [unit, min reference amount, min units of it].
// Exalted to 300, then chaos, divines from 5 divines' worth, mirrors from one mirror's worth.
export const STASH_TIERS = [['mirror', 0, 1], ['divine', 0, 5], ['chaos', 300, 1]]

export function wealthUnit(amount, ref, prices, tiers = WEALTH_TIERS) {
  if (amount == null || !Number.isFinite(Number(amount))) return null
  const a = Number(amount)
  const ex = ref !== 'exalted' && prices?.exalted > 0 ? prices.exalted : 1   // the lines are exalted amounts
  for (const [unit, min, units = 1] of tiers) {
    const px = unit === ref ? 1 : prices?.[unit]   // a tier that is the reference is still a tier
    if (px > 0 && Math.abs(a) >= min * ex && Math.abs(a) >= units * px) return { value: a / px, unit }
  }
  return { value: a, unit: ref }
}

// An amount of wealth in a given display unit — for figures shown side by side, which keep one scale
// (CLAUDE.md "Comparisons keep a common scale"): pass the unit the larger one takes (wealthUnit). No price
// for that unit: the usual rule.
export function wealthAs(amount, ref, prices, unit) {
  if (amount == null || !Number.isFinite(Number(amount))) return null
  if (unit === ref) return { value: Number(amount), unit }
  const px = prices?.[unit]
  return px > 0 ? { value: Number(amount) / px, unit } : wealthUnit(amount, ref, prices)
}

// The Stash's net worth unit: the currency the user chose (settings `stash_unit`, one of STASH_UNITS)
// when it has a price, else Auto: the wealth rule over the total with the Stash's own lines (STASH_TIERS).
export const STASH_UNITS = ['exalted', 'chaos', 'divine', 'hinekoras-lock', 'mirror']
export const stashUnit = (total, ref, prices, choice) =>
  STASH_UNITS.includes(choice) && (choice === ref || prices?.[choice] > 0) ? choice : wealthUnit(total, ref, prices, STASH_TIERS)?.unit

// The volume rule (CLAUDE.md): an amount native to a currency (a price in the market that trades
// the thing, a holding) shows in that currency, precisely. Only a native number too large to read
// (≥ NATIVE_MAX of its own unit, the tiers' own boundary) falls back to the wealth rule over its
// reference value, flagged `approx`. Without a reference value the native number stands.
export const NATIVE_MAX = 1000

export function nativeAmount(value, unit, valueRef, ref, prices) {
  if (value == null || !Number.isFinite(Number(value))) return null
  const v = Number(value)
  if (Math.abs(v) < NATIVE_MAX || valueRef == null) return { value: v, unit, approx: false }
  const w = wealthUnit(valueRef, ref, prices)
  return w && w.unit !== unit ? { ...w, approx: true } : { value: v, unit, approx: false }
}

// Digits scale with magnitude so 11.0 divine and 4,321 exalted both read naturally.
export const wealthDigits = (v) => (Math.abs(v) >= 100 ? 0 : 1)
// The number as shown: a fraction of one unit keeps three significant figures (0.525 mirror, never "0").
export const wealthNumber = (v, digits = null) => (v !== 0 && Math.abs(v) < 1 ? String(Number(Number(v).toPrecision(3))) : fmt.n(v, digits ?? wealthDigits(v)))
// The amount in `unit` when one is asked for, else in the tier it clears.
export const wealthShown = (amount, ref, prices, unit = null) => (unit ? wealthAs(amount, ref, prices, unit) : wealthUnit(amount, ref, prices))

// Tooltip / plain-text form: the display amount, plus the raw reference amount when converted.
export function wealthText(amount, ref, prices, unit = null) {
  const w = wealthShown(amount, ref, prices, unit)
  if (!w) return '–'
  const shown = `${wealthNumber(w.value)} ${w.unit}`
  return w.unit === ref ? shown : `${shown} (${fmt.n(amount, 0)} ${ref})`
}
