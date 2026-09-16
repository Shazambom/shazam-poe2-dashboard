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

// Digits scale with magnitude so 11.0 divine and 4,321 exalted both read naturally.
export const wealthDigits = (v) => (Math.abs(v) >= 100 ? 0 : 1)

// Tooltip / plain-text form: the display amount, plus the raw reference amount when converted.
export function wealthText(amount, ref, prices) {
  const w = wealthUnit(amount, ref, prices)
  if (!w) return '–'
  const shown = `${fmt.n(w.value, wealthDigits(w.value))} ${w.unit}`
  return w.unit === ref ? shown : `${shown} (${fmt.n(amount, 0)} ${ref})`
}
