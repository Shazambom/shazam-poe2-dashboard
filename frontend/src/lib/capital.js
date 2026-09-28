// A Capital holding's sub-line by the volume rule (CLAUDE.md). Pure: CapitalCard renders it.
//   worth    — { amount, cur, ref }: the holding at its market's rate (server `native`); null for
//              cash, whose native amount is its own quantity (already in the quantity field)
//   cashout  — { amount, cur, ref }: what selling it all yields, in the cash currency the path ends
//              in (server `realizable_native`); only when it differs from paper (≥1% or partial)
//   ghostPct — all-in loss vs paper (slippage + gold + stranded), partial — the book can't take it all
//   noMarket — no tracked exchange market, so the cash-out can't be measured
// `ref` rides along for the display's approximation of a native number too large to read.
export function holdingLine(v) {
  if (!v || v.value_ref == null) return null
  const cash = v.native && v.native.cur === v.currency
  const worth = cash || !v.native ? null : { ...v.native, ref: v.value_ref }
  if (v.realizable_ref == null) return { worth, cashout: null, ghostPct: 0, partial: false, noMarket: true }
  const ghostPct = v.value_ref > 0 ? (v.value_ref - v.realizable_ref) / v.value_ref * 100 : 0
  const partial = v.full_fill === false
  const cashout = (partial || ghostPct >= 1) && v.realizable_native ? { ...v.realizable_native, ref: v.realizable_ref } : null
  return { worth, cashout, ghostPct, partial }
}
