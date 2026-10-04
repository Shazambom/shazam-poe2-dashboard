import { fmt } from './api.js'

// THE wealth-display rule. Under the hood every amount of wealth is kept in the reference
// currency (exalted by default) — that is the honest baseline for comparing worth. Large numbers
// stop meaning anything to a human, so at the DISPLAY layer an amount is re-denominated into the
// first tier it clears: ≥1,000,000 ref → mirrors, ≥1000 ref → divines, ≥100 ref → chaos, else the
// reference itself.
// Prices (reference per unit) come from /api/status `wealth_prices`; a missing price falls through
// to the next tier, and a tier that IS the reference is a no-op. One table, one function —
// every "N ex" the UI shows goes through <Wealth> / wealthText.
export const WEALTH_TIERS = [['mirror', 1_000_000], ['divine', 1000], ['chaos', 100]]   // [unit, min reference amount], richest first

export function wealthUnit(amount, ref, prices) {
  if (amount == null || !Number.isFinite(Number(amount))) return null
  const a = Number(amount)
  for (const [unit, min] of WEALTH_TIERS) {
    if (unit === ref) continue
    const px = prices?.[unit]
    if (Math.abs(a) >= min && px > 0) return { value: a / px, unit }
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

// Tooltip / plain-text form: the display amount, plus the raw reference amount when converted.
export function wealthText(amount, ref, prices) {
  const w = wealthUnit(amount, ref, prices)
  if (!w) return '–'
  const shown = `${fmt.n(w.value, wealthDigits(w.value))} ${w.unit}`
  return w.unit === ref ? shown : `${shown} (${fmt.n(amount, 0)} ${ref})`
}
